// Unit tests for the OpenCode config writer: JSONC parsing, provider blocks,
// and the merge that must leave a user's unrelated settings alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProviders,
  mergeProviders,
  parseJsonc,
  providerBlock,
  removeProviders,
} from '../src/opencode-config.js'
import { AI_VARIANT, CN_VARIANT } from '../src/variants.js'

test('parseJsonc accepts comments and trailing commas', () => {
  const text = `{
    // a comment
    "model": "a/b",   /* block */
    "providers": { "x": {}, },
  }`
  const parsed = parseJsonc(text)
  assert.equal(parsed.model, 'a/b')
  assert.deepEqual(parsed.providers, { x: {} })
})

test('parseJsonc rejects a real syntax error', () => {
  assert.throws(() => parseJsonc('{ "a": , }'), SyntaxError)
})

test('providerBlock builds the OpenAI-compatible shape', () => {
  const models = [{
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 128000, maxOutputTokens: 8192,
    supportsImages: true, supportsToolCall: true,
    reasoning: { supports: true, supportedEfforts: ['low', 'high'], defaultEffort: 'high' },
    credits: 'x0.79',
  }]
  const block = providerBlock(CN_VARIANT, models, { baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'k' })
  assert.equal(block.package, '@opencode/ai/providers/openai-compatible')
  assert.equal(block.settings.baseURL, 'http://127.0.0.1:8787/v1')
  assert.equal(block.settings.apiKey, 'k')
  assert.equal(block.headers['x-workbuddy-variant'], 'workbuddy')
  assert.equal(block.models['glm-5.3'].limit.context, 128000)
  assert.deepEqual(block.models['glm-5.3'].capabilities.input, { text: true, image: true })
  // Effort variants are generated from the upstream's declared set.
  assert.deepEqual(block.models['glm-5.3'].variants.map(v => v.id), ['low', 'high'])
  // A fabricated cost would be worse than none: WorkBuddy meters in credits.
  assert.equal('cost' in block.models['glm-5.3'], false)
})

test('image capability requires support', () => {
  const models = [{ id: 't', name: 'T', contextWindow: 1000, maxOutputTokens: 100, supportsImages: false, supportsToolCall: false }]
  const block = providerBlock(AI_VARIANT, models, { baseURL: 'u' })
  assert.deepEqual(block.models['t'].capabilities.input, { text: true, image: false })
  assert.deepEqual(block.models['t'].capabilities.output, { text: true, image: false })
  assert.equal('tool_call' in block.models['t'].capabilities, false)
})

test('mergeProviders only touches the managed ids', () => {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: 'opencode/gpt-5.2',
    theme: 'dark',
    providers: {
      workbuddy: { name: 'OLD' },
      anthropic: { name: 'Anthropic' },
    },
  }
  const providers = buildProviders(new Map([['workbuddy', { variant: CN_VARIANT, models: [] }]]), { baseURL: 'u' })
  const { config: next, changed } = mergeProviders(config, providers)
  assert.deepEqual(changed, ['workbuddy'])
  assert.equal(next.model, 'opencode/gpt-5.2')
  assert.equal(next.theme, 'dark')
  assert.equal(next.providers.anthropic.name, 'Anthropic')
  assert.equal(next.providers.workbuddy.name, 'WorkBuddy')
  assert.notEqual(next, config, 'the input is not mutated')
})

test('mergeProviders writes the schema when absent', () => {
  const { config } = mergeProviders({}, buildProviders(new Map(), { baseURL: 'u' }))
  assert.equal(config.$schema, 'https://opencode.ai/config.json')
})

test('mergeProviders reports no change for an identical block', () => {
  const providers = buildProviders(new Map([['workbuddy', { variant: CN_VARIANT, models: [] }]]), { baseURL: 'u' })
  const once = mergeProviders({}, providers)
  const twice = mergeProviders(once.config, providers)
  assert.deepEqual(twice.changed, [])
})

test('an empty providers map is pruned rather than written empty', () => {
  const { config } = mergeProviders({ providers: {} }, buildProviders(new Map(), { baseURL: 'u' }))
  assert.equal('providers' in config, false)
})

test('defaultModel is applied only when asked', () => {
  const providers = buildProviders(new Map(), { baseURL: 'u' })
  assert.equal('model' in mergeProviders({}, providers).config, false)
  const withDefault = mergeProviders({}, providers, { defaultModel: 'workbuddy/glm-5.3' })
  assert.equal(withDefault.config.model, 'workbuddy/glm-5.3')
  assert.equal(withDefault.defaultModelChanged, true)
})

test('removeProviders drops only the managed ids', () => {
  const config = { providers: { workbuddy: {}, 'workbuddy-ai': {}, anthropic: {} } }
  const { config: next, removed } = removeProviders(config)
  assert.deepEqual(removed, ['workbuddy', 'workbuddy-ai'])
  assert.deepEqual(Object.keys(next.providers), ['anthropic'])
})

test('removeProviders on a config without providers is a no-op', () => {
  assert.deepEqual(removeProviders({ model: 'a/b' }).removed, [])
})
