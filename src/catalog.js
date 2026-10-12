/**
 * Normalizing the `/v3/config` product document into a model catalog.
 *
 * The document's `models` array is the *App's* roster. What an agent can
 * actually call is narrower: the `agents` entry that describes the CLI agent
 * lists the models it may use, and the upstream's own CLI-facing catalog is
 * that roster minus anything unusable. Advertising a model the gateway will not
 * serve produces a picker entry that fails on selection, so the roster is the
 * authority for membership.
 *
 * Where the document declares nothing narrower — a product version that omits
 * `agents`, or an agent with no explicit list — every usable row is kept, so a
 * future upstream change degrades to "too many models" rather than "no models".
 *
 * @module oc-workbuddy-connect/catalog
 */

import { EFFORT_VALUES } from './upstream.js'

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Reduce the upstream's credits string to a language-neutral display form.
 *
 * The upstream is inconsistent in a way that matters: some rows report a bare
 * multiplier (`x0.79`) and others append a unit word (`x0.79 credits`), and the
 * unit word would pin the display to English. Dropping a trailing `credits`
 * yields the one spelling that reads identically in every language.
 *
 * @param {string | undefined} credits
 * @returns {string | undefined}
 */
export function normalizeCredits(credits) {
  if (typeof credits !== 'string') return undefined
  const trimmed = credits.trim()
  // A string that is only the unit word carries no multiplier.
  if (trimmed === '' || /^credits?$/iu.test(trimmed)) return undefined
  const bare = trimmed.replace(/\s+credits?$/iu, '').trim()
  return bare === '' ? undefined : bare
}

/** Promotional badge labels, minus the upstream's `badge:` tag prefix. */
function badgesOf(row) {
  const badges = []
  for (const tag of Array.isArray(row.tags) ? row.tags : []) {
    if (typeof tag !== 'string') continue
    const lowered = tag.toLowerCase()
    if (!lowered.startsWith('badge:')) continue
    const label = tag.slice(6).split(':')[0] ?? ''
    if (label !== '' && !badges.includes(label)) badges.push(label)
  }
  return badges
}

