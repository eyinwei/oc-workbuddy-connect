// Unit tests for variant resolution and the client identity the gateway
// branches on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AI_VARIANT,
  CN_VARIANT,
  REGION_GLOBAL,
  VARIANT_IDS,
  chatUserAgent,
  regionOf,
  resolveVariantId,
  variantFor,
} from '../src/variants.js'

test('regionOf routes by login domain', () => {
  assert.equal(regionOf('www.workbuddy.ai'), REGION_GLOBAL)
  assert.equal(regionOf('api.workbuddy.ai'), REGION_GLOBAL)
  assert.equal(regionOf('WWW.WORKBUDDY.AI'), REGION_GLOBAL)
  assert.equal(regionOf('www.workbuddy.cn'), 'cn')
  assert.equal(regionOf(''), 'cn')
  assert.equal(regionOf(undefined), 'cn')
})

test('resolveVariantId accepts the canonical ids and the natural aliases', () => {
  assert.equal(resolveVariantId('workbuddy'), 'workbuddy')
  assert.equal(resolveVariantId('workbuddy-ai'), 'workbuddy-ai')
  assert.equal(resolveVariantId('cn'), 'workbuddy')
  assert.equal(resolveVariantId('china'), 'workbuddy')
  assert.equal(resolveVariantId('ai'), 'workbuddy-ai')
  assert.equal(resolveVariantId('global'), 'workbuddy-ai')
  assert.equal(resolveVariantId('intl'), 'workbuddy-ai')
  assert.equal(resolveVariantId('international'), 'workbuddy-ai')
  assert.equal(resolveVariantId('nope'), undefined)
  assert.equal(resolveVariantId(''), undefined)
  assert.equal(resolveVariantId(undefined), undefined)
})

test('variantFor is strict about unknown ids', () => {
  assert.equal(variantFor('workbuddy'), CN_VARIANT)
  assert.equal(variantFor('workbuddy-ai'), AI_VARIANT)
  assert.equal(variantFor('nope'), undefined)
  assert.deepEqual(VARIANT_IDS, ['workbuddy', 'workbuddy-ai'])
})

test('chatUserAgent names the product that owns the region', () => {
  assert.equal(chatUserAgent('5.7.7', undefined, 'cn'), 'WorkBuddy/5.7.7 WorkBuddy/5.7.7')
  assert.equal(chatUserAgent('5.7.6', undefined, REGION_GLOBAL), 'WorkBuddy/5.7.6 WorkBuddy AI/5.7.6')
})

test('chatUserAgent appends the CLI token only when one resolves', () => {
  const withCli = chatUserAgent('5.7.7', '2.63.2', 'cn')
  assert.equal(withCli, 'WorkBuddy/5.7.7 WorkBuddy/5.7.7 CLI/2.63.2')
  // A whitespace or newline in a version must never reach a header.
  assert.throws(() => chatUserAgent('5.7.7\nx', undefined, 'cn'))
  assert.throws(() => chatUserAgent('not a version', undefined, 'cn'))
})

test('the two variants point at their own upstreams', () => {
  assert.equal(CN_VARIANT.bases.chat, 'https://copilot.tencent.com')
  assert.equal(CN_VARIANT.bases.billing, 'https://www.codebuddy.cn')
  assert.equal(AI_VARIANT.bases.chat, 'https://www.workbuddy.ai')
  assert.equal(AI_VARIANT.bases.billing, 'https://www.workbuddy.ai')
})

test('the two variants never share an auth-file basename', () => {
  assert.notEqual(CN_VARIANT.desktopFilename, AI_VARIANT.desktopFilename)
  assert.notEqual(CN_VARIANT.authEnv, AI_VARIANT.authEnv)
  assert.notEqual(CN_VARIANT.electron.envVar, AI_VARIANT.electron.envVar)
})
