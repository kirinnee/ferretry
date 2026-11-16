/**
 * The kernel's session layer (§4.8, §4.13, §7.1, §7.3): the daemon end of the sealed session. A carrier calls
 * `layer.open(carrier)` per session, feeds `inbound(bytes)` and pulls `outbound.next()`; the layer seals, proves
 * the holder through a session mode, stamps the principal and dispatches into the kernel's own tables.
 */
export {
  createSessionLayer,
  type ModeLookup,
  type SessionDispatch,
  type SessionLayerDeps,
  type SessionLayerHost,
  type SessionLayerReport,
  type StreamDispatch,
  transcriptKey,
} from './layer.ts';
export * from './limits.ts';
export { WebCryptoSessionCrypto } from './adapters/web-crypto.ts';
export * from './wire/index.ts';
