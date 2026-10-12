/**
 * A live session against one WorkBuddy product: credential, catalog, credits.
 *
 * One session per variant. It owns the credential store, the upstream client,
 * and the catalog cache, so the HTTP layer and the CLI never have to know how
 * sign-in or catalog staleness work.
 *
 * The catalog cache exists for one reason: the model picker must still have
 * something to show when the upstream is unreachable. A stale list is labelled
 * stale rather than presented as current.
 *
 * @module oc-workbuddy-connect/session
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { catalogCachePathFor, ensureDir } from './cache.js'
import { catalogFor } from './catalog.js'
import { CredentialStore } from './credentials.js'
import { UpstreamClient } from './upstream.js'
import { REGION_GLOBAL } from './variants.js'

/** How long a fetched catalog is served without re-reading the upstream. */
const CATALOG_TTL_MS = 15 * 60 * 1000

/**
 * One WorkBuddy product, ready to serve requests.
 */
export class WorkBuddySession {
  #variant
  #store
  #upstream
  #catalog
  #catalogFetchedAtMs

  /**
   * @param {object} variant WorkBuddy variant descriptor.
   */
  constructor(variant) {
    this.#variant = variant
    this.#upstream = new UpstreamClient(variant)
    this.#store = new CredentialStore({ variant, refresh: credential => this.#upstream.refreshToken(credential) })
    this.#catalog = undefined
    this.#catalogFetchedAtMs = undefined
  }

  get variant() {
    return this.#variant
  }

  get global() {
    return this.#variant.region === REGION_GLOBAL
  }

  get store() {
    return this.#store
  }

  get upstream() {
    return this.#upstream
  }

  /** The credential to send upstream, refreshed on demand. */
  async credential() {
    return await this.#store.resolve()
  }

  /**
   * The model catalog for this product, from cache when it is fresh.
   *
   * A refresh failure keeps the cached list and reports its age and cause, so a
   * picker stays usable and a reader can tell how old it is.
   *
   * @param {{force?: boolean, signal?: AbortSignal}} [options]
   * @returns {Promise<{models: Array<object>, source: 'upstream'|'cache', fetchedAtMs?: number, warning?: string}>}
   */
  async catalog({ force = false, signal } = {}) {
    const fresh = !force
      && this.#catalog !== undefined
      && this.#catalogFetchedAtMs !== undefined
      && Date.now() - this.#catalogFetchedAtMs < CATALOG_TTL_MS
    if (fresh) return { models: this.#catalog, source: 'upstream', fetchedAtMs: this.#catalogFetchedAtMs }
    if (this.#catalog === undefined) {
      const cached = await this.#readCachedCatalog()
      if (cached !== undefined) {
        this.#catalog = cached.models
        this.#catalogFetchedAtMs = cached.fetchedAtMs
      }
    }
    try {
      const credential = await this.credential()
      const document = await this.#upstream.fetchCatalog(credential, signal)
      const models = catalogFor(document, { variantId: this.#variant.id, global: this.global })
      if (models.length === 0) throw new Error('the upstream catalog carried no usable models')
      this.#catalog = models
      this.#catalogFetchedAtMs = Date.now()
      await this.#writeCachedCatalog({ models, fetchedAtMs: this.#catalogFetchedAtMs })
      return { models, source: 'upstream', fetchedAtMs: this.#catalogFetchedAtMs }
    } catch (error) {
      if (this.#catalog !== undefined) {
        return {
          models: this.#catalog,
          source: 'cache',
          fetchedAtMs: this.#catalogFetchedAtMs,
          warning: `the model catalog could not be refreshed (${error instanceof Error ? error.message : String(error)});`
            + ' serving the last successful list',
        }
      }
      throw error
    }
  }

  /**
   * Remaining credit, straight from the upstream.
   *
   * Not cached: every read is a real billing query, so a displayed balance is
   * never a stale one the user might act on.
   */
  async credits() {
    return await this.#upstream.fetchCredits(await this.credential())
  }

  async #readCachedCatalog() {
    try {
      const parsed = JSON.parse(await readFile(catalogCachePathFor(this.#variant), 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return undefined
      if (!Array.isArray(parsed.models) || parsed.models.length === 0) return undefined
      const fetchedAtMs = typeof parsed.fetchedAtMs === 'number' ? parsed.fetchedAtMs : undefined
      if (fetchedAtMs === undefined) return undefined
      return { models: parsed.models, fetchedAtMs }
    } catch {
      return undefined
    }
  }

  async #writeCachedCatalog({ models, fetchedAtMs }) {
    try {
      const path = catalogCachePathFor(this.#variant)
      await ensureDir(dirname(path))
      await writeFile(path, `${JSON.stringify({ version: 1, fetchedAtMs, models }, null, 2)}\n`, { mode: 0o600 })
    } catch {
      // An unwritable cache costs freshness, never correctness.
    }
  }
}
