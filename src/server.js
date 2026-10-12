/**
 * An OpenAI-compatible HTTP front end for WorkBuddy and WorkBuddy AI.
 *
 * One process serves both products. Which product a request belongs to is
 * decided by the `x-workbuddy-variant` header, or by a `workbuddy/` /
 * `workbuddy-ai/` prefix on the model id -- so a client that can set headers and
 * one that cannot are both supported, and a single model list endpoint can
 * serve either.
 *
 * Endpoints:
 *
 *   GET  /v1/models                 list models for one variant or both
 *   GET  /v1/models/:id             one model
 *   POST /v1/chat/completions        chat; SSE when the client asked for it
 *   GET  /healthz                   liveness, plus per-variant sign-in state
 *
 * Why the non-streaming path exists at all: the upstream rejects
 * `stream: false` with HTTP 400 code 11101, so a client that wants a single
 * response gets one *by buffering the stream here*. The synthesized body is a
 * faithful merge of the chunks -- content, reasoning, tool calls, finish
 * reason, usage -- not a reduced one.
 *
 * @module oc-workbuddy-connect/server
 */

import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { normalizeTokenLimits, prepareChatBody, resolveUpstreamModelId } from './chat-body.js'
import { toOpenAIModels } from './catalog.js'
import { collectCompletion } from './sse.js'
import { WorkBuddySession } from './session.js'
import { extractDisplayErrorMessage } from './upstream.js'
import { AI_VARIANT, CN_VARIANT, variantFor } from './variants.js'

/** Largest request body accepted, so a runaway client cannot exhaust memory. */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** Variant-selection header. */
const VARIANT_HEADER = 'x-workbuddy-variant'

/** OpenAI error type per upstream failure class. */
const ERROR_TYPES = {
  hard_credit: 'insufficient_quota',
  soft_rate: 'rate_limit_error',
  session_dead: 'authentication_error',
  not_found: 'invalid_request_error',
  server: 'server_error',
  client: 'invalid_request_error',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendError(res, status, message, { type = 'invalid_request_error', code } = {}) {
  sendJson(res, status, { error: { message, type, ...code === undefined ? {} : { code } } })
}

/** Read a request body, refusing anything over the limit. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { tooLarge: true }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Constant-time bearer check, so a wrong key does not leak by timing. */
function authorized(req, apiKey) {
  if (apiKey === undefined || apiKey === '') return true
  const header = req.headers.authorization ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] ?? '')
  const a = Buffer.from(String(presented))
  const b = Buffer.from(apiKey)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Resolve a caller-supplied product selector, including the natural aliases. */
function resolveVariant(value) {
  const wanted = String(value).trim().toLowerCase()
  return variantFor(wanted)
    ?? (wanted === 'ai' || wanted === 'global' || wanted === 'intl' || wanted === 'international' ? AI_VARIANT : undefined)
    ?? (wanted === 'cn' || wanted === 'china' ? CN_VARIANT : undefined)
}

/**
 * The variant a request belongs to.
 *
 * Header first, then a `variant/` prefix on a `/v1/models/:id` path.
 * `undefined` means "not decided by the request": the chat handler still
 * decides from the model id in the body, and `/v1/models` reads it as "both".
 */
function variantForRequest(req, url) {
  const header = req.headers[VARIANT_HEADER]
  if (typeof header === 'string' && header.trim() !== '') {
    const resolved = resolveVariant(header)
    return resolved === undefined ? { unknown: header.trim() } : resolved
  }
  // `/v1/chat/completions` carries the id in the body, not the path, so the
  // path-based prefix only applies to `/v1/models/:id`.
  const match = /^\/v1\/models\/([^/]+)\/([^/]+)$/u.exec(url.pathname)
  return match === null ? undefined : resolveVariant(match[1])
}

