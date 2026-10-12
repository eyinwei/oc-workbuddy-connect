/**
 * `oc-workbuddy-connect` — a local OpenAI-compatible bridge from the WorkBuddy
 * desktop apps to any OpenAI-compatible client.
 *
 * The library surface is the same one the CLI is built from, so a host that
 * wants to embed the bridge (an editor plugin, a test harness, another agent
 * runtime) can start the server, read a catalog, or read a balance directly
 * instead of shelling out.
 *
 * @module oc-workbuddy-connect
 */

export { AI_VARIANT, CN_VARIANT, WORKBUDDY_VARIANTS, regionOf, resolveVariantId, variantFor, chatUserAgent } from './variants.js'
export { WorkBuddySession } from './session.js'
export { startServer } from './server.js'
export { UpstreamClient, classifyUpstreamError, extractDisplayErrorMessage } from './upstream.js'
export { catalogFor, normalizeCredits, parseCatalog, toOpenAIModels } from './catalog.js'
export { CredentialStore, authFileCandidates, parseCredential } from './credentials.js'
export { mergeChunks, collectCompletion, parseSseBody } from './sse.js'
export { prepareChatBody, resolveUpstreamModelId } from './chat-body.js'
export {
  applyProviders,
  buildProviders,
  defaultConfigPath,
  mergeProviders,
  parseJsonc,
  providerBlock,
  removeProviders,
} from './opencode-config.js'
export { ElectronBinaryError, resolveElectron } from './electron.js'
export { CredentialReadError } from './at-rest.js'
export { cacheRoot, cacheDirFor } from './cache.js'
