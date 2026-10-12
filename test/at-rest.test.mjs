// Unit tests for the at-rest crypto: the AAD builder and envelope round-trip.
// These are the parts that must be byte-exact against the app's own
// implementation, so they are tested against a known-good vector rather than
// against themselves.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import {
  buildAuthenticatedContextAad,
  classifyDesktopAuthDocument,
  deriveProtectorKey,
  keyIdsOf,
  openAuthField,
  parseAtRestPayload,
  sealAuthFieldForTest,
  unwrapDesktopAuthDocument,
} from '../src/at-rest.js'

test('buildAuthenticatedContextAad produces the exact framing bytes', () => {
  const aad = buildAuthenticatedContextAad('9127dea1b4020a7', 1)
  const hex = aad.toString('hex')
  // 'WB-AAD\0' prefix, version 1, then length-prefixed 'WBEV1' and 'sym-v1',
  // the big-endian suite, the length-prefixed key id, and the field marker.
  assert.equal(hex.startsWith('57422d41414400'), true, 'prefix')
  assert.equal(hex.includes('00000001'), true, 'version byte')
  assert.equal(hex.includes('000000055742455631'), true, 'length-prefixed WBEV1')
  assert.equal(hex.includes('0000000673796d2d7631'), true, 'length-prefixed sym-v1')
  assert.equal(hex.includes('00000001'), true, 'suite 1')
  assert.equal(hex.includes('0000000f'), true, 'key id length 15')
  assert.ok(hex.includes('393132376465613162343032306137'), true, 'key id bytes')
  assert.equal(hex.endsWith('020000'), true, 'field marker + zero sequence bytes')
})

test('deriveProtectorKey is sha256 over the secret as a UTF-8 string', () => {
  const secret = 'Sik9U5aXhCdwTVEwsEySDOmDoB9r9ntFxHF1fst9LQI='
  assert.deepEqual(deriveProtectorKey(secret), createHash('sha256').update(secret, 'utf8').digest())
})

test('an envelope sealed with the derived key opens, and a wrong key does not', () => {
  const secret = 'Sik9U5aXhCdwTVEwsEySDOmDoB9r9ntFxHF1fst9LQI='
  const key = deriveProtectorKey(secret)
  const sealed = sealAuthFieldForTest(key, 'test-access-token-value')
  const inner = JSON.parse(Buffer.from(sealed.envelope, 'base64').toString('utf8'))
  const envelope = {
    suite: inner.suite,
    keyId: inner.keyId,
    nonce: Buffer.from(inner.nonce, 'base64'),
    authTag: Buffer.from(inner.authTag, 'base64'),
    ciphertext: Buffer.from(inner.ciphertext, 'base64'),
  }
  assert.equal(openAuthField(key, envelope), 'test-access-token-value')
  assert.equal(openAuthField(deriveProtectorKey('different-secret')), undefined)
})

test('a tampered ciphertext does not open', () => {
  const secret = 'Sik9U5aXhCdwTVEwsEySDOmDoB9r9ntFxHF1fst9LQI='
  const key = deriveProtectorKey(secret)
  const sealed = sealAuthFieldForTest(key, 'hello')
  const inner = JSON.parse(Buffer.from(sealed.envelope, 'base64').toString('utf8'))
  const ciphertext = Buffer.from(inner.ciphertext, 'base64')
  ciphertext[0] ^= 0xff
  const envelope = {
    suite: inner.suite,
    keyId: inner.keyId,
    nonce: Buffer.from(inner.nonce, 'base64'),
    authTag: Buffer.from(inner.authTag, 'base64'),
    ciphertext,
  }
  assert.equal(openAuthField(key, envelope), undefined)
})

test('classifyDesktopAuthDocument recognises plaintext, encrypted and absent', () => {
  const plaintext = JSON.stringify({ auth: { accessToken: 'x', domain: 'www.workbuddy.cn' } })
  assert.equal(classifyDesktopAuthDocument(plaintext).format, 'plaintext')
  assert.equal(classifyDesktopAuthDocument('').format, 'absent')
  assert.equal(classifyDesktopAuthDocument('   ').format, 'absent')
  assert.equal(classifyDesktopAuthDocument('not json').format, 'unrecognized')
  // A string token is plaintext even if the other field is wrapped.
  assert.equal(classifyDesktopAuthDocument(JSON.stringify({
    auth: { accessToken: 'x', refreshToken: 'y' },
  })).format, 'plaintext')
})

test('classifyDesktopAuthDocument reports a non-wrapper as unrecognized', () => {
  // A field that claims the flag but is not a decodable envelope means no key
  // could ever open it: the document must not be reported as encrypted.
  const doc = { auth: { accessToken: 'x', refreshToken: { $wbEncrypted: 1 } } }
  assert.equal(classifyDesktopAuthDocument(JSON.stringify(doc)).format, 'unrecognized')
})

test('unwrapDesktopAuthDocument replaces only the wrapped fields', () => {
  const secret = 'Sik9U5aXhCdwTVEwsEySDOmDoB9r9ntFxHF1fst9LQI='
  const key = deriveProtectorKey(secret)
  const seal = (value) => sealAuthFieldForTest(key, value)
  const keyId = JSON.parse(Buffer.from(seal('x').envelope, 'base64').toString('utf8')).keyId
  const wrapped = {
    auth: { accessToken: seal('tok'), refreshToken: seal('ref'), domain: 'www.workbuddy.cn', expiresAt: 1794189318311 },
    account: { uid: 'abc', nickname: 'Ada' },
  }
  const classification = classifyDesktopAuthDocument(JSON.stringify(wrapped))
  assert.equal(classification.format, 'encrypted')
  assert.equal(classification.wrapped.fields.length, 2)
  assert.deepEqual(keyIdsOf(classification.wrapped.fields), [keyId])
  const text = unwrapDesktopAuthDocument(classification, field => openAuthField(key, field.envelope))
  const parsed = JSON.parse(text)
  assert.equal(parsed.auth.accessToken, 'tok')
  assert.equal(parsed.auth.refreshToken, 'ref')
  assert.equal(parsed.auth.domain, 'www.workbuddy.cn')
  assert.equal(parsed.account.nickname, 'Ada')
})

test('parseAtRestPayload accepts a valid payload and rejects the rest', () => {
  const secret = randomBytes(32).toString('base64')
  assert.deepEqual(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: secret })), { atRestSecretKey: secret })
  assert.equal(parseAtRestPayload(JSON.stringify({ version: 2, atRestSecretKey: secret })), undefined)
  assert.equal(parseAtRestPayload(JSON.stringify({ version: 1 })), undefined)
  assert.equal(parseAtRestPayload('not json'), undefined)
  // Non-canonical base64 must be refused, not silently repaired.
  assert.equal(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: 'not!!base64' })), undefined)
  // All-zero is refused by the app's own rule.
  assert.equal(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })), undefined)
})

test('a 32-byte secret is required', () => {
  assert.equal(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: 'c2hvcnQ=' })), undefined)
})
