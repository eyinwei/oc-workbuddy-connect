/**
 * `wb-connect` -- the command line for the WorkBuddy bridge.
 *
 * Commands:
 *
 *   serve       run the OpenAI-compatible bridge (default command)
 *   doctor      diagnose sign-in, the at-rest key helper, and the upstream
 *   models      list one product's models
 *   credits     show remaining credit
 *   chat        one completion, for a smoke test
 *   install     write the providers into an OpenCode / OpenChamber config
 *   uninstall   remove them again
 *   logout      drop the bridge's own credential copy
 *
 * @module oc-workbuddy-connect/cli
 */

import { readFile, writeFile } from 'node:fs/promises'
import { applyProviders, buildProviders, defaultConfigPath, parseJsonc, removeProviders } from './opencode-config.js'
import { startServer } from './server.js'
import { WorkBuddySession } from './session.js'
import {
  AI_VARIANT,
  CN_VARIANT,
  VARIANT_IDS,
  resolveVariantId,
  variantFor,
} from './variants.js'

const USAGE = `wb-connect -- connect WorkBuddy / WorkBuddy AI to OpenCode & OpenChamber

Usage
  wb-connect <command> [options]

Commands
  serve              Run the OpenAI-compatible bridge (the default command).
    --port <n>           Listen port (default 8787).
    --host <addr>        Bind address (default 127.0.0.1).
    --api-key <key>      Require this bearer token (also WB_CONNECT_API_KEY).
    --variant <id>       Serve only one product.

  doctor             Diagnose sign-in, the at-rest key helper, and upstream.
  models             List a product's models.
    --refresh           Bypass the catalog cache.
  credits            Show remaining credit.
  chat               Run one completion, as a smoke test.
    --model <id>         Model id (required).
    --prompt <text>      Prompt text (default: "Reply with exactly: PONG").
    --variant <id>       Product to use.
    --tools              Ask the model to call a sample tool.
  install            Write providers into an OpenCode / OpenChamber config.
    --config <path>      Target config (default: OpenCode's global config).
    --port <n>           Bridge port the providers point at (default 8787).
    --host <addr>        Bridge host (default 127.0.0.1).
    --api-key <key>      Bearer token to write into the config.
    --default-model <m>  Also set the config's default model.
    --dry-run            Print the resulting config instead of writing.
  uninstall          Remove the providers from a config.
  logout             Drop this bridge's own credential copy.

Options
  --variant <id>     workbuddy | workbuddy-ai | cn | ai | global | auto
  --json             Machine-readable output where supported.
  -h, --help         This message.

Environment
  WORKBUDDY_AUTH_FILE           Override the CN auth-file path.
  WORKBUDDY_AI_AUTH_FILE        Override the international auth-file path.
  WORKBUDDY_ELECTRON_BIN        Explicit WorkBuddy Electron binary.
  WORKBUDDY_AI_ELECTRON_BIN     Explicit WorkBuddy AI Electron binary.
  WORKBUDDY_CONNECT_CACHE_DIR   Where this bridge keeps its own state.
  WB_CONNECT_API_KEY            Bearer token the bridge requires.
`

/** Minimal argv parser: `--key value`, `--flag`, and `--key=value`. */
function parseArgs(argv) {
  const options = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq !== -1) {
      options[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      options[body] = true
      continue
    }
    options[body] = next
    i += 1
  }
  return { options, positional }
}

function out(line) {
  process.stdout.write(`${line}\n`)
}

function err(line) {
  process.stderr.write(`${line}\n`)
}

/** Print a machine-readable payload. One place, so every `--json` agrees. */
function emitJson(value) {
  out(JSON.stringify(value, null, 2))
}

/**
 * A string option value, or `undefined`.
 *
 * Hyphenated flags arrive under their literal name (`api-key`), so reading
 * `options.apiKey` would silently see nothing -- and a security flag silently
 * not applying is the most dangerous shape a bug can take. `true` is rejected
 * rather than coerced: `--api-key` with no value is a mistake, and treating it
 * as the string "true" would write that into a config as if it were a key.
 */
