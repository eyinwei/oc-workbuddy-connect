/**
 * Locating the WorkBuddy Electron binary, and asking it for the at-rest key.
 *
 * The bridge runs in Node, not in the WorkBuddy-modified Electron, so it can
 * never call `_linkedBinding` itself. The binary is therefore spawned **once**,
 * with `ELECTRON_RUN_AS_NODE=1`, running a one-liner that prints the binding's
 * sealed payload to stdout and nothing else.
 *
 * Discovery is deliberately product-scoped. Two products on one machine share
 * an auth directory and can be installed side by side; each is identified by
 * its own bundle id / registry record / exe basename, so a search that matches
 * one can never legitimately execute the other's binary. Where no layout has
 * been measured (Linux today) discovery stays off and only an explicit
 * environment variable works.
 *
 * @module oc-workbuddy-connect/electron
 */

import { execFile } from 'node:child_process'
import { accessSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { deriveProtectorKey, parseAtRestPayload } from './at-rest.js'

/** The helper one-liner. Prints the payload; never logs or throws the key. */
const HELPER_SCRIPT = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'
const HELPER_SCRIPT_FLAG = '-e'

/** Per-discovery-step timeout; macOS `mdfind` and Windows registry reads. */
const DISCOVERY_STEP_TIMEOUT_MS = 3_000
/** How long the spawned helper may take before it is killed. */
const HELPER_TIMEOUT_MS = 30_000

/** Absolute tool paths: never resolved through PATH, which a user can change. */
const MDFIND_BIN = '/usr/bin/mdfind'
const PLUTIL_BIN = '/usr/bin/plutil'
const WINDOWS_REGISTRY_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]
const WINDOWS_REGISTRY_OUTPUT_MAX_BYTES = 4 * 1024 * 1024
const WINDOWS_ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error !== null && error !== undefined) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function isExecutable(path) {
  try {
    accessSync(path, 0x1)
    return true
  } catch {
    return false
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Read a `version` file's first trimmed line. */
function readVersionFile(path) {
  if (!isFile(path)) return undefined
  try {
    const text = readFileSync(path, 'utf8')
    const first = text.split(/\r?\n/u)[0]?.trim()
    return first === undefined || first === '' ? undefined : first
  } catch {
    return undefined
  }
}

/**
 * A plausible Windows Electron exe: a valid `version` file and
 * `resources\app.asar` in the same directory. Executing an arbitrary exe named
 * by a registry value would be trusting an uninstall record as executable
 * content; this layout check is what makes a registry candidate safe to run.
 */
function inspectWindowsElectronCandidate(exePath) {
  const dir = dirname(exePath)
  if (!isDirectory(join(dir, 'resources'))) return undefined
  if (!isFile(join(dir, 'resources', 'app.asar'))) return undefined
  // The version file holds the Electron version, not the product's own, so it
  // is only evidence that this directory really is an Electron app.
  const electronVersion = readVersionFile(join(dir, 'version')) ?? readVersionFile(join(dir, 'resources', 'version'))
  if (electronVersion === undefined) return undefined
  return { path: exePath, electronVersion, dir }
}

/**
 * Which automatic discovery a platform may run.
 *
 * `none` stays the safe default wherever no layout has been measured.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {'none' | 'macos' | 'windows'}
 */
export function electronDiscoveryFor(platform = process.platform) {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  return 'none'
}

/** The verified per-platform default path, when the product has one. */
export function defaultElectronPath(electron) {
  if (process.platform === 'darwin') {
    return join('/Applications', `${electron.macOS.appName}.app`, 'Contents', 'MacOS', 'Electron')
  }
  if (process.platform !== 'win32' || electron.windows.defaultPathSegments === undefined) return undefined
  const localAppData = process.env.LOCALAPPDATA?.trim()
  return localAppData === undefined || localAppData === ''
    ? undefined
    : join(localAppData, ...electron.windows.defaultPathSegments)
}

/** `kMDItemCFBundleIdentifier` for a macOS app bundle. */
async function macBundleId(bundle) {
  try {
    const { stdout } = await execFileAsync(PLUTIL_BIN, ['-extract', 'CFBundleIdentifier', 'raw', join(bundle, 'Contents', 'Info.plist')], { timeout: DISCOVERY_STEP_TIMEOUT_MS, maxBuffer: 64 * 1024 })
    return stdout.trim()
  } catch {
    return undefined
  }
}

/** Resolve a macOS bundle's path via Spotlight, by bundle id. */
async function macSearchByBundleId(bundleId) {
  try {
    const { stdout } = await execFileAsync(MDFIND_BIN, [`kMDItemCFBundleIdentifier == "${bundleId}"`], { timeout: DISCOVERY_STEP_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
    return stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line.endsWith('.app'))
  } catch {
    return []
  }
}

/**
 * The exe path a Windows `DisplayIcon` names.
 *
 * The value is `"<path>",0` (or `,0,<size>`, or a bare path), and a quoted
 * path may itself contain commas — so the closing quote is located first and
 * only the trailing resource-id suffix is split off.
 */
function parseWindowsDisplayIcon(value) {
  const trimmed = String(value).trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('"')) {
    const close = trimmed.indexOf('"', 1)
    return close === -1 ? undefined : trimmed.slice(1, close).trim() || undefined
  }
  const comma = trimmed.indexOf(',')
  return (comma === -1 ? trimmed : trimmed.slice(0, comma)).trim() || undefined
}

/**
 * Fast path: `reg query <root> /s`.
 *
 * Output is a `key` line per subkey followed by indented
 * `name    REG_TYPE    value` lines. Returns `undefined` only when the root is
 * absent or unreadable; an existing root with no matching records returns `[]`.
 */
async function readWindowsRootViaReg(root) {
  let text
  try {
    const result = await execFileAsync('reg.exe', ['query', root, '/s'], { timeout: DISCOVERY_STEP_TIMEOUT_MS, maxBuffer: WINDOWS_REGISTRY_OUTPUT_MAX_BYTES })
    text = result.stdout
  } catch (error) {
    text = String(error?.stdout ?? '')
    if (text.trim() === '') return undefined
  }
  const rows = []
  let current
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    if (!/^\s/u.test(line)) {
      current = { displayName: '', displayIcon: '', displayVersion: '' }
      rows.push(current)
      continue
    }
    if (current === undefined) continue
    const value = /^\s*(\S+)\s+REG_[A-Z_]+\s+(.*)$/u.exec(line)
    if (value === null) continue
    const [, name, data] = value
    if (name === 'DisplayName') current.displayName = data.trim()
    else if (name === 'DisplayIcon') current.displayIcon = data.trim()
    else if (name === 'DisplayVersion') current.displayVersion = data.trim()
  }
  return rows.filter(row => row.displayName !== '' || row.displayIcon !== '')
}

/** Parse the JSON `{displayName, displayIcon}` rows a PowerShell read returns. */
function parseWindowsRegistryRows(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const rows = Array.isArray(parsed) ? parsed : parsed === null || parsed === undefined ? [] : [parsed]
  const out = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const displayName = typeof row.displayName === 'string' ? row.displayName.trim() : ''
    const displayIcon = typeof row.displayIcon === 'string' ? row.displayIcon.trim() : ''
    const displayVersion = typeof row.displayVersion === 'string' ? row.displayVersion.trim() : ''
    if (displayName !== '' || displayIcon !== '') out.push({ displayName, displayIcon, displayVersion })
  }
  return out
}

