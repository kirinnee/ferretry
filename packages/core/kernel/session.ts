/**
 * `@ferretry/kernel/session` — the sealed-session codec shared by the app and daemon: handshake, channels,
 * frames, records and proofs. The crypto adapter uses WebCrypto; no daemon host or host IO is loaded here.
 */
export * from './host/session/wire/index.ts';
export { WebCryptoSessionCrypto } from './host/session/adapters/web-crypto.ts';
