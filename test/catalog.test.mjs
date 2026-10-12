// Unit tests for the catalog normalizer: roster membership, credit parsing,
// and the promotion schedule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPromotions, catalogFor, normalizeCredits, parseCatalog } from '../src/catalog.js'

const CN_DOC = {
  models: [
    { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1000000, maxOutputTokens: 64000, credits: 'x0.79 credits',
      supportsImages: true, supportsToolCall: true, supportsReasoning: true,
      reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true } },
    { id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 200000, maxOutputTokens: 8000, credits: 'x0.79' },
    { id: 'hidden', name: 'Hidden', maxInputTokens: 1000, maxOutputTokens: 100, disabled: true },
  ],
  agents: [{ description: 'cli agent', models: ['glm-5.3', 'glm-5.2'] }],
}

test('the CLI roster decides membership', () => {
  const models = parseCatalog(CN_DOC, { variantId: 'workbuddy' })
  assert.deepEqual(models.map(m => m.id), ['glm-5.3', 'glm-5.2'])
})

test('a document without an explicit roster keeps every usable row', () => {
  const models = parseCatalog({ models: CN_DOC.models }, { variantId: 'workbuddy' })
  // `hidden` is dropped by its own disabled flag, not by roster absence.
  assert.deepEqual(models.map(m => m.id), ['glm-5.3', 'glm-5.2'])
})

test('a disabled row is never offered', () => {
  const models = parseCatalog({ models: [{ id: 'x', name: 'X', disabled: true }] }, { variantId: 'workbuddy' })
  assert.equal(models.length, 0)
})

test('credits are normalized to a language-neutral form', () => {
  assert.equal(normalizeCredits('x0.79 credits'), 'x0.79')
  assert.equal(normalizeCredits('x0.79'), 'x0.79')
  assert.equal(normalizeCredits('credits'), undefined)
  assert.equal(normalizeCredits(''), undefined)
  assert.equal(normalizeCredits(undefined), undefined)
})

test('a x0.00 multiplier is free', () => {
  const models = parseCatalog({
    models: [{ id: 'hy3', name: 'Hy3', credits: 'x0.00' }],
  }, { variantId: 'workbuddy' })
  assert.equal(models[0].free, true)
  assert.equal(models[0].credits, 'x0.00')
})

test('reasoning metadata survives normalization', () => {
  const models = parseCatalog(CN_DOC, { variantId: 'workbuddy' })
  const reasoning = models[0].reasoning
  assert.equal(reasoning.supports, true)
  assert.deepEqual(reasoning.supportedEfforts, ['low', 'high', 'max'])
  assert.equal(reasoning.defaultEffort, 'high')
  assert.equal(reasoning.canDisableThinking, true)
})

test('image support requires both flags to agree', () => {
  const models = parseCatalog({
    models: [
      { id: 'a', supportsImages: true, disabledMultimodal: true },
      { id: 'b', supportsImages: true },
      { id: 'c', supportsImages: false },
    ],
  }, { variantId: 'workbuddy' })
  assert.equal(models[0].supportsImages, false)
  assert.equal(models[1].supportsImages, true)
  assert.equal(models[2].supportsImages, false)
})

test('promotions recompute the rate from the schedule', () => {
  const models = [
    { id: 'hy3', name: 'Hy3', credits: 'x0.79' },
  ]
  const promotions = [{
    enabled: true,
    badge: { label: 'Free now' },
    discount: { factor: 0 },
    modelIds: ['hy3'],
    schedule: { validFrom: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z' },
  }]
  const applied = applyPromotions(models, { modelPromotions: promotions })
  assert.equal(applied[0].free, true)
  assert.equal(applied[0].credits, 'x0.00')
  assert.deepEqual(applied[0].badges, ['Free now'])
})

test('an expired promotion cannot recover the original price', () => {
  const models = [{ id: 'hy3', name: 'Hy3', credits: 'x0.00' }]
  const promotions = [{
    enabled: true,
    badge: { label: 'Free now' },
    discount: { factor: 0 },
    modelIds: ['hy3'],
    schedule: { validFrom: '2020-01-01T00:00:00Z', validUntil: '2021-01-01T00:00:00Z' },
  }]
  const applied = applyPromotions(models, { modelPromotions: promotions })
  assert.equal(applied[0].rateUnknown, true)
  assert.equal(applied[0].credits, undefined)
  assert.equal(applied[0].free, false)
})

test('a promotion factor scales the base rate', () => {
  const models = [{ id: 'm', name: 'M', credits: 'x2.00' }]
  const promotions = [{
    enabled: true,
    badge: { label: 'Half' },
    discount: { factor: 0.5 },
    modelIds: ['m'],
  }]
  const applied = applyPromotions(models, { modelPromotions: promotions })
  assert.equal(applied[0].credits, 'x1.00')
})

test('catalogFor applies promotions only globally', () => {
  const doc = {
    models: [{ id: 'm', name: 'M', credits: 'x0.79' }],
    modelPromotions: [{ enabled: true, badge: { label: 'Free now' }, discount: { factor: 0 }, modelIds: ['m'] }],
  }
  const cn = catalogFor(doc, { variantId: 'workbuddy', global: false })
  assert.equal(cn[0].credits, 'x0.79')
  const intl = catalogFor(doc, { variantId: 'workbuddy-ai', global: true })
  assert.equal(intl[0].free, true)
})

test('maxAllowedSize is not mistaken for a context window', () => {
  const models = parseCatalog({
    models: [{ id: 'm', name: 'M', maxInputTokens: 128000, maxAllowedSize: 56000 }],
  }, { variantId: 'workbuddy' })
  assert.equal(models[0].contextWindow, 128000)
})
