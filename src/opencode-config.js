/**
 * Writing WorkBuddy providers into an OpenCode / OpenChamber config.
 *
 * OpenCode resolves a provider from `providers.<id>`, and for an
 * OpenAI-compatible endpoint it needs a package, a `baseURL`, and the model
 * list spelled out — it does not discover a custom provider's roster from the
 * endpoint. So the model list is generated from a live catalog read and written
 * into the config.
 *
 * The rewrite is deliberately narrow: it owns the `providers.<id>` subtree for
 * the ids it manages and nothing else. Every unrelated setting, and any other
 * provider, is preserved byte-for-byte in structure — which matters because
 * this file is a user's, not the tool's.
 *
 * @module oc-workbuddy-connect/opencode-config
 */

import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AI_VARIANT, CN_VARIANT } from './variants.js'

/** The runtime that speaks the OpenAI request format. */
export const OPENAI_COMPATIBLE_PACKAGE = '@opencode/ai/providers/openai-compatible'

/** Provider ids this bridge manages in an OpenCode config. */
export const MANAGED_PROVIDER_IDS = [CN_VARIANT.id, AI_VARIANT.id]

/**
 * The default global OpenCode config path.
 *
 * `OPENCODE_CONFIG` wins when set, so a caller with a non-standard layout does
 * not have to spell the path out.
 */
export function defaultConfigPath() {
  const override = process.env.OPENCODE_CONFIG?.trim()
  if (override !== undefined && override !== '') return override
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    return join(appData !== undefined && appData !== '' ? appData : join(homedir(), 'AppData', 'Roaming'), 'opencode', 'opencode.json')
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return join(xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.config'), 'opencode', 'opencode.json')
}

/** Parse a JSONC config: comments and trailing commas removed. */
export function parseJsonc(text) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (char === '\n') {
        inLine = false
        out += char
      }
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        i += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        i += 1
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      inLine = true
      i += 1
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      i += 1
      continue
    }
    out += char
  }
  // Trailing commas, before a closing brace or bracket.
  out = out.replace(/,(\s*[}\]])/gu, '$1')
  return JSON.parse(out)
}

/** Drop an empty `providers` object rather than writing `"providers": {}`. */
function pruneEmptyProviders(config) {
  if (config.providers !== undefined && typeof config.providers === 'object' && Object.keys(config.providers).length === 0) {
    delete config.providers
  }
}

/**
 * The `models` map for one variant.
 *
 * Effort variants are generated from the upstream's declared set, because a
 * reasoning model'seffort levels are the one thing a user picks constantly and should
 * not have to be spelled out by hand. `reasoning_effort` travels in the body,
 * which is exactly what the runtime's `body` field merges.
 */
function modelsFor(variant, models) {
  const out = {}
  for (const model of models) {
    // `cost` is deliberately absent: WorkBuddy meters in credits, not in a
    // currency per million tokens, and a fabricated rate would be worse than
    // none. The multiplier is visible in `wb-connect models` instead.
    out[model.id] = {
      name: `${model.name} (${variant.displayName})`,
      ...model.description === undefined ? {} : { description: model.description },
      limit: {
        context: model.contextWindow,
        output: model.maxOutputTokens,
      },
      capabilities: {
        ...model.supportsToolCall ? { tool_call: true } : {},
        input: { text: true, image: model.supportsImages },
        output: { text: true, image: false },
      },
      ...model.reasoning?.supports === true ? { reasoning: true } : {},
      ...variantEfforts(model),
    }
  }
  return out
}

/**
 * Effort variants, built from the upstream's declared set.
 *
 * A reasoning model's effort levels are the one thing a user picks constantly,
 * so generating them from what the upstream actually declares beats making
 * every user spell them out. The level travels in the request body, which is
 * exactly what a provider-level `body` field merges.
 */
function variantEfforts(model) {
  const efforts = model.reasoning?.supportedEfforts ?? []
  if (efforts.length === 0) return {}
  return {
    variants: efforts.map((effort) => ({
      id: effort,
      name: effort,
      body: { reasoning_effort: effort },
      ...model.reasoning?.defaultEffort === effort ? { default: true } : {},
    })),
  }
}

/**
 * The provider block for one variant.
 *
 * @param {object} variant WorkBuddy variant descriptor.
 * @param {Array<object>} models Normalized catalog rows.
 * @param {{baseURL: string, apiKey?: string}} options
 * @returns {object}
 */
