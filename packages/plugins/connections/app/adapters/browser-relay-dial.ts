// Copied browserRelayDial from today’s pwa/lib/relay-carrier.ts; only native IO is injected.
/** A carrier socket. The app shell supplies the sealed-session engine above these bytes. */
interface RelayClientSocket {
  send(bytes: Uint8Array): void;
  sendText(text: string): void;
  close(code?: number, reason?: string): void;
}
export interface RelayCarrierSocket extends RelayClientSocket {
  onOpen: (() => void) | null;
  onText: ((text: string) => void) | null;
  onBinary: ((bytes: Uint8Array) => void) | null;
  onClose: ((code: number, reason: string) => void) | null;
}
export type RelayDial = (url: string) => RelayCarrierSocket;
export interface BrowserSocket {
  binaryType: string;
  onopen: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}
export interface BrowserDialOptions {
  readonly openSocket: (url: string) => BrowserSocket;
  readonly after: (ms: number, run: () => void) => void;
}
const ABNORMAL_CLOSURE = 1006;
const CLOSE_EVENT_GRACE_MS = 250;
const RELAY_CLOSE_CODES = { protocolError: 4400 };
const socketFailureReason = (url: string, opened: boolean): string => {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = 'the configured rendezvous';
  }
  // The same sentence serves a direct dial and a relay one, so it names neither: "the relay protocol"
  // and "rendezvous" told a phone dialling a daemon's own address about a carrier it never used.
  return opened
    ? `the connection to ${origin} was carrying this session and ended without a close frame`
    : `the browser could not open a connection to ${origin}. The address may not resolve, may refuse TLS, ` +
        'may be blocked on this network, or may not be serving this machine';
};

export const createBrowserRelayDial =
  (options: BrowserDialOptions): RelayDial =>
  url => {
    const socket = options.openSocket(url);
    socket.binaryType = 'arraybuffer';
    let opened = false;
    let ended = false;
    const adapted: RelayCarrierSocket = {
      onOpen: null,
      onText: null,
      onBinary: null,
      onClose: null,
      // Copied onto its own buffer: `send` will not take a view whose buffer might be
      // shared, and a frame handed in from anywhere else carries no proof that it is
      // not. One copy of at most 64 KiB per frame is the cheap half of that trade.
      send: bytes => socket.send(new Uint8Array(bytes).buffer),
      sendText: text => socket.send(text),
      close: (code, reason) => socket.close(code, reason),
    };
    const end = (code: number, reason: string): void => {
      if (ended) return;
      ended = true;
      adapted.onClose?.(code, reason);
    };
    socket.onopen = () => {
      opened = true;
      adapted.onOpen?.();
    };
    socket.onclose = event => {
      // A close frame the far end actually sent is the best answer there is, so it is
      // passed through untouched. Everything else is described rather than numbered at.
      const abnormal = event.code === ABNORMAL_CLOSURE || event.code === 0;
      end(abnormal ? ABNORMAL_CLOSURE : event.code, abnormal ? socketFailureReason(url, opened) : event.reason);
    };
    socket.onerror = () => {
      // Deliberately no report: the close event that follows carries the code, and a
      // report here would be the uninformative half of the pair winning the race.
      options.after(CLOSE_EVENT_GRACE_MS, () => end(ABNORMAL_CLOSURE, socketFailureReason(url, opened)));
    };
    socket.onmessage = event => {
      const data: unknown = event.data;
      if (typeof data === 'string') {
        adapted.onText?.(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        adapted.onBinary?.(new Uint8Array(data));
        return;
      }
      // Neither text nor a binary frame is not a message this protocol defines, and
      // guessing at it would mean feeding the session something it did not send. The
      // socket is closed as well as reported: a carrier improvising on this channel is
      // not one to keep listening to.
      socket.close(RELAY_CLOSE_CODES.protocolError, 'unknown message type');
      end(RELAY_CLOSE_CODES.protocolError, 'the relay socket delivered a message of an unknown type');
    };
    return adapted;
  };
