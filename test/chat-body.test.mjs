// Unit tests for chat-body normalization: the rules that exist because the
// upstream rejected the body without them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareChatBody, resolveUpstreamModelId, normalizeTokenLimits } from '../src/chat-body.js'

test('prepareChatBody forces stream:true', () => {
  const body = { model: 'm', stream: false, messages: [{ role: 'user', content: 'hi' }] }
  prepareChatBody(body, { global: false })
  assert.equal(body.stream, true)
})

test('developer role is rewritten to system', () => {
  const body = { messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }] }
  prepareChatBody(body, { global: false })
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].role, 'user')
})

test('tool_choice object forms are flattened to strings', () => {
  const auto = { tool_choice: { type: 'auto' } }
  prepareChatBody(auto, { global: false })
  assert.equal(auto.tool_choice, 'auto')

  const required = { tool_choice: { type: 'required' } }
  prepareChatBody(required, { global: false })
  assert.equal(required.tool_choice, 'required')

  const fn = { tool_choice: { type: 'function', function: { name: 'get_weather' } } }
  prepareChatBody(fn, { global: false })
  assert.equal(fn.tool_choice, 'get_weather')

  const none = { tool_choice: { type: 'none' }, tools: [{ type: 'function' }] }
  prepareChatBody(none, { global: false })
  assert.equal(none.tool_choice, undefined)
  assert.equal(none.tools, undefined)
})

test('tool_choice string "none" removes the tools', () => {
  const body = { tool_choice: 'none', tools: [{ type: 'function' }] }
  prepareChatBody(body, { global: false })
  assert.equal(body.tool_choice, undefined)
  assert.equal(body.tools, undefined)
})

test('the off reasoning-effort spelling is stripped on every region', () => {
  for (const global of [false, true]) {
    const body = { reasoning_effort: 'off' }
    prepareChatBody(body, { global })
    assert.equal(body.reasoning_effort, undefined)
  }
})

test('declared effort spellings pass through', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none']) {
    const body = { reasoning_effort: effort }
    prepareChatBody(body, { global: false })
    assert.equal(body.reasoning_effort, effort)
  }
})

test('the international gateway gets a system prompt prepended', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] }
  prepareChatBody(body, { global: true })
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].role, 'user')
  assert.equal(body.messages[1].content, 'hi')
})

test('an existing system prompt is not duplicated', () => {
  const body = { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] }
  prepareChatBody(body, { global: true })
  assert.equal(body.messages.length, 2)
})

test('a non-object body is returned unchanged', () => {
  assert.equal(prepareChatBody('not json', { global: false }), 'not json')
  assert.equal(prepareChatBody(null, { global: false }), null)
})

test('resolveUpstreamModelId strips the variant prefix', () => {
  assert.equal(resolveUpstreamModelId('workbuddy-ai/kimi-k3', 'workbuddy-ai'), 'kimi-k3')
  assert.equal(resolveUpstreamModelId('workbuddy/glm-5.3', 'workbuddy'), 'glm-5.3')
  assert.equal(resolveUpstreamModelId('kimi-k3', 'workbuddy-ai'), 'kimi-k3')
  assert.equal(resolveUpstreamModelId('', 'workbuddy'), '')
})

test('normalizeTokenLimits removes a zero max_tokens', () => {
  const body = { max_tokens: 0, max_completion_tokens: 0 }
  normalizeTokenLimits(body)
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.max_completion_tokens, undefined)
  const kept = { max_tokens: 100 }
  normalizeTokenLimits(kept)
  assert.equal(kept.max_tokens, 100)
})
