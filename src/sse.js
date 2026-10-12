/**
 * Reading and re-shaping a WorkBuddy SSE stream.
 *
 * The upstream already speaks the OpenAI chunk format, so streaming is a
 * pass-through and needs nothing here. What *does* need this module is the
 * non-streaming path: the gateway rejects `stream: false` (HTTP 400 code
 * 11101), so a client that asked for a single response gets one by buffering
 * the stream and merging the chunks.
 *
 * Two upstream spellings are normalized on the way out:
 *
 *   - `reasoning_content` is WorkBuddy's name for OpenAI's `reasoning` field.
 *     It is preserved under **both** names on merge, so a client reading either
 *     one sees the reasoning.
 *   - some models report a tool call on a single `function_call` delta instead
 *     of the `tool_calls` array. Both are merged into one array, keyed by index,
 *     so a client only has to read `tool_calls`.
 *
 * @module oc-workbuddy-connect/sse
 */

import { randomUUID } from 'node:crypto'

/**
 * Merge a list of OpenAI chunks into one completion body.
 *
 * Faithful on every part a client reads: content, reasoning, tool calls by
 * index, finish reason, and usage.
 *
 * @param {Array<object>} chunks
 * @param {{model?: string}} [options] Fallback model id when no chunk names one.
 * @returns {object} A `chat.completion` body.
 */
export function mergeChunks(chunks, { model: fallbackModel } = {}) {
  const content = []
  const reasoning = []
  const toolCalls = new Map()
  let finishReason = null
  let usage
  let id
  let model
  let created
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue
    if (typeof chunk.id === 'string') id = chunk.id
    if (typeof chunk.model === 'string' && chunk.model !== '') model = chunk.model
    if (typeof chunk.created === 'number') created = chunk.created
    if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
    if (choice === undefined || choice === null || typeof choice !== 'object') continue
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') finishReason = choice.finish_reason
    const delta = choice.delta
    if (delta === undefined || delta === null || typeof delta !== 'object') continue
    if (typeof delta.content === 'string' && delta.content !== '') content.push(delta.content)
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') reasoning.push(delta.reasoning_content)
    mergeToolCalls(toolCalls, delta)
  }
  const text = content.join('')
  const thought = reasoning.join('')
  return {
    id: id ?? `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: created ?? Math.floor(Date.now() / 1000),
    model: model ?? fallbackModel ?? '',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
        ...thought === '' ? {} : { reasoning: thought, reasoning_content: thought },
        ...toolCalls.size === 0 ? {} : { tool_calls: orderedToolCalls(toolCalls) },
      },
      logprobs: null,
      finish_reason: finishReason ?? (toolCalls.size > 0 ? 'tool_calls' : 'stop'),
    }],
    ...usage === undefined ? {} : { usage },
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Accumulate one delta's tool-call deltas, by index. */
function mergeToolCalls(into, delta) {
  const record = (index, patch) => {
    const fn = patch.function
    // An entry with no id, no name, and no argument fragment says nothing. The
    // upstream emits exactly that as a terminator, and recording it would add a
    // tool call to a reply that made none.
    const carriesNothing = (typeof patch.id !== 'string' || patch.id === '')
      && (!isObject(fn) || (typeof fn.name !== 'string' || fn.name === '')
        && (typeof fn.arguments !== 'string' || fn.arguments === ''))
    if (carriesNothing) return
    const existing = into.get(index) ?? { type: 'function', function: { name: '', arguments: '' } }
    if (typeof patch.id === 'string' && patch.id !== '') existing.id = patch.id
    if (typeof patch.type === 'string' && patch.type !== '') existing.type = patch.type
    if (fn !== undefined && fn !== null && typeof fn === 'object') {
      // Names and argument fragments arrive as deltas, so they concatenate.
      if (typeof fn.name === 'string' && fn.name !== '') existing.function.name += fn.name
      if (typeof fn.arguments === 'string') existing.function.arguments += fn.arguments
    }
    into.set(index, existing)
  }
  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    if (call === undefined || call === null || typeof call !== 'object') continue
    record(typeof call.index === 'number' ? call.index : into.size, call)
  }
  // The upstream sends `function_call: null` on ordinary chunks and a bare
  // `{"name":"","arguments":""}` on the terminal one. `typeof null === 'object'`,
  // so both the null test and the emptiness test below are load-bearing: without
  // them every text-only reply would carry a phantom empty tool call.
  const legacy = delta.function_call
  if (isObject(legacy)) record(0, { function: legacy })
}

function orderedToolCalls(into) {
  return [...into.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call)
}

/**
 * Parse every `data:` payload out of an SSE body.
 *
 * Comment frames (`: heartbeat`, which the upstream sends between chunks) and
 * the terminal `[DONE]` are skipped by construction. A frame that is not JSON
 * carries nothing a client can use, so it is dropped rather than failing the
 * whole stream.
 *
 * @param {string} text A complete SSE body.
 * @returns {Array<object>}
 */
export function parseSseBody(text) {
  const chunks = []
  for (const frame of text.split(/\r?\n\r?\n/u)) {
    for (const line of frame.split(/\r?\n/u)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '' || data === '[DONE]') continue
      try {
        chunks.push(JSON.parse(data))
      } catch {
        // Not a chunk; nothing to merge.
      }
    }
  }
  return chunks
}

/**
 * Consume a streaming `Response` into one completion body.
 *
 * @param {Response} response A `text/event-stream` response.
 * @param {{model?: string}} [options]
 * @returns {Promise<object>}
 */
export async function collectCompletion(response, options = {}) {
  if (response.body === null) throw new Error('the WorkBuddy response carried no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks = []
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary
    // Frames are separated by a blank line; consume every complete one, and
    // leave the trailing partial frame in the buffer.
    while ((boundary = buffer.search(/\r?\n\r?\n/u)) !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/u, '')
      for (const line of frame.split(/\r?\n/u)) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '' || data === '[DONE]') continue
        try {
          chunks.push(JSON.parse(data))
        } catch {
          // Not a chunk; nothing to merge.
        }
      }
    }
  }
  return mergeChunks(chunks, options)
}
