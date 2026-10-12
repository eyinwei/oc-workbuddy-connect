/**
 * WorkBuddy 5.6.x at-rest credential protection: envelope classification and
 * field decryption.
 *
 * Since WorkBuddy 5.6 both desktop apps encrypt `auth.accessToken` and
 * `auth.refreshToken` at rest, so a sign-in file carries
 * `{$wbEncrypted: 1, envelope}` wrappers instead of token strings. Opening them
 * needs two things, and only the first is cryptographic:
 *
 *   1. the sealed payload `{version: 1, atRestSecretKey}`, which only the
 *      WorkBuddy-modified Electron binary can produce (see `electron.js`);
 *   2. `protectorKey = sha256(atRestSecretKey, utf8)`, which opens the
 *      envelopes with AES-256-GCM under the AAD built by
 *      {@link buildAuthenticatedContextAad}.
 *
 * The AAD builder is transcribed from the app bundle's own
 * `buildAuthenticatedContextAad` and verified live against 5.6.2/5.7.x.
 * Credential fields are always suite 1 under the `field` framing (WBEV1);
 * the framing family's other members (WBEF1/WBER1/WBES1) belong to other
 * document kinds and are deliberately not implemented — opening a field is not
 * a place to guess at future formats.
 *
 * Nothing here logs or returns envelope or token content. Error messages
 * carry field names, key ids, and sizes only.
 *
 * @module oc-workbuddy-connect/at-rest
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/** The fields WorkBuddy 5.6+ seals. */
export const AUTH_FIELDS = ['accessToken', 'refreshToken']

/**
 * A single decoded envelope.
 *
 * @typedef {object} WorkBuddyEnvelope
 * @property {number} suite Encryption suite; `1` for credential fields.
 * @property {string} keyId Envelope key id, also part of the AAD.
 * @property {Buffer} nonce 12-byte GCM nonce.
 * @property {Buffer} authTag 16-byte GCM tag.
 * @property {Buffer} ciphertext Sealed plaintext.
 */

/** Raised when a desktop credential exists but cannot be opened. */
export class CredentialReadError extends Error {
  /**
   * @param {string} code Stable, machine-readable cause.
   * @param {string} message Operator-facing explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'CredentialReadError'
    this.code = code
  }
}

/** Decode strict base64, rejecting input Node would otherwise silently repair. */
function parseBase64(value, expectedLength) {
  if (typeof value !== 'string' || value === '') return undefined
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) return undefined
  if (expectedLength !== undefined && decoded.length !== expectedLength) return undefined
  return decoded
}

/**
 * Whether a raw value is the 5.6 field wrapper with a decodable envelope.
 *
 * A value that claims the flag but whose envelope will not decode is reported
 * as `undefined` here, which makes the whole document `unrecognized` rather
 * than `encrypted` — no key could ever open it.
 */