/**
 * Start the bridge.
 *
 * @param {object} [options]
 * @param {string|number} [options.host] Bind address; loopback by default.
 * @param {number} [options.port] Listen port; `0` asks the OS for a free one.
 * @param {string} [options.apiKey] Require this bearer token when set.
 * @param {Array<object>} [options.variants] Variant descriptors to serve.
 * @returns {Promise<{server: import('node:http').Server, url: string, port: number, sessions: Map<string, WorkBuddySession>}>}
 */
export async function startServer(options = {}) {
  const host = options.host ?? '127.0.0.1'
  const port = Number(options.port ?? 8787)
  const apiKey = options.apiKey
  const variants = options.variants ?? [CN_VARIANT, AI_VARIANT]
  const sessions = new Map(variants.map(variant => [variant.id, new WorkBuddySession(variant)]))

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendError(res, 500, error instanceof Error ? error.message : String(error), { type: 'api_error' })
    })
  })

  // A malformed request gets a response, not a silent connection reset.
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
  })

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname.replace(/\/+$/u, '') || '/'

    if (!authorized(req, apiKey)) {
      sendError(res, 401, 'missing or incorrect bearer token', { type: 'authentication_error' })
      return
    }

    if (path === '/healthz' || path === '/health') {
      const health = {}
      for (const [id, session] of sessions) health[id] = await session.store.status()
      sendJson(res, 200, { status: 'ok', variants: health })
      return
    }

    const selection = variantForRequest(req, url)
    if (selection !== undefined && 'unknown' in selection) {
      sendError(res, 400, `unknown WorkBuddy variant ${JSON.stringify(selection.unknown)};`
        + ` expected one of ${[...sessions.keys()].join(', ')}`)
      return
    }

    if (path === '/v1/models' && req.method === 'GET') {
      await listModels(res, selection, sessions, url)
      return
    }
    if (path.startsWith('/v1/models/') && req.method === 'GET') {
      await getModel(res, selection, sessions, url)
      return
    }
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      await chatCompletions(req, res, selection, sessions)
      return
    }
    sendError(res, 404, `no route for ${req.method} ${path}`, { type: 'not_found_error' })
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  return { server, port: boundPort, url: `http://${host}:${boundPort}/v1`, sessions }
}

/**
 * The sessions a models request should answer from.
 *
 * Precedence: the path/header selection, then a `?variant=` query parameter,
 * then every product. Returns `[]` for an unrecognized `?variant=`, which the
 * caller reports as a bad request rather than silently answering with all of
 * them.
 */
function targetSessions(selection, sessions, url) {
  if (selection !== undefined) {
    const session = sessions.get(selection.id)
    return session === undefined ? [] : [session]
  }
  const wanted = url.searchParams.get('variant')
  if (wanted !== null) {
    const variant = resolveVariant(wanted)
    if (variant === undefined) return []
    const session = sessions.get(variant.id)
    return session === undefined ? [] : [session]
  }
  return [...sessions.values()]
}

async function listModels(res, selection, sessions, url) {
  const targets = targetSessions(selection, sessions, url)
  if (targets.length === 0) {
    sendError(res, 400, `unknown WorkBuddy variant ${JSON.stringify(url.searchParams.get('variant'))};`
      + ` expected one of ${[...sessions.keys()].join(', ')}`)
    return
  }
  const data = []
  for (const session of targets) {
    try {
      const { models } = await session.catalog()
      data.push(...toOpenAIModels(models, session.variant.id).data)
    } catch (error) {
      // A variant that is not signed in must not blank the whole list: the
      // other product's models are still usable.
      if (targets.length === 1) {
        sendError(res, 502, error instanceof Error ? error.message : String(error), { type: 'api_error' })
        return
      }
    }
  }
  sendJson(res, 200, { object: 'list', data })
}

async function getModel(res, selection, sessions, url) {
  const id = decodeURIComponent(url.pathname.slice('/v1/models/'.length))
  const targets = targetSessions(selection, sessions, url)
  for (const session of targets) {
    const { models } = await session.catalog().catch(() => ({ models: [] }))
    const found = models.find(model => model.id === id || `${session.variant.id}/${model.id}` === id)
    if (found !== undefined) {
      sendJson(res, 200, toOpenAIModels([found], session.variant.id).data[0])
      return
    }
  }
  sendError(res, 404, `model ${JSON.stringify(id)} not found`, { type: 'not_found_error' })
}