export function providerBlock(variant, models, { baseURL, apiKey }) {
  return {
    name: variant.displayName,
    package: OPENAI_COMPATIBLE_PACKAGE,
    settings: {
      baseURL,
      ...apiKey === undefined || apiKey === '' ? {} : { apiKey },
    },
    // Two clients, one endpoint: the header is what tells them apart for a
    // client that cannot prefix its model ids.
    headers: { 'x-workbuddy-variant': variant.id },
    models: modelsFor(variant, models),
  }
}

/**
 * Build the complete set of provider blocks for a bridge URL.
 *
 * @param {Map<string, {variant: object, models: Array<object>}>} catalogs
 * @param {{baseURL: string, apiKey?: string}} options
 * @returns {object} `providers`-shaped object.
 */
export function buildProviders(catalogs, { baseURL, apiKey }) {
  const providers = {}
  for (const [, { variant, models }] of catalogs) {
    providers[variant.id] = providerBlock(variant, models, { baseURL, apiKey })
  }
  return providers
}

/**
 * Merge WorkBuddy providers into an OpenCode config object.
 *
 * Only the managed ids are touched. `model` is left alone unless the caller
 * asks for it: silently repointing a user's default model would change what
 * every session does.
 *
 * @param {object} config Parsed config, or `{}`.
 * @param {object} providers Provider blocks to install.
 * @param {{defaultModel?: string}} [options]
 * @returns {{config: object, changed: Array<string>, defaultModelChanged: boolean}}
 */
export function mergeProviders(config, providers, options = {}) {
  const next = structuredClone(config)
  const schema = next.$schema ?? 'https://opencode.ai/config.json'
  next.$schema = schema
  next.providers = typeof next.providers === 'object' && next.providers !== null ? next.providers : {}
  const changed = []
  for (const [id, block] of Object.entries(providers)) {
    const existing = next.providers[id]
    if (JSON.stringify(existing) === JSON.stringify(block)) continue
    next.providers[id] = block
    changed.push(id)
  }
  pruneEmptyProviders(next)
  let defaultModelChanged = false
  if (options.defaultModel !== undefined) {
    if (next.model !== options.defaultModel) {
      next.model = options.defaultModel
      defaultModelChanged = true
    }
  }
  return { config: next, changed, defaultModelChanged }
}

/**
 * Read, merge, and write an OpenCode config.
 *
 * A missing file is created. An unparsable file is *not* overwritten: the
 * caller is told which path is broken and keeps their content.
 *
 * @param {string} path
 * @param {object} providers
 * @param {{defaultModel?: string, write?: boolean}} [options]
 * @returns {Promise<{path: string, config: object, changed: Array<string>, defaultModelChanged: boolean, written: boolean, created: boolean, error?: string}>}
 */
export async function applyProviders(path, providers, options = {}) {
  let text
  let created = false
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    text = '{}'
    created = true
  }
  let config
  try {
    config = text.trim() === '' ? {} : parseJsonc(text)
  } catch (error) {
    return {
      path,
      config: {},
      changed: [],
      defaultModelChanged: false,
      written: false,
      created: false,
      error: `${path} is not valid JSON/JSONC (${error instanceof Error ? error.message : String(error)});`
        + ' fix or move it, then re-run — this bridge will not overwrite a file it cannot read',
    }
  }
  const merged = mergeProviders(config, providers, options)
  const serialized = `${JSON.stringify(merged.config, null, 2)}\n`
  const unchanged = serialized === text
  if (options.write === false || unchanged) {
    return { path, config: merged.config, changed: merged.changed, defaultModelChanged: merged.defaultModelChanged, written: false, created }
  }
  await writeFile(path, serialized, 'utf8')
  return { path, config: merged.config, changed: merged.changed, defaultModelChanged: merged.defaultModelChanged, written: true, created }
}

/**
 * Remove the managed providers from a config, leaving everything else.
 *
 * @param {object} config
 * @returns {{config: object, removed: Array<string>}}
 */
export function removeProviders(config) {
  const next = structuredClone(config)
  if (typeof next.providers === 'object' && next.providers !== null) {
    const removed = []
    for (const id of MANAGED_PROVIDER_IDS) {
      if (id in next.providers) {
        delete next.providers[id]
        removed.push(id)
      }
    }
    pruneEmptyProviders(next)
    return { config: next, removed }
  }
  return { config: next, removed: [] }
}
