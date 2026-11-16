import type { FetchPort } from './fetch.ts';

/** The subset of a WebSocket a client uses (today's relay carrier's `RelayWebSocket`), so a test supplies one. */
export interface WebSocketClient {
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Outbound WebSocket clients, restricted like {@link FetchPort}: `ws:`/`wss:` to a declared host only, refused
 * (a `PermissionError`, thrown synchronously) before a socket opens. Dialled as today's relay carrier dialled:
 * the URL alone, no extra headers; deadlines and keepalive are the caller's.
 */
export interface WebSocketPort {
  connect(url: string | URL): WebSocketClient;
}
