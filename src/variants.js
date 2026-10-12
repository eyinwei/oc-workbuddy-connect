/**
 * The two WorkBuddy desktop products this bridge serves.
 *
 * Both are the same Electron client in two regions and both write their
 * sign-in into the *same* shared `CodeBuddyExtension` auth directory. They
 * differ by file basename, product identity, upstream base URLs, and — most
 * importantly — by which login `domain` their credential carries. Everything
 * that varies is collected here once so no other module carries an
 * "is international?" branch.
 *
 * Adding a third region is a data change in this file, not a refactor.
 *
 * @module oc-workbuddy-connect/variants
 */

/** Upstream region a credential's login domain belongs to. */
export const REGION_CN = 'cn'
export const REGION_GLOBAL = 'global'

/**
 * Region for a login domain.
 *
 * An empty or unrecognized domain means CN, matching the upstream tooling's
 * own convention: the CN gateway is the default route, and only an explicit
 * `*.workbuddy.ai` domain opts into the international endpoints.
 */
export function regionOf(domain) {
  const value = typeof domain === 'string' ? domain.trim().toLowerCase() : ''
  return value === 'workbuddy.ai' || value.endsWith('.workbuddy.ai') ? REGION_GLOBAL : REGION_CN
}

/** How one product's Electron binary is identified and located. */
const workbuddyElectron = {
  productName: 'WorkBuddy',
  envVar: 'WORKBUDDY_ELECTRON_BIN',
  macOS: {
    bundleId: 'com.tencent.workbuddy.mac',
    appName: 'WorkBuddy',
  },
  windows: {
    displayNamePattern: /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
    exeBasename: 'workbuddy.exe',
    // The CN installer has been observed writing here; the registry search
    // still runs because the installer also allows a custom directory.
    defaultPathSegments: ['Programs', 'WorkBuddy', 'WorkBuddy.exe'],
  },
}

