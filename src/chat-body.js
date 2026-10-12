/**
 * Normalizing an OpenAI chat-completions body for the WorkBuddy upstream.
 *
 * Each rule below exists because the gateway rejected the body without it, not
 * because it is tidier. A body that is not a JSON object is returned unchanged
 * in every case, so these are safe to run over an already-prepared body.
 *
 * @module oc-workbuddy-connect/chat-body
 */

/** The system prompt injected when the international gateway gets none. */
export const INTERNATIONAL_SYSTEM_PROMPT = 'You are a helpful assistant.'

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rewrite `role: "developer"` messages to `role: "system"`.
 *
 * Load-bearing: newer OpenAI clients emit the system prompt as `developer`,
 * and the WorkBuddy upstream rejects that role with HTTP 400 code 11128
 * ("Illegal API invocation from an unapproved channel"). `system` is the
 * compatible spelling the gateway accepts.
 */
function normalizeDeveloperRole(body) {
  if (!Array.isArray(body.messages)) return
  for (const message of body.messages) {
    if (isObject(message) && message.role === 'developer') message.role = 'system'
  }
}

/**
 * Rewrite OpenAI `tool_choice` spellings into the upstream's string form.
 *
 * The upstream's field is a plain string; the object forms a modern client may
 * send return 400. `none` is expressed by removing the field *and* the tools,
 * since a request that carries tools but forbids their use is rejected.
 */
function normalizeToolChoice(body) {
  if (!('tool_choice' in body)) return
  const suppress = () => {
    delete body.tools
    delete body.functions
  }
  const choice = body.tool_choice
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete body.tool_choice
      suppress()
    }
    return
  }
  if (isObject(choice)) {
    const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : ''
    if (type === 'none') {
      delete body.tool_choice
      suppress()
    } else if (type === 'auto' || type === 'required') {
      body.tool_choice = type
    } else if (type === 'function') {
      let name = typeof choice.function?.name === 'string' ? choice.function.name : ''
      if (name === '' && typeof choice.name === 'string') name = choice.name
      name = name.trim()
      body.tool_choice = name !== '' ? name : 'auto'
    } else {
      delete body.tool_choice
    }
    return
  }
  delete body.tool_choice
}

/**
 * Remove the `'off'` reasoning-effort spelling from the wire, on every region.
 *
 * Both endpoints reject it: the international GPT family answers HTTP 400
 * `11133` with `extError.param === 'reasoning.effort'`, and the CN endpoint
 * rejects it on models that declare `onlyReasoning`. Omission is the only form
 * measured good on every such model — a literal `'none'` is *not* a safe
 * substitute, since the GPT family and GLM accept it but `gpt-6-astra` does
 * not. Declared spellings (`low`/`medium`/`high`/`xhigh`/`max`) pass through.
 */
function dropUnsupportedEffort(body) {
  if (body.reasoning_effort === 'off') delete body.reasoning_effort
}

/**
 * Prepare a chat body for the upstream.
 *
 * Always forces `stream: true`: the gateway rejects a non-streaming request
 * outright (HTTP 400 code 11101), so a caller asking for a single response
 * must be buffered downstream rather than forwarded.
 *
 * @param {unknown} body Parsed request body.
 * @param {{global: boolean}} options Which region's gateway will receive it.
 * @returns {object} The prepared body (mutated in place).
 */
export function prepareChatBody(body, { global }) {
  if (!isObject(body)) return body
  body.stream = true
  normalizeDeveloperRole(body)
  normalizeToolChoice(body)
  dropUnsupportedEffort(body)
  if (!global) return body
  // The international gateway rejects a body whose first message is not
  // `system` (HTTP 400 code 11128). Note the same code on the *CN* endpoint
  // reports a rejected `developer` role, so the two are never branched on by
  // code alone. The added prompt is prepended, never merged: every
  // caller-supplied message keeps its position and wording.
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const first = body.messages[0]
    if (!(isObject(first) && first.role === 'system')) {
      body.messages.unshift({ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT })
    }
  }
  return body
}

/**
 * Map an OpenAI `max_tokens` / `max_completion_tokens` onto the field the
 * upstream reads.
 *
 * Some clients send `max_completion_tokens`; the upstream accepts that name
 * too, so nothing is rewritten. What is removed is a value of `0`, which some
 * clients send to mean "no limit" and the upstream reads as "output nothing".
 *
 * @param {object} body
 * @returns {object} The same body.
 */
export function normalizeTokenLimits(body) {
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    if (body[key] === 0) delete body[key]
  }
  return body
}

/**
 * The model id to send upstream, after optional client-side alias stripping.
 *
 * The bridge accepts `variant/model` so one endpoint can serve both rosters,
 * but the upstream only ever sees the bare id.
 *
 * @param {unknown} model
 * @param {string} variantId
 * @returns {string}
 */
export function resolveUpstreamModelId(model, variantId) {
  const value = typeof model === 'string' ? model.trim() : ''
  for (const id of [variantId, 'workbuddy-ai', 'workbuddy']) {
    if (value.toLowerCase().startsWith(`${id}/`)) return value.slice(id.length + 1)
  }
  return value
}
