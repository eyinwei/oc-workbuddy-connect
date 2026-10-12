/**
 * The WorkBuddy upstream client: chat streaming, token refresh, model catalog,
 * and credit balance, for both regions.
 *
 * Wire behavior is ported from the upstream protocol as observed in the
 * WorkBuddy desktop clients and the MIT-licensed `Sliverkiss/workbuddy2api`
 * reference implementation.
 *
 * Two behaviours here are load-bearing and easy to get wrong:
 *
 *   1. The gateway **rejects non-streaming** chat with HTTP 400 code 11101
 *      ("Non-stream chat request is currently not supported"). Every request is
 *      therefore sent with `stream: true`; a caller that wanted a single
 *      response must buffer the stream itself.
 *   2. The gateway splits the model roster by User-Agent. A CLI-shaped UA
 *      yields the CLI roster (the models an agent can actually call); a
 *      desktop-shaped UA yields the App's internal roster. The CN catalog keeps
 *      the CLI UA so it advertises exactly what its own requests can use.
 *
 * @module oc-workbuddy-connect/upstream
 */

import { readFile } from 'node:fs/promises'
import { CLI_USER_AGENT, REGION_GLOBAL, chatUserAgent, regionOf } from './variants.js'
import { resolveAppVersion } from './app-version.js'

/** Timeout for a non-streaming JSON call (refresh, catalog, credits). */
const JSON_TIMEOUT_MS = 30_000
/** How much of a failing body is read for diagnosis. */
const ERROR_BODY_LIMIT = 4096

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough', 'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153']

/** The concrete reasoning-effort spellings WorkBuddy exposes on the wire. */
export const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 *
 * @param {number} status
 * @param {string} body
 * @returns {'hard_credit' | 'soft_rate' | 'session_dead' | 'not_found' | 'server' | 'client'}
 */
