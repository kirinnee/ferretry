import type { CarrierDial } from './session-transport.ts';
import type { RelayClientSocket } from './session-client.ts';

/**
 * THE DIRECT CARRIER, browser side: a WebSocket to the daemon's own listener at
 * `/v1/rendezvous/<daemonId>/client`, which plays the rendezvous's part, so everything above the socket is the same
 * sealed session a relay carries (docs/relay-protocol.md §14). Copied from today's PWA `browserRelayDial`.
 *
 * DAY-1 STAND-IN: which carrier to use (direct, WebRTC, tunnel, relay) is Connections' choice (§4.8). Until its app
 * half can hand the shell a dial, the shell dials the pairing's direct address. The WebSocket constructor and the
 * timer are injected at the composition root; nothing here reaches a global.
 */

/** A WebSocket's close code when the far end sent no close frame. */
const ABNORMAL_CLOSURE = 1006;
/** How long to wait for the close event that follows an `error` before reporting the failure ourselves. */
const CLOSE_EVENT_GRACE_MS = 2_000;

export interface SocketLike {
  binaryType: string;
  onopen: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface DirectDialOptions {
  readonly address: string;
  readonly daemonId: string;
  readonly openSocket: (url: string) => SocketLike;
  readonly after: (delayMs: number, run: () => void) => void;
}

/** The session URL on a daemon's own address: `http` becomes `ws`, `https` becomes `wss`. */
export function directSessionUrl(address: string, daemonId: string): string {
  const url = new URL(`/v1/rendezvous/${encodeURIComponent(daemonId)}/client`, address);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

const failureReason = (url: string, opened: boolean): string => {
  let origin = 'the daemon';
  try {
    origin = new URL(url).origin;
  } catch {
    // keep the generic name
  }
  return opened
    ? `the connection to ${origin} was carrying this session and ended without a close frame`
    : `the browser could not open a connection to ${origin}. The address may not resolve, may refuse TLS, ` +
        'may be blocked on this network, or may not be serving this machine';
};

export function directDial(options: DirectDialOptions): CarrierDial {
  return events => {
    const url = directSessionUrl(options.address, options.daemonId);
    const socket = options.openSocket(url);
    // `arraybuffer` is load-bearing: a Blob's read is asynchronous, and a frame read out of order is a torn-down
    // session under the sequence rule.
    socket.binaryType = 'arraybuffer';
    let opened = false;
    let ended = false;
    const end = (code: number, reason: string): void => {
      if (ended) return;
      ended = true;
      events.onClose(code, reason);
    };
    socket.onopen = () => {
      opened = true;
    };
    socket.onclose = event => {
      const abnormal = event.code === ABNORMAL_CLOSURE || event.code === 0;
      end(abnormal ? ABNORMAL_CLOSURE : event.code, abnormal ? failureReason(url, opened) : event.reason);
    };
    socket.onerror = () => {
      options.after(CLOSE_EVENT_GRACE_MS, () => end(ABNORMAL_CLOSURE, failureReason(url, opened)));
    };
    socket.onmessage = event => {
      if (typeof event.data === 'string') events.onText(event.data);
      else if (event.data instanceof ArrayBuffer) events.onBinary(new Uint8Array(event.data));
    };
    const adapted: RelayClientSocket = {
      send: bytes => socket.send(new Uint8Array(bytes).buffer),
      sendText: text => socket.send(text),
      close: (code, reason) => socket.close(code, reason),
    };
    return adapted;
  };
}
