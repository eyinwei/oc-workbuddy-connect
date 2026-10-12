// Unit tests for SSE chunk merging: the non-streaming path depends on this
// being faithful, and two upstream quirks have to be normalized.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectCompletion, mergeChunks, parseSseBody } from '../src/sse.js'

test('mergeChunks concatenates content and reasoning', () => {
  const completion = mergeChunks([
    { id: 'c1', created: 100, model: 'glm-5.3', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] },
    { choices: [{ index: 0, delta: { content: 'lo' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: 'think' } }] },
  ])
  assert.equal(completion.id, 'c1')
  assert.equal(completion.created, 100)
  assert.equal(completion.model, 'glm-5.3')
  assert.equal(completion.choices[0].message.content, 'Hello')
  assert.equal(completion.choices[0].message.reasoning, 'think')
  assert.equal(completion.choices[0].message.reasoning_content, 'think')
  assert.equal(completion.choices[0].finish_reason, 'stop')
})

test('tool calls are merged by index', () => {
  const completion = mergeChunks([
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weath' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Beijing"}' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'get_time' } }] } }] },
  ])
  const calls = completion.choices[0].message.tool_calls
  assert.equal(calls.length, 2)
  assert.equal(calls[0].id, 'call_1')
  assert.equal(calls[0].function.name, 'get_weath')
  assert.equal(calls[0].function.arguments, '{"city":"Beijing"}')
  assert.equal(calls[1].function.name, 'get_time')
  assert.equal(completion.choices[0].finish_reason, 'tool_calls')
})

test('the legacy function_call spelling is merged into tool_calls', () => {
  const completion = mergeChunks([
    { choices: [{ index: 0, delta: { function_call: { name: 'get_weather' } } }] },
    { choices: [{ index: 0, delta: { function_call: { arguments: '{"city":"X"}' } } }] },
  ])
  const calls = completion.choices[0].message.tool_calls
  assert.equal(calls.length, 1)
  assert.equal(calls[0].function.name, 'get_weather')
  assert.equal(calls[0].function.arguments, '{"city":"X"}')
  assert.equal(completion.choices[0].finish_reason, 'tool_calls')
})

test('an empty function_call object does not create a phantom call', () => {
  // The upstream emits this as a terminator on every text-only reply.
  const completion = mergeChunks([
    { choices: [{ index: 0, delta: { content: 'Hi', function_call: null } }] },
    { choices: [{ index: 0, delta: { function_call: { name: '', arguments: '' } } }] },
    { choices: [{ index: 0, delta: { finish_reason: 'stop' } }] },
  ])
  assert.equal(completion.choices[0].message.content, 'Hi')
  assert.equal(completion.choices[0].message.tool_calls, undefined)
  assert.equal(completion.choices[0].finish_reason, 'stop')
})

test('usage and finish reason survive', () => {
  // finish_reason sits on the choice, not inside the delta.
  const completion = mergeChunks([
    { choices: [{ index: 0, delta: { content: 'x' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5, credit: 0.01 } },
  ])
  assert.equal(completion.choices[0].finish_reason, 'length')
  assert.deepEqual(completion.usage, { prompt_tokens: 10, completion_tokens: 5, credit: 0.01 })
})

test('an empty stream still yields a well-formed completion', () => {
  const completion = mergeChunks([])
  assert.equal(completion.object, 'chat.completion')
  assert.equal(completion.choices[0].message.role, 'assistant')
  assert.equal(completion.choices[0].finish_reason, 'stop')
})

test('parseSseBody skips heartbeats and [DONE]', () => {
  const text = [
    ': heartbeat',
    'data: {"id":"1","choices":[{"index":0,"delta":{"content":"a"}}]}',
    '',
    'data: {"id":"1","choices":[{"index":0,"delta":{"content":"b"}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const chunks = parseSseBody(text)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].choices[0].delta.content, 'a')
})

test('parseSseBody tolerates CRLF and non-JSON frames', () => {
  const text = ': ping\r\ndata: {"a":1}\r\n\r\ndata: not json\r\n\r\ndata: [DONE]\r\n'
  const chunks = parseSseBody(text)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].a, 1)
})

test('collectCompletion reads a real Response stream', async () => {
  const payload = [
    'data: {"id":"1","created":5,"model":"m","choices":[{"index":0,"delta":{"content":"Hi"}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const response = new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } })
  const completion = await collectCompletion(response, { model: 'fallback' })
  assert.equal(completion.choices[0].message.content, 'Hi')
  assert.equal(completion.model, 'm')
})

test('collectCompletion names the fallback model when no chunk carries one', async () => {
  const response = new Response('data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n')
  const completion = await collectCompletion(response, { model: 'fallback' })
  assert.equal(completion.model, 'fallback')
})

test('collectCompletion throws on a response with no body', async () => {
  await assert.rejects(() => collectCompletion(new Response(null)), /no body/)
})