export function classifyUpstreamError(status, body) {
  if (status === 402) return 'hard_credit'
  // A 401 is an auth failure whatever its body says: this upstream has no
  // other business meaning for it.
  if (status === 401) return 'session_dead'
  const lower = String(body).toLowerCase()
  if (HARD_CREDIT_MARKERS.some(marker => lower.includes(marker.toLowerCase()) || String(body).includes(marker))) {
    return 'hard_credit'
  }
  if (SESSION_DEAD_MARKERS.some(marker => String(body).includes(marker))) return 'session_dead'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

/**
 * A user-facing message from an upstream JSON error body.
 *
 * Prefers WorkBuddy's localized `displayMsg`, falling back to `msg`.
 *
 * @param {string} body
 * @returns {string | undefined}
 */
export function extractDisplayErrorMessage(body) {
  const trimmed = String(body).trim()
  if (!trimmed.startsWith('{')) return undefined
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const localized = parsed.displayMsg
  if (typeof localized === 'object' && localized !== null && !Array.isArray(localized)) {
    for (const key of ['zh', 'en']) {
      if (typeof localized[key] === 'string' && localized[key].trim() !== '') return localized[key].trim()
    }
  }
  return typeof parsed.msg === 'string' && parsed.msg.trim() !== '' ? parsed.msg.trim() : undefined
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One `{code, msg, data}` envelope, already unwrapped. */
async function readEnvelope(response, what) {
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${what} returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (!isObject(parsed)) throw new Error(`${what} returned an unexpected document (http ${response.status})`)
  return {
    code: typeof parsed.code === 'number' ? parsed.code : 0,
    msg: typeof parsed.msg === 'string' ? parsed.msg : '',
    data: 'data' in parsed ? parsed.data : undefined,
    document: parsed,
  }
}

function envelopeError(status, envelope) {
  const kind = classifyUpstreamError(status, envelope.msg)
  const detail = extractDisplayErrorMessage(JSON.stringify(envelope.document)) ?? envelope.msg
  return Object.assign(new Error(`${kind}: ${detail || `http ${status}`}`), { kind, status, upstream: detail })
}

/**
 * The upstream client for one variant.
 *
 * Requests take the credential explicitly, so a token refresh applies on the
 * next call without the client holding any auth state of its own.
 */
export class UpstreamClient {
  #variant
  #identity

  /**
   * @param {object} variant WorkBuddy variant descriptor.
   */
  constructor(variant) {
    this.#variant = variant
    this.#identity = undefined
  }

  get variant() {
    return this.#variant
  }

  /** Chat base for a credential: decided by the credential's own domain. */
  #chatBase(credential) {
    return regionOf(credential.domain) === REGION_GLOBAL ? this.#variant.bases.chat : this.#variant.bases.chat
  }

  #isGlobal(credential) {
    return regionOf(credential.domain) === REGION_GLOBAL
  }

  /** Resolved client identity, cached for the process: App version + optional CLI version. */
  async identity() {
    this.#identity ??= await resolveAppVersion(this.#variant)
    return this.#identity
  }

  /** Headers every upstream request shares. */
  #commonHeaders(credential) {
    const origin = this.#variant.bases.origin
    return {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: origin,
      Referer: `${origin}/`,
      'User-Agent': CLI_USER_AGENT,
    }
  }

  /**
   * Chat request headers.
   *
   * Includes the `X-No-*` conventions the official client uses: the gateway
   * expects an explicit "there is none" marker rather than an absent header.
   */
  #chatHeaders(credential, userAgent, clientVersion) {
    return {
      ...this.#commonHeaders(credential),
      'User-Agent': userAgent,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential.accessToken}`,
      ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
      ...credential.enterpriseId === undefined || credential.enterpriseId === ''
        ? { 'X-No-Enterprise-Id': '1' }
        : { 'X-Enterprise-Id': credential.enterpriseId },
      ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
      'X-IDE-Type': 'WorkBuddy',
      'X-IDE-Name': 'WorkBuddy',
      'X-IDE-Version': clientVersion,
      'X-Product': 'SaaS',
    }
  }

  /**
   * POST the chat endpoint.
   *
   * A successful answer is the raw SSE `Response`, handed back unconsumed: the
   * body is already OpenAI-shaped, and re-serializing it would only risk
   * losing `reasoning_content` or a partial tool call.
   *
   * @param {object} credential
   * @param {string} bodyJson Prepared request body.
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ok: true, response: Response} | {ok: false, status: number, kind: string, message: string}>}
   */
  async chatStream(credential, bodyJson, signal) {
    const global = this.#isGlobal(credential)
    // Identity resolution must never block a message: any failure degrades to
    // the built-in fallback form, never to the legacy CLI UA.
    const identity = await this.identity().catch(() => undefined)
    const clientVersion = identity?.version ?? this.#variant.fallbackAppVersion
    const userAgent = chatUserAgent(clientVersion, identity?.cliVersion, global ? REGION_GLOBAL : 'cn')
    let response
    try {
      response = await fetch(`${this.#chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: this.#chatHeaders(credential, userAgent, clientVersion),
        body: bodyJson,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return { ok: false, status: response.status, kind: classifyUpstreamError(response.status, text), message: text }
  }

  /**
   * POST the token-refresh endpoint.
   *
   * This is the one path that carries the refresh token; chat never does.
   *
   * @param {object} credential
   * @returns {Promise<{accessToken: string, refreshToken?: string, expiresInSec?: number, domain?: string}>}
   */
  async refreshToken(credential) {
    const global = this.#isGlobal(credential)
    const headers = {
      ...this.#commonHeaders(credential),
      'X-Refresh-Token': credential.refreshToken,
      'X-Auth-Refresh-Source': 'workbuddy',
    }
    if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      headers['X-Enterprise-Id'] = credential.enterpriseId
    }
    const response = await fetch(`${this.#chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response, 'token refresh')
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = isObject(envelope.data) ? envelope.data : {}
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken : ''
    if (accessToken === '') throw new Error('token refresh returned no accessToken; sign in again in the WorkBuddy app')
    const outcome = { accessToken }
    if (typeof data.refreshToken === 'string' && data.refreshToken !== '') outcome.refreshToken = data.refreshToken
    if (typeof data.expiresIn === 'number' && data.expiresIn > 0) outcome.expiresInSec = data.expiresIn
    if (typeof data.domain === 'string' && data.domain !== '' && global) outcome.domain = data.domain
    return outcome
  }

  /**
   * GET the personal model catalog (`/v3/config`).
   *
   * Both regions read the same path; what distinguishes them is the
   * User-Agent, because the gateway splits the roster by client identity.
   * CN sends the CLI UA so its catalog is exactly the roster its own chat
   * requests can use.
   *
   * @param {object} credential
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>} The product document.
   */
  async fetchCatalog(credential, signal) {
    const global = this.#isGlobal(credential)
    const origin = this.#variant.bases.origin
    const identity = await this.identity().catch(() => undefined)
    const appVersion = identity?.version ?? this.#variant.fallbackAppVersion
    const response = await fetch(`${this.#chatBase(credential)}/v3/config`, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: 'application/json',
        Origin: origin,
        Referer: `${origin}/`,
        ...global ? { 'X-Requested-With': 'XMLHttpRequest', 'X-Product': 'SaaS' } : {},
        'User-Agent': global
          ? chatUserAgent(appVersion, identity?.cliVersion, REGION_GLOBAL)
          : CLI_USER_AGENT,
      },
      signal: signal === undefined ? AbortSignal.timeout(JSON_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)]),
    })
    const envelope = await readEnvelope(response, 'model catalog')
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    // Two shapes share this path: the endpoints wrap their answer in
    // `{code, msg, data}`, but `/v3/config` has also been observed answering
    // with the product document bare at the top level. Treating a missing
    // `data` as an empty document would turn that second shape into a spurious
    // "no models".
    if (isObject(envelope.data)) return envelope.data
    if ('models' in envelope.document || 'agents' in envelope.document) return envelope.document
    throw new Error('model catalog answered with an unrecognized document shape')
  }

  /**
   * POST the credit meter.
   *
   * CN enterprise accounts (`enterpriseId` non-empty) get a single cycle quota
   * from the enterprise endpoint; the personal endpoint serves them an empty
   * `Accounts` list, which would read as "0 credit" — a wrong number rather
   * than a visible failure. The region gate is load-bearing: the enterprise
   * endpoint is unverified internationally, so a global credential carrying an
   * `enterpriseId` stays on the measured personal path.
   *
   * @param {object} credential
   * @returns {Promise<{total: number, unlimited?: true, packages: Array<object>}>}
   */
  async fetchCredits(credential) {
    const global = this.#isGlobal(credential)
    if (!global && credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      return await this.#fetchEnterpriseCredits(credential)
    }
    const format = (date) => [
      String(date.getFullYear()).padStart(4, '0'),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-') + ' ' + [
      String(date.getHours()).padStart(2, '0'),
      String(date.getMinutes()).padStart(2, '0'),
      String(date.getSeconds()).padStart(2, '0'),
    ].join(':')
    const now = new Date()
    const response = await fetch(`${this.#variant.bases.billing}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: this.#billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response, 'credit meter')
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const accounts = isObject(envelope.data) && isObject(envelope.data.Response) && isObject(envelope.data.Response.Data)
      && Array.isArray(envelope.data.Response.Data.Accounts)
      ? envelope.data.Response.Data.Accounts
      : []
    const packages = []
    let total = 0
    for (const raw of accounts) {
      if (!isObject(raw)) continue
      const number = (key) => (typeof raw[key] === 'number' ? raw[key] : 0)
      const size = number('CycleCapacitySize')
      const cycleRemain = number('CycleCapacityRemain')
      const cycleUsed = number('CycleCapacityUsed')
      const capacityRemain = number('CapacityRemain')
      let remain
      if (size > 0) remain = cycleRemain
      else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain
      else remain = capacityRemain
      if (remain < 0) remain = 0
      total += remain
      const endTimeMs = parseCycleEndTime(raw.CycleEndTime)
      packages.push({
        name: typeof raw.PackageName === 'string' ? raw.PackageName : '(unnamed)',
        remain,
        size: size > 0 ? size : number('CapacitySize'),
        ...endTimeMs === undefined ? {} : { endTimeMs },
      })
    }
    return { total, packages }
  }

  async #fetchEnterpriseCredits(credential) {
    const response = await fetch('https://www.codebuddy.cn/v2/billing/meter/get-enterprise-user-usage', {
      method: 'POST',
      headers: {
        ...this.#billingHeaders(credential),
        'X-Enterprise-Id': credential.enterpriseId,
        'X-Tenant-Id': credential.enterpriseId,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response, 'enterprise credit meter')
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = isObject(envelope.data) ? envelope.data : {}
    const limit = typeof data.LimitNum === 'number' ? data.LimitNum : 0
    const used = typeof data.UsedNum === 'number' ? data.UsedNum : 0
    const unlimited = limit === -1
    return {
      total: unlimited ? 0 : Math.max(0, limit - used),
      ...unlimited ? { unlimited: true } : {},
      ...typeof data.ResetDate === 'string' ? { cycleResetTime: data.ResetDate } : {},
      packages: [{
        name: 'enterprise',
        remain: unlimited ? 0 : Math.max(0, limit - used),
        size: limit,
      }],
    }
  }

  #billingHeaders(credential) {
    const headers = {
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }
    if (credential.uid !== '') headers['X-User-Id'] = credential.uid
    if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      headers['X-Enterprise-Id'] = credential.enterpriseId
      headers['X-Tenant-Id'] = credential.enterpriseId
    }
    if (credential.domain !== '') headers['X-Domain'] = credential.domain
    return headers
  }
}

/**
 * Parse the upstream's zone-less `YYYY-MM-DD HH:mm:ss` cycle-end string.
 *
 * Read as the running machine's local time, following the official desktop
 * client. The zone the upstream *means* is not established, so this is a
 * display convenience and not a claim about the account's zone.
 */
export function parseCycleEndTime(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(value.trim())
  if (match === null) return undefined
  const [, y, mo, d, h, mi, s] = match
  const ms = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

export { readFile }