function parseWrappedField(field, value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const wrapped = value
  if (wrapped.$wbEncrypted !== 1 || typeof wrapped.envelope !== 'string') return undefined
  let inner
  try {
    inner = JSON.parse(Buffer.from(wrapped.envelope, 'base64').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return undefined
  const nonce = parseBase64(inner.nonce, 12)
  const authTag = parseBase64(inner.authTag, 16)
  const ciphertext = parseBase64(inner.ciphertext)
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined
  if (typeof inner.suite !== 'number' || !Number.isInteger(inner.suite)) return undefined
  if (typeof inner.keyId !== 'string' || inner.keyId === '') return undefined
  return { field, envelope: { suite: inner.suite, keyId: inner.keyId, nonce, authTag, ciphertext } }
}

/**
 * Classify a raw desktop auth document.
 *
 * @param {string} text File contents.
 * @returns {{format: 'absent'} | {format: 'plaintext'} | {format: 'encrypted', wrapped: {document: object, fields: Array<object>}} | {format: 'unrecognized'}}
 */
export function classifyDesktopAuthDocument(text) {
  if (typeof text !== 'string' || text.trim() === '') return { format: 'absent' }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { format: 'unrecognized' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { format: 'unrecognized' }
  const document = parsed
  const auth = typeof document.auth === 'object' && document.auth !== null ? document.auth : document
  const fields = []
  for (const field of AUTH_FIELDS) {
    const value = auth[field]
    if (typeof value === 'string') continue
    const wrapped = parseWrappedField(field, value)
    // A present-but-not-a-wrapper value is neither plaintext nor usable.
    if (wrapped === undefined && value !== undefined) return { format: 'unrecognized' }
    if (wrapped !== undefined) fields.push(wrapped)
  }
  if (fields.length === 0) return { format: 'plaintext' }
  return { format: 'encrypted', wrapped: { document, fields } }
}

/** Distinct key ids across the wrapped fields, in field order. */
export function keyIdsOf(fields) {
  return [...new Set(fields.map(wrapped => wrapped.envelope.keyId))]
}

/**
 * The authenticated-context AAD for one field envelope.
 *
 * Transcribed from the app bundle's `buildAuthenticatedContextAad`:
 * `WB-AAD\0` framing, version byte, two length-prefixed labels (`WBEV1` for the
 * field document kind, `sym-v1` for the symmetric suite), the big-endian
 * suite number, the length-prefixed key id, the `field` context marker, and
 * two zero sequence-number bytes (credential fields carry none; the trailing
 * zero mirrors the reference script's default context).
 *
 * @param {string} keyId Envelope key id.
 * @param {number} suite Envelope suite; `1` for credential fields.
 * @returns {Buffer}
 */
export function buildAuthenticatedContextAad(keyId, suite) {
  const lengthPrefixed = (value) => {
    const bytes = Buffer.from(value, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/**
 * Seal one field with the exact format {@link openAuthField} reads.
 *
 * A test helper, exported because the round-trip is the only way to be sure the
 * builder and the opener agree on every byte — a hand-rolled envelope in each
 * test would let the two drift apart silently.
 *
 * @param {Buffer} key 32-byte protector key.
 * @param {string} plaintext
 * @param {number} [suite]
 * @returns {{'$wbEncrypted': 1, envelope: string}}
 */
export function sealAuthFieldForTest(key, plaintext, suite = 1) {
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(buildAuthenticatedContextAad(keyId, suite))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const inner = {
    suite,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64') }
}

/**
 * Open one envelope with a protector key.
 *
 * Returns `undefined` rather than throwing when the envelope will not open: a
 * wrong key, a different suite, or a tampered file all surface the same way,
 * and the caller turns that into one actionable diagnosis.
 *
 * @param {Buffer} key 32-byte protector key.
 * @param {WorkBuddyEnvelope} envelope
 * @returns {string | undefined}
 */
export function openAuthField(key, envelope) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Validate the key helper's payload against the app's own rules: `version: 1`
 * and a canonical-base64, 32-byte, non-all-zero secret.
 *
 * @param {string} text Helper stdout.
 * @returns {{atRestSecretKey: string} | undefined}
 */
export function parseAtRestPayload(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  if (parsed.version !== 1) return undefined
  const secret = parsed.atRestSecretKey
  if (typeof secret !== 'string' || secret === '') return undefined
  const decoded = Buffer.from(secret, 'base64')
  if (decoded.length !== 32) return undefined
  if (decoded.toString('base64') !== secret) return undefined
  if (decoded.every(byte => byte === 0)) return undefined
  return { atRestSecretKey: secret }
}

/** Derive the protector key from the sealed secret: sha256 over its UTF-8 string. */
export function deriveProtectorKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/**
 * Open every wrapped field of a classified document and return the plaintext
 * JSON text the credential parser reads.
 *
 * Reuses the original document so identity and expiry fields need no second
 * parsing path — only the sealed fields are replaced.
 *
 * @param {{format: 'encrypted', wrapped: {document: object, fields: Array<object>}}} classification
 * @param {(field: object) => string} openField
 * @returns {string}
 */
export function unwrapDesktopAuthDocument(classification, openField) {
  const { document, fields } = classification.wrapped
  const rebuilt = structuredClone(document)
  const auth = typeof rebuilt.auth === 'object' && rebuilt.auth !== null ? rebuilt.auth : rebuilt
  for (const wrapped of fields) {
    const plaintext = openField(wrapped)
    if (plaintext === undefined) {
      throw new CredentialReadError(
        'encrypted-credential-unreadable',
        `the encrypted desktop credential's ${wrapped.field} could not be decrypted`
        + ` (envelope key id ${wrapped.envelope.keyId});`
        + ' the WorkBuddy app may hold a different at-rest key — open it once to reseal the sign-in',
      )
    }
    auth[wrapped.field] = plaintext
  }
  return JSON.stringify(rebuilt)
}