/** Reasoning metadata the document declares for one model. */
function reasoningOf(row) {
  const supports = row.supportsReasoning === true
  const onlyReasoning = row.onlyReasoning === true
  const raw = isObject(row.reasoning) ? row.reasoning : {}
  const supportedEfforts = Array.isArray(raw.supportedEfforts)
    ? raw.supportedEfforts.filter(value => typeof value === 'string' && EFFORT_VALUES.includes(value))
    : []
  const defaultEffort = typeof raw.defaultEffort === 'string' && EFFORT_VALUES.includes(raw.defaultEffort)
    ? raw.defaultEffort
    : typeof raw.effort === 'string' && EFFORT_VALUES.includes(raw.effort) ? raw.effort : undefined
  return {
    supports,
    onlyReasoning,
    ...supportedEfforts.length === 0 ? {} : { supportedEfforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
    // Only an explicit `true` offers "thinking off"; older rows omit the field
    // and several of them reject it on the wire.
    canDisableThinking: raw.canDisableThinking === true,
  }
}

/**
 * The roster of model ids the CLI agent may use, or `undefined` when the
 * document declares none.
 *
 * @param {object} document Product document.
 * @returns {Set<string> | undefined}
 */
function cliRoster(document) {
  const agents = Array.isArray(document.agents) ? document.agents : []
  // The CLI agent is the one whose `description` names it; matching on that
  // rather than on position, because the array also holds other agent kinds.
  const cli = agents.find(agent => isObject(agent) && /cli agent/iu.test(String(agent.description ?? '')))
    ?? agents.find(agent => isObject(agent) && Array.isArray(agent.models))
  if (cli === undefined || !Array.isArray(cli.models) || cli.models.length === 0) return undefined
  const ids = new Set()
  for (const id of cli.models) {
    if (typeof id === 'string' && id !== '') ids.add(id)
  }
  return ids.size === 0 ? undefined : ids
}

/**
 * Normalize a product document into this bridge's model list.
 *
 * @param {object} document The `/v3/config` answer.
 * @param {{variantId: string}} options
 * @returns {Array<object>} Models in upstream order.
 */
export function parseCatalog(document, { variantId }) {
  if (!isObject(document)) return []
  const roster = cliRoster(document)
  const rows = Array.isArray(document.models) ? document.models : []
  const models = []
  const seen = new Set()
  for (const row of rows) {
    if (!isObject(row)) continue
    const id = typeof row.id === 'string' ? row.id : ''
    if (id === '' || seen.has(id)) continue
    // Membership follows the CLI roster when the document declares one.
    if (roster !== undefined && !roster.has(id)) continue
    seen.add(id)
    // A row the product itself marks unusable is not offered.
    if (row.disabled === true) continue
    const credits = normalizeCredits(typeof row.credits === 'string' ? row.credits : undefined)
    const badges = badgesOf(row)
    models.push({
      id,
      variantId,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : id,
      ...typeof row.descriptionZh === 'string' && row.descriptionZh !== ''
        ? { description: row.descriptionZh }
        : typeof row.descriptionEn === 'string' && row.descriptionEn !== ''
          ? { description: row.descriptionEn }
          : {},
      // `maxInputTokens` is the real context ceiling. `maxAllowedSize` is the
      // upstream's own per-message attachment cap, which is a different limit
      // and must not be mistaken for one.
      contextWindow: numberOr(row.maxInputTokens, 128_000),
      maxOutputTokens: numberOr(row.maxOutputTokens, 8_192),
      ...numberOr(row.contextWindow, 0) > 0 ? { upstreamContextWindow: row.contextWindow } : {},
      supportsImages: row.supportsImages === true && row.disabledMultimodal !== true,
      supportsToolCall: row.supportsToolCall !== false,
      reasoning: reasoningOf(row),
      ...credits === undefined ? {} : { credits },
      ...badges.length === 0 ? {} : { badges },
      ...credits !== undefined && /^x?0\.0+$/u.test(credits) ? { free: true } : {},
    })
  }
  return models
}

/**
 * Apply the international endpoint's promotional schedule to a model list.
 *
 * The gateway bakes a promotion's discounted multiplier into the model's own
 * `credits` field, so the badge has to come from `modelPromotions` and the
 * effective rate has to be recomputed from it. A row whose promotion has since
 * expired cannot have its original price recovered, so it is marked
 * `rateUnknown` rather than continuing to advertise the discount.
 *
 * @param {Array<object>} models
 * @param {object} document Product document.
 * @returns {Array<object>}
 */
export function applyPromotions(models, document) {
  const promotions = isObject(document) && Array.isArray(document.modelPromotions) ? document.modelPromotions : []
  if (promotions.length === 0) return models
  const now = Date.now()
  const byModel = new Map()
  for (const promotion of promotions) {
    if (!isObject(promotion) || promotion.enabled === false) continue
    const factor = isObject(promotion.discount) && typeof promotion.discount.factor === 'number'
      ? promotion.discount.factor
      : undefined
    if (factor === undefined) continue
    const label = typeof promotion.badge?.label === 'string' ? promotion.badge.label : ''
    const ids = Array.isArray(promotion.modelIds) ? promotion.modelIds : []
    const inWindow = promotion.schedule === undefined
      || (typeof promotion.schedule.validFrom !== 'string' || Date.parse(promotion.schedule.validFrom) <= now)
      && (typeof promotion.schedule.validUntil !== 'string' || Date.parse(promotion.schedule.validUntil) >= now)
    for (const id of ids) {
      if (typeof id !== 'string' || id === '') continue
      byModel.set(id, { factor, label, inWindow })
    }
  }
  if (byModel.size === 0) return models
  return models.map((model) => {
    const promotion = byModel.get(model.id)
    if (promotion === undefined) return model
    if (!promotion.inWindow) {
      // Expired: the gateway left the discounted rate in place, and the
      // original is unrecoverable.
      return { ...model, credits: undefined, rateUnknown: true, free: false }
    }
    const original = typeof model.credits === 'string' && model.credits.startsWith('x')
      ? Number(model.credits.slice(1))
      : Number.NaN
    if (promotion.factor !== 0 && !Number.isFinite(original)) return model
    const value = promotion.factor === 0 ? 0 : original * promotion.factor
    return {
      ...model,
      credits: `x${value.toFixed(2)}`,
      free: value === 0,
      badges: promotion.label === '' ? [...(model.badges ?? [])] : [...new Set([...(model.badges ?? []), promotion.label])],
    }
  })
}

/**
 * The model list for one product document: normalized, then promotion-aware.
 *
 * @param {object} document
 * @param {{variantId: string, global: boolean}} options
 * @returns {Array<object>}
 */
export function catalogFor(document, { variantId, global }) {
  const models = parseCatalog(document, { variantId })
  return global ? applyPromotions(models, document) : models
}

/**
 * An OpenAI `/v1/models` listing for a set of models.
 *
 * `owned_by` carries the variant id, which is what lets a client that shows a
 * provider badge tell the two rosters apart.
 *
 * @param {Array<object>} models
 * @param {string} owner
 * @returns {{object: string, data: Array<object>}}
 */
export function toOpenAIModels(models, owner) {
  return {
    object: 'list',
    data: models.map(model => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: owner,
    })),
  }
}
