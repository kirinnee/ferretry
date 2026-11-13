/**
 * Bun's own WebSocket, crypto and timers, captured before happy-dom registers its globals.
 *
 * The app test draws a real `App` in a DOM, and `tests/support/dom.ts` replaces the global scope while it loads. The
 * direct carrier must dial the daemon with the runtime's real WebSocket and sign with the runtime's real WebCrypto, so
 * the test imports THIS file first and every other file in this folder takes them from here.
 */
export const NativeWebSocket = globalThis.WebSocket;
export const nativeCrypto = globalThis.crypto;
export const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
export const nativeFetch = globalThis.fetch.bind(globalThis);
/** Bun's own Response: `Bun.serve` refuses any other, and the daemon in this process builds every answer with the global. */
export const NativeResponse = globalThis.Response;
