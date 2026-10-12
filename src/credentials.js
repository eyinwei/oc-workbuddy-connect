/**
 * WorkBuddy credential resolution.
 *
 * The primary source is the WorkBuddy desktop app's own auth file, read-only;
 * a bridge-owned copy under the cache directory holds token refreshes, so the
 * desktop app's file is never written. When both exist the desktop file is the
 * authority on *who* is signed in, and the copy on *how fresh* the token is —
 * identity beats expiry, because after an account switch the copy still
 * belongs to the previous account and may well expire later.
 *
 * @module oc-workbuddy-connect/credentials
 */

import { readFile, rm } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  classifyDesktopAuthDocument,
  keyIdsOf,
  openAuthField,
  unwrapDesktopAuthDocument,
  CredentialReadError,
} from './at-rest.js'
import { hasCachedProtectorKey, protectorKeyFor } from './electron.js'
import { cacheDirFor } from './cache.js'
import { AI_VARIANT, CN_VARIANT, regionOf } from './variants.js'

/** Refresh this long before the access token actually expires. */
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000
/** On-disk format of the bridge-owned copy; readers reject other versions. */
const OWN_FORMAT_VERSION = 1

/**
 * @typedef {object} WorkBuddyCredential
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAtMs Epoch ms; `0` when the file carries no expiry.
 * @property {number} [refreshExpiresAtMs]
 * @property {string} domain Login domain; decides the region.
 * @property {string} uid
 * @property {string} [enterpriseId]
 * @property {string} [nickname]
 * @property {'desktop' | 'cache'} source Which store this credential came from.
 */

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function isENOENT(error) {
  return error?.code === 'ENOENT'
}

/** Path segments, relative to an AppData/XDG root, of the shared auth directory. */
const DESKTOP_AUTH_RELATIVE_PATH = ['CodeBuddyExtension', 'Data', 'Public', 'auth']

function isWsl() {
  if (process.platform !== 'linux') return false
  if (process.env.WSL_DISTRO_NAME !== undefined || process.env.WSL_INTEROP !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}

/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value) {
  const path = value?.trim()
  if (!path) return undefined
  if (path.startsWith('/')) return path
  const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drivePath === null) return undefined
  return join('/mnt', drivePath[1].toLowerCase(), ...drivePath[2].split(/[\\/]+/u))
}

/** Windows desktop credential candidates visible from a WSL process. */
function wslDesktopAuthCandidates(home) {
  const profile = windowsPathForWsl(process.env.USERPROFILE) ?? join('/mnt/c/Users', basename(home))
  const localAppData = windowsPathForWsl(process.env.LOCALAPPDATA) ?? join(profile, 'AppData', 'Local')
  const roamingAppData = windowsPathForWsl(process.env.APPDATA) ?? join(profile, 'AppData', 'Roaming')
  return [
    join(localAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
    join(roamingAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
  ]
}

/** An XDG base for one env variable, adopting an override only when absolute. */
function xdgBase(envName, fallback) {
  const value = process.env[envName]?.trim()
  if (value !== undefined && value !== '' && value.startsWith('/')) return value
  return fallback
}

function dedupe(candidates) {
  return [...new Set(candidates)]
}

/**
 * Platform-default candidates for the shared auth **directory**, in probe order.
 *
 * Windows probes both AppData roots: current builds write under Local, older
 * ones under Roaming. Linux probes both XDG bases — most distributions write
 * under the config home, UOS/deepin builds under the data home, and probing
 * only one silently reads a signed-in app as signed out. WSL probes those same
 * Windows locations through its mounted Windows profile first, so a Linux-side
 * bridge can reuse the Windows app's sign-in.
 */
export function defaultAuthDirCandidates() {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', ...DESKTOP_AUTH_RELATIVE_PATH)]
  }
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', ...DESKTOP_AUTH_RELATIVE_PATH),
      join(home, 'AppData', 'Roaming', ...DESKTOP_AUTH_RELATIVE_PATH),
    ]
  }
  if (process.platform === 'linux') {
    const configHome = xdgBase('XDG_CONFIG_HOME', join(home, '.config'))
    const dataHome = xdgBase('XDG_DATA_HOME', join(home, '.local', 'share'))
    const linux = dedupe([
      join(configHome, ...DESKTOP_AUTH_RELATIVE_PATH),
      join(dataHome, ...DESKTOP_AUTH_RELATIVE_PATH),
    ])
    return isWsl() ? dedupe([...wslDesktopAuthCandidates(home), ...linux]) : linux
  }
  return []
}

