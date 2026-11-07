/**
 * `@ferretry/kernel/wire` — the session layer's PURE wire, for code that must speak it without the daemon host:
 * the carriers (Connections), the standalone relay Worker and the link-store Worker (relay protocol §3–§7, rows
 * R44–R47). Nothing here does IO; the only platform API reached is WebCrypto, through `WebCryptoSessionCrypto`.
 * The import graph is pinned by `tests/unit/wire-subpath.test.ts`: no `node:*`, no host module with IO.
 *
 * What a relay parses (frames, control, naming) is `ferretry-relay/1`; what rides inside the channel is `/2` (R1).
 * The relay's §5 control messages are Connections' (`relay/src/lib/control.ts` placement); their constants are here.
 */
export * from './host/session/wire/binary.ts';
export * from './host/session/wire/claim.ts';
export * from './host/session/wire/constants.ts';
export * from './host/session/wire/crypto.ts';
export * from './host/session/wire/flow.ts';
export * from './host/session/wire/frames.ts';
export * from './host/session/wire/identity.ts';
export * from './host/session/wire/proofs.ts';
export * from './host/session/wire/tunnel-request.ts';
export * from './host/session/wire/vocabulary.ts';
export { WebCryptoSessionCrypto } from './host/session/adapters/web-crypto.ts';