/**
 * Accurate path: re-read one Windows uninstall root as UTF-8, through .NET's
 * registry API, emitting JSON.
 *
 * `reg.exe` writes in a console code page that mangles non-ASCII paths (hit in
 * the upstream project). .NET returns strings and never goes through a code
 * page. Output is JSON so PowerShell does the escaping and a path containing
 * spaces, commas, or quotes no longer depends on column positions. Exit codes
 * distinguish "root absent" (`2`) from "root unreadable" (`3`).
 */
async function readWindowsRootViaPowerShell(root) {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = [
    'param([string]$Root)',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
    '$ErrorActionPreference="Stop";',
    '$path="Registry::"+$Root;',
    'if (-not (Test-Path -LiteralPath $path)) { [Console]::Error.Write("root absent"); exit 2 };',
    'try { $k=Get-Item -LiteralPath $path -ErrorAction Stop } catch { [Console]::Error.Write("root unreadable"); exit 3 };',
    '$out=@();',
    'foreach ($n in $k.GetSubKeyNames()) {',
    '  try { $p=$k.OpenSubKey($n); if ($null -eq $p) { throw "null" } } catch { [Console]::Error.Write("subkey unreadable"); exit 3 };',
    '  $d=$p.GetValue("DisplayName");$i=$p.GetValue("DisplayIcon");$v=$p.GetValue("DisplayVersion");',
    '  if ($null -ne $d -or $null -ne $i) { $out += [pscustomobject]@{ displayName=[string]$d; displayIcon=[string]$i; displayVersion=[string]$v } }',
    '};',
    'ConvertTo-Json -InputObject @($out) -Compress -Depth 3',
  ].join(' ')
  try {
    const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, '-Root', root], {
      timeout: DISCOVERY_STEP_TIMEOUT_MS * 4,
      maxBuffer: WINDOWS_REGISTRY_OUTPUT_MAX_BYTES,
    })
    return parseWindowsRegistryRows(stdout)
  } catch {
    return undefined
  }
}

