/**
 * The client identity a chat or catalog request presents as.
 *
 * The shape is the one the official desktop client composes —
 * `WorkBuddy/<app> <product>/<app> CLI/<cli>` — where the product token names
 * the app that owns the region's requests. Versions come from the installed App
 * when it can be read, degrade to a per-variant saved value, and finally to a
 * compiled-in constant. A CLI version that does not resolve drops the `CLI/…`
 * token instead of inventing one, which is the official client's own rule for a
 * missing extension.
 *
 * This matters functionally, not just cosmetically: the CN gateway splits its
 * model roster by User-Agent, so an invented CLI version would advertise a
 * roster this bridge cannot actually call.
 *
 * @module oc-workbuddy-connect/app-version
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { appVersionCachePathFor, ensureDir } from './cache.js'
import { resolveElectron } from './electron.js'

/**
 * @typedef {object} ClientIdentity
 * @property {string} version Desktop App version; drives the UA and `X-IDE-Version`.
 * @property {string} [cliVersion] Bundled agent-CLI version; absent drops the `CLI/…` token.
 */

/** Whether a value is an App version that may reach a header. */
export function validAppVersion(value) {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:[-+][0-9A-Za-z.]+)?$/u.test(value)
}

/**
 * Whether a value is a CLI version that may reach a header.
 *
 * Tolerates a prerelease suffix, because the bundled CLI's own metadata uses
 * that spelling; anything with whitespace, CR or LF never passes — the value
 * is interpolated into an HTTP header.
 */
export function validCliVersion(value) {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(value)
}

/**
 * The bundled agent CLI's real version.
 *
 * `cli/package.json` ships a `0.0.0` placeholder in `version` with the real
 * version in `publishConfig.customPackage.version`; a valid non-placeholder
 * `version` wins, otherwise the custom-package value applies. Unreadable or
 * invalid metadata yields `undefined` — the caller drops the token rather than
 * guessing.
 */
export async function readCliVersion(bundle) {
  let document
  try {
    document = JSON.parse(await readFile(join(bundle, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined
  if (validCliVersion(document.version) && document.version !== '0.0.0') return document.version
  const custom = document.publishConfig?.customPackage
  return validCliVersion(custom?.version) ? custom.version : undefined
}

/**
 * The Windows App version, from the installed binary's own `version` file.
 *
 * That file sits beside the exe in the same directory as `resources\app.asar`;
 * the electron resolver already validated that layout before reporting a
 * candidate, so reading its version is a measurement, not a guess.
 */
async function readWindowsVersion(variant) {
  try {
    const resolved = await resolveElectron(variant)
    return resolved.version
  } catch {
    return undefined
  }
}

/**
 * The macOS App version, from `CFBundleShortVersionString` in the located
 * bundle's `Info.plist`. The resolver already confirmed the bundle id matches
 * this product, so the path is trusted.
 */
async function readMacosVersion(variant) {
  try {
    const resolved = await resolveElectron(variant)
    const infoPath = join(dirname(dirname(resolved.path)), '..', 'Info.plist')
    const text = await readFile(infoPath, 'utf8')
    const match = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]+)<\/string>/u.exec(text)
    const value = match?.[1]?.trim()
    return validAppVersion(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Read, validate, and best-effort remember one variant's cached App version. */
async function readSavedVersion(variant) {
  try {
    const document = JSON.parse(await readFile(appVersionCachePathFor(variant), 'utf8'))
    if (typeof document === 'object' && document !== null && validAppVersion(document.version)) {
      return { version: document.version }
    }
  } catch {
    // Absent or malformed cache: fall through to the compiled-in constant.
  }
  return undefined
}

/** Best-effort memory of the installed version; losing it is not a failure. */
async function persistVersion(variant, version) {
  try {
    const path = appVersionCachePathFor(variant)
    await ensureDir(dirname(path))
    await writeFile(path, `${JSON.stringify({ version, observedAt: Date.now() }, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // Identity resolved; losing the memory of it is not a failure.
  }
}

/** Resolved identities, cached for the process. */
const identityCache = new Map()

/**
 * Resolve the client identity for one variant: installed App → saved value →
 * compiled-in fallback.
 *
 * Never throws. A missing App, an unreadable layout, or a failed cache write
 * all degrade to the fallback form, because a message must not be blocked by
 * cosmetics. The result is cached for the process, except when a reader throws
 * outright — that failure is not pinned, so a later call can resolve properly.
 *
 * @param {object} variant WorkBuddy variant descriptor.
 * @returns {Promise<ClientIdentity>}
 */
export async function resolveAppVersion(variant) {
  const cached = identityCache.get(variant.id)
  if (cached !== undefined) return cached
  let identity
  try {
    const installed = process.platform === 'darwin'
      ? await readMacosVersion(variant)
      : process.platform === 'win32' ? await readWindowsVersion(variant) : undefined
    if (installed !== undefined && validAppVersion(installed)) {
      let cli
      if (process.platform === 'darwin') {
        const resolved = await resolveElectron(variant).catch(() => undefined)
        cli = resolved?.bundle === undefined ? undefined : await readCliVersion(resolved.bundle)
      }
      identity = { version: installed, ...validCliVersion(cli) ? { cliVersion: cli } : {} }
      await persistVersion(variant, installed)
    } else {
      identity = await readSavedVersion(variant) ?? { version: variant.fallbackAppVersion }
    }
  } catch {
    // Do not pin a degraded answer for the process lifetime.
    return { version: variant.fallbackAppVersion }
  }
  identityCache.set(variant.id, identity)
  return identity
}

/** Invalidate a cached identity. Exposed for tests and for `logout`. */
export function clearAppVersionCache(variantId) {
  if (variantId === undefined) {
    identityCache.clear()
    return
  }
  identityCache.delete(variantId)
}