const workbuddyAiElectron = {
  productName: 'WorkBuddy AI',
  envVar: 'WORKBUDDY_AI_ELECTRON_BIN',
  macOS: {
    bundleId: 'com.workbuddy.workbuddy-ai',
    appName: 'WorkBuddy AI',
  },
  windows: {
    // `WorkBuddy AI 5.7.6` — the CN pattern cannot match this ("AI" is not a
    // version) and this pattern cannot match `WorkBuddy 5.7.7` (missing the
    // literal " AI"), so the two records never feed each other's discovery.
    displayNamePattern: /^WorkBuddy AI(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
    exeBasename: 'workbuddyai.exe',
    // No verified default: the international app has only been seen in
    // user-chosen locations. An unverified default is a guess, and guessing is
    // how the wrong app gets executed.
    defaultPathSegments: undefined,
  },
}

/** One WorkBuddy product variant. */
export const WORKBUDDY_VARIANTS = [
  {
    id: 'workbuddy',
    displayName: 'WorkBuddy',
    appName: 'WorkBuddy',
    region: REGION_CN,
    authEnv: 'WORKBUDDY_AUTH_FILE',
    cacheEnv: 'WORKBUDDY_CONNECT_CACHE_DIR',
    desktopFilename: 'workbuddy-desktop.info',
    electron: workbuddyElectron,
    // Upstream bases. `origin` is what the desktop client sends as
    // Origin/Referer; `chat` serves `/v2/chat/completions` and `/v3/config`;
    // `billing` serves the credit meter. CN keeps them split, as the official
    // client does.
    bases: {
      chat: 'https://copilot.tencent.com',
      billing: 'https://www.codebuddy.cn',
      origin: 'https://www.codebuddy.cn',
    },
    // Compiled-in fallback used when the installed app version cannot be read
    // on this platform. It is a *shape* requirement (the UA must look like the
    // desktop client's), not a claim that the user runs this version.
    fallbackAppVersion: '5.5.6',
  },
  {
    id: 'workbuddy-ai',
    displayName: 'WorkBuddy AI',
    appName: 'WorkBuddy AI',
    region: REGION_GLOBAL,
    authEnv: 'WORKBUDDY_AI_AUTH_FILE',
    cacheEnv: 'WORKBUDDY_CONNECT_CACHE_DIR',
    desktopFilename: 'workbuddy-desktop-ai.info',
    electron: workbuddyAiElectron,
    bases: {
      chat: 'https://www.workbuddy.ai',
      billing: 'https://www.workbuddy.ai',
      origin: 'https://www.workbuddy.ai',
    },
    fallbackAppVersion: '5.5.6',
  },
]

/** The CN variant. */
export const CN_VARIANT = WORKBUDDY_VARIANTS[0]

/** The international variant. */
export const AI_VARIANT = WORKBUDDY_VARIANTS[1]

/** Every variant id, in catalog order. */
export const VARIANT_IDS = WORKBUDDY_VARIANTS.map(variant => variant.id)

/** Look up a variant by id. */
export function variantFor(id) {
  if (typeof id !== 'string') return undefined
  const wanted = id.trim().toLowerCase()
  return WORKBUDDY_VARIANTS.find(variant => variant.id === wanted)
}

/**
 * Resolve a user-supplied variant selector.
 *
 * Accepts the canonical id (`workbuddy-ai`), the common aliases (`cn`, `ai`,
 * `global`, `international`), and `auto`, which is only meaningful to callers
 * that will try every variant in turn.
 */
export function resolveVariantId(value) {
  if (value === undefined) return undefined
  const wanted = String(value).trim().toLowerCase()
  if (wanted === '') return undefined
  const alias = {
    cn: CN_VARIANT.id,
    'workbuddy-cn': CN_VARIANT.id,
    china: CN_VARIANT.id,
    ai: AI_VARIANT.id,
    global: AI_VARIANT.id,
    intl: AI_VARIANT.id,
    international: AI_VARIANT.id,
    'workbuddy-intl': AI_VARIANT.id,
  }[wanted]
  return alias ?? (VARIANT_IDS.includes(wanted) ? wanted : undefined)
}

/**
 * User-Agent for one region's chat and catalog requests.
 *
 * The desktop client composes `WorkBuddy/<v> <product>/<v> CLI/<cli>`; the
 * product token names the app that owns the region's requests. The CLI token
 * is appended only when a CLI version actually resolves — the official client
 * drops it for a missing extension rather than inventing one, and the CN
 * gateway splits its model roster by exactly this string, so guessing would
 * silently advertise the wrong catalog.
 */
export function chatUserAgent(appVersion, cliVersion, region) {
  // Throw on an invalid version rather than interpolating one into a header.
  // A newline or space in a User-Agent is a request-smuggling vector, and the
  // gateway's roster split makes a wrong version a silent wrong-catalog bug.
  if (typeof appVersion !== 'string' || !/^\d{1,6}(?:\.\d{1,6}){1,3}(?:[-+][0-9A-Za-z.]+)?$/u.test(appVersion)) {
    throw new Error(`invalid client version for chat User-Agent: ${JSON.stringify(appVersion)}`)
  }
  if (typeof cliVersion === 'string' && cliVersion !== ''
    && !/^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(cliVersion)) {
    throw new Error(`invalid CLI version for chat User-Agent: ${JSON.stringify(cliVersion)}`)
  }
  const product = region === REGION_GLOBAL ? 'WorkBuddy AI' : 'WorkBuddy'
  const parts = [`WorkBuddy/${appVersion}`, `${product}/${appVersion}`]
  if (typeof cliVersion === 'string' && cliVersion !== '') parts.push(`CLI/${cliVersion}`)
  return parts.join(' ')
}

/**
 * The CLI-shaped User-Agent used for token refresh.
 *
 * The refresh endpoint is the one the official CLI owns outright and does not
 * branch on client identity, so it keeps its own fixed form.
 */
export const CLI_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2'