/**
 * Read every uninstall record from the Windows registry.
 *
 * The `reg.exe` fast path answers first; only a root it could not read falls
 * through to PowerShell. Both return the same row shape, so candidate
 * validation and uniqueness are unchanged by which one answered.
 */
async function readWindowsUninstallRows() {
  const rows = []
  for (const root of WINDOWS_REGISTRY_ROOTS) {
    const fast = await readWindowsRootViaReg(root)
    if (fast !== undefined) {
      rows.push(...fast)
      continue
    }
    const accurate = await readWindowsRootViaPowerShell(root)
    if (accurate !== undefined) rows.push(...accurate)
  }
  return rows
}

/**
 * Find one product's Electron binary on Windows.
 *
 * The verified default location is tried first, then the uninstall records. A
 * record whose exe does not match the expected app layout is rejected.
 */
async function discoverWindows(electron) {
  const candidates = []
  const fallback = defaultElectronPath(electron)
  if (fallback !== undefined) candidates.push(fallback)
  const rows = await readWindowsUninstallRows()
  for (const row of rows) {
    if (!electron.windows.displayNamePattern.test(row.displayName)) continue
    const icon = parseWindowsDisplayIcon(row.displayIcon)
    if (icon === undefined) continue
    if (basename(icon).toLowerCase() !== electron.windows.exeBasename.toLowerCase()) continue
    candidates.push({ exe: icon, appVersion: row.displayVersion })
  }
  const seen = new Set()
  let rejected = 0
  for (const candidate of candidates) {
    const candidatePath = typeof candidate === 'string' ? candidate : candidate.exe
    let resolved
    try {
      resolved = realpathSync(candidatePath)
    } catch {
      continue
    }
    if (seen.has(resolved)) continue
    seen.add(resolved)
    if (!isExecutable(resolved)) continue
    const inspected = inspectWindowsElectronCandidate(resolved)
    if (inspected !== undefined) {
      const appVersion = typeof candidate === 'string' ? undefined : candidate.appVersion
      return { ...inspected, ...appVersion === undefined ? {} : { version: appVersion } }
    }
    rejected += 1
  }
  if (rejected === 0) {
    throw new ElectronBinaryError(
      'electron-binary-not-found',
      `no usable ${electron.productName} Electron binary was found in the default location or Windows uninstall records;`
      + ` set ${electron.envVar} to the app's Electron binary`,
    )
  }
  throw new ElectronBinaryError(
    'electron-binary-not-found',
    `Windows uninstall records found ${rejected} ${electron.productName} candidate${rejected > 1 ? 's' : ''},`
    + ` but ${rejected > 1 ? 'none' : 'it'} did not match the expected app layout (the app's exe beside a version file and resources\\app.asar);`
    + ` set ${electron.envVar} to the installed app's executable to use it`,
  )
}

/** Find one product's Electron bundle on macOS, by measured layout then bundle id. */
async function discoverMacos(electron) {
  const bundles = new Map()
  for (const root of ['/Applications', join(process.env.HOME ?? '~', 'Applications')]) {
    const bundle = join(root, `${electron.macOS.appName}.app`)
    if (isDirectory(bundle)) bundles.set(bundle, join(bundle, 'Contents', 'MacOS', 'Electron'))
  }
  for (const bundle of await macSearchByBundleId(electron.macOS.bundleId)) {
    if (isDirectory(bundle)) bundles.set(bundle, join(bundle, 'Contents', 'MacOS', 'Electron'))
  }
  // Confirm the bundle id before trusting a path: a stale directory named like
  // the app is not the app.
  for (const [bundle, exe] of bundles) {
    const id = await macBundleId(bundle)
    if (id !== electron.macOS.bundleId) continue
    if (isExecutable(exe)) return { path: exe, bundle }
  }
  throw new ElectronBinaryError(
    'electron-binary-not-found',
    `no ${electron.productName} app bundle with identifier ${electron.macOS.bundleId} was found;`
    + ` set ${electron.envVar} to the app's Electron binary`,
  )
}