async function chatCompletions(req, res, selection, sessions) {
  let text
  try {
    text = await readBody(req)
  } catch (error) {
    sendError(res, error.tooLarge === true ? 413 : 400, error.message)
    return
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    sendError(res, 400, 'request body is not valid JSON')
    return
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendError(res, 400, 'request body must be a JSON object')
    return
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    sendError(res, 400, 'messages must be a non-empty array')
    return
  }

  // Product: the header, else a `variant/model` prefix on the id. Whichever way
  // it was decided, the prefix is stripped here and *written back* — it is the
  // request body that goes upstream, leaving it in place would send
  // `workbuddy-ai/kimi-k3` as the model name.
  let session = selection === undefined ? undefined : sessions.get(selection.id)
  if (session === undefined) {
    const prefix = typeof body.model === 'string' && body.model.includes('/') ? body.model.split('/')[0] : ''
    session = sessions.get(prefix ?? '')
    if (session === undefined) {
      sendError(res, 400, 'cannot tell which WorkBuddy product this request targets;'
        + ` set the ${VARIANT_HEADER} header, or prefix the model as `
        + `\`${[...sessions.keys()].map(id => `${id}/`).join('` or `')}<model>\``)
      return
    }
  }
  const upstreamModelId = resolveUpstreamModelId(body.model, session.variant.id)
  if (upstreamModelId === '') {
    sendError(res, 400, 'model is required')
    return
  }
  body.model = upstreamModelId

  const wantsStream = body.stream === true
  const prepared = normalizeTokenLimits(prepareChatBody(body, { global: session.global }))

  let credential
  try {
    credential = await session.credential()
  } catch (error) {
    sendError(res, 401, error instanceof Error ? error.message : String(error), { type: 'authentication_error' })
    return
  }

  // One retry: the token may have been refreshed by another request between the
  // credential read and the upstream call.
  let result = await session.upstream.chatStream(credential, JSON.stringify(prepared), req.signal)
  if (result.ok === false && result.kind === 'session_dead') {
    try {
      credential = await session.store.resolve()
      result = await session.upstream.chatStream(credential, JSON.stringify(prepared), req.signal)
    } catch {
      // Keep the original failure: it names the actual problem.
    }
  }

  if (result.ok === false) {
    const detail = extractDisplayErrorMessage(result.message) ?? result.message
    const status = result.status === 0 ? 502 : result.status
    sendError(res, status, detail || 'the WorkBuddy upstream rejected the request', {
      type: ERROR_TYPES[result.kind] ?? 'api_error',
      code: result.kind,
    })
    return
  }

  if (!wantsStream) {
    let completion
    try {
      // The upstream only streams, so a single-response request is satisfied by
      // merging the stream here. `sse.js` owns that merge.
      completion = await collectCompletion(result.response, { model: upstreamModelId })
    } catch (error) {
      sendError(res, 502, `the WorkBuddy response stream ended early: ${error instanceof Error ? error.message : String(error)}`, { type: 'api_error' })
      return
    }
    sendJson(res, 200, completion)
    return
  }

  // Streaming: pass the upstream SSE through with its own framing intact, so
  // `reasoning_content`, partial tool calls, and `[DONE]` all survive.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const reader = result.response.body.getReader()
  // A client that disconnects mid-stream must not leave the upstream connection
  // open; cancelling the reader is what actually closes it.
  req.on('close', () => reader.cancel().catch(() => {}))
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // `res.write` flushes each chunk on its own, which is what a client that
      // renders token-by-token needs.
      res.write(Buffer.from(value))
    }
  } catch {
    // The client went away, or the upstream dropped the stream. Either way the
    // response is already committed; ending it is all that is left to do.
  }
  res.end()
}
