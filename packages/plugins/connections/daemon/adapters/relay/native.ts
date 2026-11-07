/** Native carrier adapters. The kernel session layer owns keys, proof and sealing. */
import type { RelayWebSocket, RelayWebSocketFactory } from './bun-relay-carrier.ts';
export const nativeRelaySocket: RelayWebSocketFactory = url => new WebSocket(url) as unknown as RelayWebSocket;
export const randomSessionBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));