/**
 * Locate one product's Electron binary and, when found, read its version.
 *
 * Precedence: the product's own environment variable (used verbatim), then
 * automatic discovery for the platform.
 *
 * @param {object} variant WorkBuddy variant descriptor.
 * @param {{platform?: NodeJS.Platform}} [options]
 * @returns {Promise<{path: string, version?: string, bundle?: string}>}
 */
export async function resolveElectron(variant, options = {}) {
  const electron = variant.electron
  const explicit = process.env[electron.envVar]?.trim()
  if (explicit !== undefined && explicit !== '') {
    let resolved
    try {
      resolved = realpathSync(explicit)
    } catch {
      throw new ElectronBinaryError('electron-binary-not-found', `${electron.envVar} points at ${explicit}, which does not exist`)
    }
    const inspected = process.platform === 'win32' ? inspectWindowsElectronCandidate(resolved) : undefined
    // No app version is claimed here: with an explicit binary there is no
    // uninstall record to read one from, and guessing would put a wrong value
    // in a User-Agent.
    return { path: resolved, ...inspected === undefined ? {} : { electronVersion: inspected.electronVersion } }
  }
  const discovery = electronDiscoveryFor(options.platform ?? process.platform)
  if (discovery === 'macos') return await discoverMacos(electron)
  if (discovery === 'windows') return await discoverWindows(electron)
  throw new ElectronBinaryError(
    'electron-binary-not-found',
    `automatic discovery is not available on ${process.platform}; set ${electron.envVar} to the ${electron.productName} Electron binary`,
  )
}

/**
 * Spawn the helper and return its validated at-rest payload.
 *
 * Only the exit code and reason ever reach a diagnostic: stdout and stderr can
 * carry paths or crash dumps, and the payload must never appear in a message.
 */
async function spawnHelper(electronPath) {
  const { stdout } = await execFileAsync(electronPath, [HELPER_SCRIPT_FLAG, HELPER_SCRIPT], {
    timeout: HELPER_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  const output = String(stdout).trim()
  if (output === '') {
    throw new ElectronBinaryError('key-helper-empty', `the WorkBuddy key helper (${electronPath}) produced no payload`)
  }
  const payload = parseAtRestPayload(output)
  if (payload === undefined) {
    throw new ElectronBinaryError(
      'key-helper-unreadable',
      `the WorkBuddy key helper (${electronPath}) returned a payload this bridge cannot use;`
      + ' the installed app may predate or postdate the at-rest format it expects',
    )
  }
  return payload
}

/**
 * The at-rest protector key for one product.
 *
 * Resolved once per process, single-flight, and re-resolved when an envelope
 * names a different key id than the cached one — which is what happens after
 * the app reseals its sign-in. The key lives in memory only and is never
 * written to disk.
 */
const keyCache = new Map()

/**
 * @param {object} variant WorkBuddy variant descriptor.
 * @returns {Promise<Buffer>} 32-byte protector key.
 */
export async function protectorKeyFor(variant) {
  const cached = keyCache.get(variant.id)
  if (cached !== undefined) return cached
  const inflight = (async () => {
    const { path } = await resolveElectron(variant)
    const payload = await spawnHelper(path)
    return deriveProtectorKey(payload.atRestSecretKey)
  })()
  keyCache.set(variant.id, inflight)
  try {
    return await inflight
  } catch (error) {
    // Do not pin a failed resolution for the process lifetime: a later attempt
    // should be able to succeed once the user fixes the installation.
    keyCache.delete(variant.id)
    throw error
  }
}

/**
 * Invalidate a cached key. Exposed for `logout` and for tests.
 *
 * @param {string} [variantId] Omit to clear every product's cache.
 */
export function clearProtectorKeyCache(variantId) {
  if (variantId === undefined) {
    keyCache.clear()
    return
  }
  keyCache.delete(variantId)
}

/** Whether a protector key is already cached, without resolving one. */
export function hasCachedProtectorKey(variantId) {
  return keyCache.has(variantId)
}

/** Raised when a product's Electron binary cannot be found or will not run. */
export class ElectronBinaryError extends Error {
  /**
   * @param {string} code Stable, machine-readable cause.
   * @param {string} message Operator-facing explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ElectronBinaryError'
    this.code = code
  }
}

export { DISCOVERY_STEP_TIMEOUT_MS, HELPER_TIMEOUT_MS }