/** Platform-default auth-file candidates for one variant, in probe order. */
export function authFileCandidates(variant) {
  const fromEnv = process.env[variant.authEnv]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return [fromEnv]
  return dedupe(defaultAuthDirCandidates().map(dir => join(dir, variant.desktopFilename)))
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{…},"account":{…}}` and the flat panel form. Returns
 * `undefined` when the document carries no access token.
 *
 * @param {string} text
 * @returns {WorkBuddyCredential | undefined}
 */
export function parseCredential(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed
  const nested = typeof document.auth === 'object' && document.auth !== null
  const auth = nested ? document.auth : document
  const identity = nested
    ? (typeof document.account === 'object' && document.account !== null ? document.account : {})
    : document
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs = expiryToMs(auth.refreshExpiresAt)
  const enterpriseId = optionalString(identity.enterpriseId)
  const nickname = optionalString(identity.nickname)
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs: expiryToMs(auth.expiresAt),
    ...refreshExpiresAtMs === 0 ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth.domain) ?? '',
    uid: optionalString(identity.uid) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'desktop',
  }
}

/**
 * Parse the bridge-owned copy.
 *
 * That copy stores the *normalized* credential (camelCase `expiresAtMs`, identity
 * at the top level), not the desktop document shape. Round-tripping it through
 * {@link parseCredential} would read `expiresAt` and an `account` object, find
 * neither, zero the expiry, and drop the identity headers — so it has its own
 * parser.
 */
function parseOwnDocument(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  if (parsed.version !== OWN_FORMAT_VERSION) return undefined
  const stored = parsed.credential
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return undefined
  const accessToken = typeof stored.accessToken === 'string' ? stored.accessToken : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs = typeof stored.refreshExpiresAtMs === 'number' ? stored.refreshExpiresAtMs : undefined
  const enterpriseId = optionalString(stored.enterpriseId)
  const nickname = optionalString(stored.nickname)
  return {
    accessToken,
    refreshToken: typeof stored.refreshToken === 'string' ? stored.refreshToken : '',
    expiresAtMs: typeof stored.expiresAtMs === 'number' ? stored.expiresAtMs : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(stored.domain) ?? '',
    uid: optionalString(stored.uid) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'cache',
  }
}

function ownDocument(credential) {
  return { version: OWN_FORMAT_VERSION, credential }
}

/**
 * Read-only credential store with demand-driven refresh.
 *
 * Refresh only when the access token is inside the margin (or already
 * expired), keep the refreshed credential in the bridge-owned copy, and never
 * write the desktop app's file. A failed refresh still returns a
 * not-yet-expired token, so an unreachable refresh endpoint does not take down
 * a working session.
 */
export class CredentialStore {
  #variant
  #refresh
  #refreshMarginMs
  #ownPath
  #keyIds
  #inflight

  /**
   * @param {object} options
   * @param {object} options.variant WorkBuddy variant descriptor.
   * @param {(credential: WorkBuddyCredential) => Promise<object>} options.refresh Upstream token refresh.
   * @param {number} [options.refreshMarginMs]
   * @param {string} [options.ownPath] Override the bridge-owned copy path.
   */
  constructor({ variant, refresh, refreshMarginMs = DEFAULT_REFRESH_MARGIN_MS, ownPath }) {
    this.#variant = variant
    this.#refresh = refresh
    this.#refreshMarginMs = refreshMarginMs
    this.#ownPath = ownPath ?? join(cacheDirFor(variant), 'credential.json')
    // The key ids the current cached key is known to open. Re-resolved when an
    // envelope names one that is not here — which is what happens after the app
    // reseals its sign-in under a fresh key.
    this.#keyIds = null
  }

  get variant() {
    return this.#variant
  }

  /** The resolved desktop auth-file path, for diagnostics. */
  authFilePath() {
    return authFileCandidates(this.#variant)[0]
  }

  /** The bridge-owned copy path, for diagnostics. */
  cachePath() {
    return this.#ownPath
  }

  /**
   * Read the freshest stored credential without refreshing anything.
   *
   * @returns {Promise<WorkBuddyCredential | undefined>}
   */
  async current() {
    const [desktop, own] = await Promise.all([this.#readDesktop(), this.#readOwn()])
    // A credential belonging to the other product is refused rather than used:
    // the two apps share one auth directory and differ only by filename, so a
    // misconfigured `WORKBUDDY_AI_AUTH_FILE` is a realistic mistake, and
    // sending one region's token to the other's endpoint would leak it across
    // products.
    for (const [label, credential] of [['auth file', desktop], ['cached copy', own]]) {
      if (credential === undefined) continue
      const region = regionOf(credential.domain)
      if (region !== this.#variant.region) {
        throw new CredentialReadError(
          'credential-region-mismatch',
          `${this.#variant.displayName} received a ${region === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'} credential`
          + ` in its ${label} (domain ${JSON.stringify(credential.domain)});`
          + ` point ${this.#variant.authEnv} at the ${this.#variant.appName} sign-in, or remove the mismatched file`,
        )
      }
    }
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    // Identity beats expiry: see the module comment.
    if (desktop.uid !== own.uid || desktop.enterpriseId !== own.enterpriseId) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  async resolve() {
    const credential = await this.current()
    if (credential === undefined) {
      const candidates = authFileCandidates(this.#variant)
      const desktop = candidates.length > 0 ? candidates.join(' or ') : '(no auth-file path on this platform)'
      throw new CredentialReadError(
        'no-credential',
        `no signed-in ${this.#variant.appName} account found; sign in once in the ${this.#variant.appName} desktop app`
        + ` (expected ${desktop}, or point ${this.#variant.authEnv} at it), or run \`wb-connect login\``,
      )
    }
    if (!this.#needsRefresh(credential)) return credential
    this.#inflight ??= this.#refreshNow(credential).finally(() => {
      this.#inflight = undefined
    })
    return await this.#inflight
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status() {
    try {
      const credential = await this.current()
      if (credential === undefined) {
        return { state: 'signed-out', reasonCode: 'no-credential', authFile: this.authFilePath() }
      }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        source: credential.source,
        authFile: this.authFilePath(),
      }
    } catch (error) {
      // A region mismatch (or an unreadable file, or an unusable key helper) is
      // a *diagnosable* signed-out state, not a silent one.
      return {
        state: 'signed-out',
        reason: error instanceof Error ? error.message : String(error),
        ...error instanceof CredentialReadError ? { reasonCode: error.code } : {},
        authFile: this.authFilePath(),
      }
    }
  }

  /** Remove the bridge-owned copy. The desktop app's file is untouched. */
  async logout() {
    await rm(this.#ownPath, { force: true })
  }

  #needsRefresh(credential) {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.#refreshMarginMs >= credential.expiresAtMs
  }

  async #refreshNow(credential) {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new CredentialReadError(
        'no-refresh-token',
        `the ${this.#variant.appName} access token expired and no refresh token is stored;`
        + ` sign in again in the ${this.#variant.appName} desktop app`,
      )
    }
    try {
      const outcome = await this.#refresh(credential)
      const refreshed = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresInSec === undefined
          ? credential.expiresAtMs
          : Date.now() + outcome.expiresInSec * 1000,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
        source: 'cache',
      }
      await this.#saveOwn(refreshed)
      return refreshed
    } catch (error) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new CredentialReadError(
        'refresh-failed',
        `${this.#variant.id} token refresh failed and the access token is expired`
        + ` (${error instanceof Error ? error.message : String(error)});`
        + ` open the ${this.#variant.appName} desktop app once to sign in again`,
      )
    }
  }

  async #saveOwn(credential) {
    const { writeFileAtomic } = await import('node:fs/promises')
    await writeFileAtomic(this.#ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  async #readOwn() {
    try {
      return parseOwnDocument(await readFile(this.#ownPath, 'utf8'))
    } catch {
      return undefined
    }
  }

  /**
   * Read the first desktop candidate that exists.
   *
   * Only an absent file falls through to the next candidate; a file that is
   * present but unparsable is authoritative for its slot, so a stale older
   * version never silently wins over a broken newer one. The desktop file is
   * the identity authority, so a document this bridge cannot read surfaces as a
   * diagnosis rather than being papered over by the bridge-owned copy.
   */
  async #readDesktop() {
    for (const authFile of authFileCandidates(this.#variant)) {
      let text
      try {
        text = await readFile(authFile, 'utf8')
      } catch (error) {
        if (isENOENT(error)) continue
        throw error
      }
      const classification = classifyDesktopAuthDocument(text)
      if (classification.format === 'plaintext') return parseCredential(text)
      if (classification.format === 'absent') continue
      if (classification.format === 'unrecognized') {
        throw new CredentialReadError(
          'auth-file-unreadable',
          `the auth file at ${authFile} exists but is unreadable`
          + ' (neither a plaintext credential nor a decodable WorkBuddy 5.6 envelope);'
          + ' fix or remove the file — it outranks the bridge-owned credential copy',
        )
      }
      return await this.#openEncrypted(classification, authFile)
    }
    return undefined
  }

  /** Open a 5.6 encrypted desktop document into the regular credential shape. */
  async #openEncrypted(classification, authFile) {
    const fields = classification.wrapped.fields
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const key = await protectorKeyFor(this.#variant)
      const wanted = keyIdsOf(fields)
      // A cached key from a previous sign-in will not open the new envelopes.
      if (this.#keyIds !== null && wanted.every(id => this.#keyIds.includes(id))) {
        try {
          return parseCredential(unwrapDesktopAuthDocument(classification, wrapped => openAuthField(key, wrapped.envelope)))
        } catch (error) {
          if (!(error instanceof CredentialReadError) || !/key id/u.test(error.message)) throw error
        }
      }
      this.#keyIds = wanted
      try {
        return parseCredential(unwrapDesktopAuthDocument(classification, wrapped => openAuthField(key, wrapped.envelope)))
      } catch (error) {
        if (attempt === 1 || !(error instanceof CredentialReadError)) throw error
        // Re-resolve once: the app may have resealed its sign-in under a key we
        // resolved before it did.
        ;(await import('./electron.js')).clearProtectorKeyCache(this.#variant.id)
      }
    }
    throw new CredentialReadError(
      'encrypted-credential-unreadable',
      `the encrypted auth file at ${authFile} could not be opened after re-resolving the at-rest key;`
      + ` open the ${this.#variant.appName} desktop app once to reseal the sign-in`,
    )
  }
}

export { AI_VARIANT, CN_VARIANT, hasCachedProtectorKey, dirname }
