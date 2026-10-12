/**
 * Where the bridge keeps its own state.
 *
 * One directory, per-user, outside the desktop app's data so the bridge never
 * writes anything the app owns. Two concerns live here: the bridge-owned
 * credential copy (so refreshes never touch the app's file) and a small catalog
 * cache, which keeps the model list usable while the upstream is unreachable.
 *
 * Override with `WORKBUDDY_CONNECT_CACHE_DIR`, primarily for tests and for
 * running two bridges side by side.
 *
 * @module oc-workbuddy-connect/cache
 */

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cache subdirectory per variant. */
const VARIANT_DIRS = {
  workbuddy: 'workbuddy',
  'workbuddy-ai': 'workbuddy-ai',
}

/**
 * The bridge's cache root.
 *
 * Follows each platform's convention for non-application data, so the cache is
 * not swept by an app-data cleaner and survives an app upgrade.
 */
export function cacheRoot() {
  const override = process.env.WORKBUDDY_CONNECT_CACHE_DIR?.trim()
  if (override !== undefined && override !== '') return override
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim()
    if (localAppData !== undefined && localAppData !== '') return join(localAppData, 'oc-workbuddy-connect')
    return join(homedir(), 'AppData', 'Local', 'oc-workbuddy-connect')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'oc-workbuddy-connect')
  const xdg = process.env.XDG_CACHE_HOME?.trim()
  return join(xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.cache'), 'oc-workbuddy-connect')
}

/** The cache directory for one variant. */
export function cacheDirFor(variant) {
  return join(cacheRoot(), VARIANT_DIRS[variant.id] ?? variant.id)
}

/** The cached catalog path for one variant. */
export function catalogCachePathFor(variant) {
  return join(cacheDirFor(variant), 'catalog.json')
}

/** The cached app-version path for one variant. */
export function appVersionCachePathFor(variant) {
  return join(cacheDirFor(variant), 'app-version.json')
}

/** Ensure a directory exists; an unwritable cache is never fatal. */
export async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  return path
}