function stringOption(options, name) {
  const value = options[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function formatMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return 'unknown'
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`
}

function printModels(models) {
  const width = Math.max(0, ...models.map(model => model.id.length))
  for (const model of models) {
    const badges = [...(model.badges ?? [])]
    if (model.free === true) badges.push('free')
    const rate = model.rateUnknown === true ? 'price unknown' : model.credits ?? '-'
    const flags = [
      model.supportsImages ? 'image' : 'text-only',
      model.supportsToolCall ? 'tools' : 'no-tools',
      model.reasoning?.supports === true ? 'reasoning' : '',
    ].filter(Boolean).join(',')
    out(`${model.id.padEnd(width)}  ${String(rate).padStart(12)}  ${flags.padEnd(28)}  ${badges.join(' ').padEnd(14)}  ${model.name}`)
  }
}

function printCredits(credits) {
  out(credits.unlimited === true ? 'remaining: unlimited (enterprise cycle quota)' : `remaining: ${credits.total}`)
  for (const pkg of credits.packages) {
    const end = pkg.endTimeMs === undefined ? '' : ` until ${formatMs(pkg.endTimeMs)}`
    out(`  - ${pkg.name}: ${pkg.remain}/${pkg.size}${end}`)
  }
}

/**
 * Run one operation against the requested product, or against both.
 *
 * With no `--variant` (or `--variant auto`), every product is tried and each
 * result is reported: a machine signed into only one product stays usable, and
 * the other one's failure is visible instead of masking the success.
 *
 * @param {object} options Parsed CLI options.
 * @param {(session: WorkBuddySession) => Promise<any>} operation
 * @returns {Promise<Array<{id: string, ok: boolean, value?: any, error?: unknown}>>}
 */
async function withSession(options, operation) {
  const raw = typeof options.variant === 'string' ? options.variant.trim().toLowerCase() : undefined
  const wantsBoth = raw === undefined || raw === '' || raw === 'auto'
  const requested = resolveVariantId(raw)
  if (!wantsBoth && requested === undefined) {
    throw new Error(`unknown variant ${JSON.stringify(raw)}; expected one of ${VARIANT_IDS.join(', ')}, cn, ai, global, auto`)
  }
  const ids = wantsBoth ? VARIANT_IDS : [requested]
  const results = []
  for (const id of ids) {
    try {
      results.push({ id, ok: true, value: await operation(new WorkBuddySession(variantFor(id))) })
    } catch (error) {
      results.push({ id, ok: false, error })
    }
  }
  // Only a total failure is a failure; one product working is enough.
  if (results.every(result => !result.ok)) throw results[0].error
  return results
}

/** Report a mixed success/failure result set for `--json`. */
function jsonResults(results, toValue) {
  return results.map(result => (result.ok === false
    ? { variant: result.id, error: errorText(result.error) }
    : { variant: result.id, ...toValue(result.value) }))
}

function exitCodeFor(results) {
  return results.some(result => !result.ok) ? 1 : 0
}

async function commandDoctor(options) {
  const report = []
  for (const variant of [CN_VARIANT, AI_VARIANT]) {
    const session = new WorkBuddySession(variant)
    const entry = { variant: variant.id, displayName: variant.displayName, authFile: session.store.authFilePath() }
    entry.status = await session.store.status()
    try {
      entry.identity = await session.upstream.identity()
    } catch (error) {
      entry.identityError = errorText(error)
    }
    if (entry.status.state === 'signed-in') {
      try {
        const catalog = await session.catalog({ force: true })
        entry.catalog = { count: catalog.models.length, source: catalog.source, fetchedAtMs: catalog.fetchedAtMs }
        if (catalog.warning !== undefined) entry.catalogWarning = catalog.warning
      } catch (error) {
        entry.catalogError = errorText(error)
      }
      try {
        const credits = await session.credits()
        entry.credits = credits.unlimited === true ? { unlimited: true } : { total: credits.total }
      } catch (error) {
        entry.creditsError = errorText(error)
      }
    }
    report.push(entry)
  }
  if (options.json === true) {
    emitJson(report)
    return report.some(entry => entry.status.state === 'signed-in' && entry.catalogError === undefined) ? 0 : 1
  }
  let ready = 0
  for (const entry of report) {
    out('')
    out(`${entry.displayName}  (${entry.variant})`)
    out(`  auth file : ${entry.authFile}`)
    if (entry.status.state === 'signed-in') {
      ready += 1
      const who = entry.status.nickname ?? 'unnamed'
      const source = entry.status.source === 'cache' ? 'bridge cache' : 'desktop app'
      out(`  sign-in   : ok (${who}; token until ${formatMs(entry.status.expiresAtMs)}; from ${source})`)
    } else {
      out('  sign-in   : FAILED')
      out(`  reason    : ${entry.status.reason ?? entry.status.reasonCode}`)
    }
    if (entry.identity !== undefined) {
      const cli = entry.identity.cliVersion === undefined ? '' : ` CLI/${entry.identity.cliVersion}`
      out(`  identity  : WorkBuddy/${entry.identity.version}${cli}`)
    }
    if (entry.identityError !== undefined) out(`  identity  : unavailable (${entry.identityError})`)
    if (entry.catalog !== undefined) out(`  catalog   : ${entry.catalog.count} models from ${entry.catalog.source}`)
    if (entry.catalogWarning !== undefined) out(`               ${entry.catalogWarning}`)
    if (entry.catalogError !== undefined) out(`  catalog   : FAILED (${entry.catalogError})`)
    if (entry.credits !== undefined) {
      out(`  credits   : ${entry.credits.unlimited === true ? 'unlimited' : entry.credits.total}`)
    }
    if (entry.creditsError !== undefined) out(`  credits   : unavailable (${entry.creditsError})`)
  }
  out('')
  out(ready === 0 ? 'No product is ready. See the reasons above.' : `${ready} of 2 products ready.`)
  return ready === 0 ? 1 : 0
}

async function commandModels(options) {
  const results = await withSession(options, async (session) => {
    const catalog = await session.catalog({ force: options.refresh === true })
    return { displayName: session.variant.displayName, ...catalog }
  })
  if (options.json === true) {
    emitJson(jsonResults(results, value => ({
      source: value.source,
      ...value.fetchedAtMs === undefined ? {} : { fetchedAtMs: value.fetchedAtMs },
      ...value.warning === undefined ? {} : { warning: value.warning },
      models: value.models,
    })))
    return exitCodeFor(results)
  }
  for (const result of results) {
    if (!result.ok) {
      err(`${result.id}: ${errorText(result.error)}`)
      continue
    }
    out('')
    out(`${result.value.displayName}  (${result.value.models.length} models, from ${result.value.source})`)
    if (result.value.warning !== undefined) out(`note: ${result.value.warning}`)
    printModels(result.value.models)
  }
  return exitCodeFor(results)
}

async function commandCredits(options) {
  const results = await withSession(options, async (session) => {
    const status = await session.store.status()
    if (status.state !== 'signed-in') throw new Error(status.reason ?? 'not signed in')
    return { displayName: session.variant.displayName, credits: await session.credits(), nickname: status.nickname }
  })
  if (options.json === true) {
    emitJson(jsonResults(results, value => ({ nickname: value.nickname, credits: value.credits })))
    return exitCodeFor(results)
  }
  for (const result of results) {
    if (!result.ok) {
      err(`${result.id}: ${errorText(result.error)}`)
      continue
    }
    out(`${result.value.displayName}  (${result.value.nickname ?? 'unnamed'})`)
    printCredits(result.value.credits)
  }
  return exitCodeFor(results)
}

async function commandChat(options) {
  const model = typeof options.model === 'string' ? options.model : undefined
  if (model === undefined) {
    err('chat needs --model <id>; run `wb-connect models` to list them')
    return 2
  }
  const prompt = typeof options.prompt === 'string' ? options.prompt : 'Reply with exactly: PONG'
  const wantsTools = options.tools === true
  // With `--tools` and no `--prompt`, ask something that forces the call; with
  // both, the user's prompt wins so a caller can script a specific exchange.
  const userText = wantsTools && typeof options.prompt !== 'string'
    ? 'What is the weather in Beijing? Use the get_weather tool; do not answer from memory.'
    : prompt
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: userText },
  ]
  const results = await withSession(options, async (session) => {
    const { normalizeTokenLimits, prepareChatBody } = await import('./chat-body.js')
    const { collectCompletion } = await import('./sse.js')
    const body = {
      model,
      stream: false,
      messages,
      max_tokens: 512,
      ...wantsTools
        ? {
            tools: [{
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get the current weather for a city',
                parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
              },
            }],
            tool_choice: 'auto',
          }
        : {},
    }
    const prepared = normalizeTokenLimits(prepareChatBody(body, { global: session.global }))
    const result = await session.upstream.chatStream(await session.credential(), JSON.stringify(prepared))
    if (result.ok === false) {
      throw new Error(`${result.kind} (http ${result.status}): ${(result.message || '').slice(0, 400)}`)
    }
    return { displayName: session.variant.displayName, completion: await collectCompletion(result.response, { model }) }
  })
  if (options.json === true) {
    emitJson(jsonResults(results, value => ({ completion: value.completion })))
    return exitCodeFor(results)
  }
  for (const result of results) {
    if (!result.ok) {
      err(`${result.id}: ${errorText(result.error)}`)
      continue
    }
    const { completion, displayName } = result.value
    const message = completion.choices?.[0]?.message ?? {}
    out('')
    out(`${displayName} / ${model}`)
    if (typeof message.reasoning_content === 'string' && message.reasoning_content !== '') {
      out(`thinking: ${message.reasoning_content.slice(0, 600)}`)
    }
    out(typeof message.content === 'string' ? message.content : '')
    for (const call of message.tool_calls ?? []) {
      out(`tool_call: ${call.function?.name}(${call.function?.arguments ?? ''})`)
    }
    if (completion.usage !== undefined) {
      const parts = [`${completion.usage.prompt_tokens ?? 0} in`, `${completion.usage.completion_tokens ?? 0} out`]
      if (typeof completion.usage.credit === 'number') parts.push(`${completion.usage.credit} credit`)
      out(`usage: ${parts.join(' / ')}`)
    }
  }
  return exitCodeFor(results)
}

async function commandServe(options) {
  const raw = typeof options.variant === 'string' ? options.variant.trim().toLowerCase() : undefined
  const requested = resolveVariantId(raw)
  if (raw !== undefined && raw !== '' && raw !== 'auto' && requested === undefined) {
    err(`unknown variant ${JSON.stringify(raw)}; expected one of ${VARIANT_IDS.join(', ')}`)
    return 2
  }
  const variants = requested === undefined ? [CN_VARIANT, AI_VARIANT] : [variantFor(requested)]
  const port = options.port === undefined ? 8787 : Number(options.port)
  const host = typeof options.host === 'string' ? options.host : '127.0.0.1'
  const apiKey = stringOption(options, 'api-key') ?? process.env.WB_CONNECT_API_KEY
  const { url, server } = await startServer({ port, host, apiKey, variants })
  out(`wb-connect listening on ${url}`)
  out(`  products : ${variants.map(variant => variant.id).join(', ')}`)
  out('  routing  : set the x-workbuddy-variant header, or prefix the model id as <variant>/<model>')
  out('  routes   : GET /v1/models - POST /v1/chat/completions - GET /healthz')
  if (apiKey !== undefined && apiKey !== '') out('  auth     : bearer token required')
  process.on('SIGINT', () => server.close(() => process.exit(0)))
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
  // Serve until a signal arrives.
  await new Promise(() => {})
  return 0
}

async function commandInstall(options) {
  const configPath = typeof options.config === 'string' ? options.config : defaultConfigPath()
  const port = options.port === undefined ? 8787 : Number(options.port)
  const host = typeof options.host === 'string' ? options.host : '127.0.0.1'
  const baseURL = `http://${host}:${port}/v1`
  const dryRun = options['dry-run'] === true

  // A dry run must not write the catalog cache either: it is a preview.
  const catalogs = new Map()
  for (const variant of [CN_VARIANT, AI_VARIANT]) {
    const session = new WorkBuddySession(variant)
    try {
      const catalog = await session.catalog({ force: options.refresh === true })
      catalogs.set(variant.id, { variant, models: catalog.models })
    } catch (error) {
      err(`skipping ${variant.displayName}: ${errorText(error)}`)
    }
  }
  if (catalogs.size === 0) {
    err('no product could supply a model catalog; nothing written')
    return 1
  }
  const apiKey = stringOption(options, 'api-key') ?? process.env.WB_CONNECT_API_KEY
  const defaultModel = stringOption(options, 'default-model')
  const result = await applyProviders(configPath, buildProviders(catalogs, { baseURL, apiKey }), { defaultModel, write: !dryRun })
  if (result.error !== undefined) {
    err(result.error)
    return 1
  }
  if (dryRun) {
    emitJson(result.config)
    return 0
  }
  const total = [...catalogs.values()].reduce((sum, entry) => sum + entry.models.length, 0)
  out(`${result.written ? 'wrote' : 'left unchanged'}: ${configPath}`)
  out(`  products  : ${[...catalogs.keys()].join(', ')}  (${total} models, pointing at ${baseURL})`)
  if (result.changed.length > 0) out(`  updated   : ${result.changed.join(', ')}`)
  if (result.defaultModelChanged) out(`  default   : model set to ${defaultModel}`)
  out('')
  out(`Start the bridge with \`wb-connect serve --port ${port}\`, then restart OpenCode / OpenChamber.`)
  return 0
}

async function commandUninstall(options) {
  const configPath = typeof options.config === 'string' ? options.config : defaultConfigPath()
  let text
  try {
    text = await readFile(configPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      out(`${configPath} does not exist; nothing to remove`)
      return 0
    }
    throw error
  }
  let config
  try {
    config = parseJsonc(text)
  } catch (error) {
    err(`${configPath} is not valid JSON/JSONC (${errorText(error)}); not touching it`)
    return 1
  }
  const { config: next, removed } = removeProviders(config)
  if (removed.length === 0) {
    out(`${configPath} had no WorkBuddy providers`)
    return 0
  }
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  out(`removed ${removed.join(', ')} from ${configPath}`)
  return 0
}

async function commandLogout() {
  for (const variant of [CN_VARIANT, AI_VARIANT]) {
    const session = new WorkBuddySession(variant)
    await session.store.logout()
    out(`cleared the ${variant.id} credential copy (${session.store.cachePath()})`)
  }
  out(`the desktop apps' own sign-ins are untouched`)
  return 0
}

/** Entry point. Returns the process exit code. */
export async function main(argv) {
  const { options, positional } = parseArgs(argv)
  const command = positional[0] ?? 'serve'
  if (options.help === true || options.h === true || command === 'help') {
    out(USAGE)
    return 0
  }
  if (command === 'version' || options.version === true) {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    out(pkg.version)
    return 0
  }
  switch (command) {
    case 'serve': return await commandServe(options)
    case 'doctor': return await commandDoctor(options)
    case 'models': return await commandModels(options)
    case 'credits': return await commandCredits(options)
    case 'chat': return await commandChat(options)
    case 'install': return await commandInstall(options)
    case 'uninstall': return await commandUninstall(options)
    case 'logout': return await commandLogout(options)
    default:
      err(`unknown command: ${command}`)
      err('')
      err(USAGE)
      return 2
  }
}
