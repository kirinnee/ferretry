import { FY_REQUEST_ID_HEADER } from '@ferretry/app';
import { BROWSER_MAX_PAGE_ID_LENGTH } from '../../contract/index.ts';
import {
  type BrowserAction,
  type BrowserActionResult,
  BrowserActionResultSchema,
  type BrowserInputEvent,
  type BrowserPageSummary,
  type BrowserStatus,
  BrowserStatusSchema,
} from '../../contract/wire/browser.ts';
import {
  assembleBrowserStream,
  type BrowserStreamAssembly,
  EMPTY_BROWSER_STREAM_ASSEMBLY,
} from '../../contract/wire/stream.ts';
import { type BrowserDaemon, type BrowserSessionScope, canOpenSocket } from './scope.ts';

/**
 * The daemon's browser frame envelope, v1: magic, version, page-id byte length,
 * page id, then the JPEG bytes, all in one binary message.
 *
 * These four bytes are ASCII `FYBF` and MUST stay byte-identical to the daemon's
 * `FRAME_ENVELOPE_MAGIC`, because the daemon owns the only encoder and this is a
 * second, hand-written decoder. An unknown magic fails closed: bytes the decoder
 * cannot attribute to a page are never handed to the viewer as pixels.
 */
const FRAME_MAGIC = Uint8Array.of(0x46, 0x59, 0x42, 0x46);
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 7;
const MAX_JPEG_BYTES = 8 * 1024 * 1024;

/**
 * One decoded frame. `decodeRemoteBrowserFrame` only ever returns `tagged`: a message it cannot attribute to a page
 * is rejected, not downgraded.
 */
export interface RemoteBrowserFrame {
  readonly kind: 'tagged';
  readonly pageId: string;
  readonly jpegBytes: ArrayBuffer;
}

export type RemoteViewportMode = 'responsive' | 'desktop';

/** The route of one session's browser: its status on GET, an action on POST. */
const SESSION_BROWSER_ROUTES = {
  status: 'GET /v1/ferrets/:ferretId/browser',
  act: 'POST /v1/ferrets/:ferretId/browser',
  stream: 'GET /v1/ferrets/:ferretId/browser/stream',
} as const;

const sessionParams = (scope: BrowserSessionScope): Readonly<Record<string, string>> => ({
  ferretId: scope.sessionId,
});

const assertScopeDaemon = (daemon: BrowserDaemon, scope: BrowserSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('browser scope must belong to the requested daemon');
};

/** A session id the daemon answered for another session is a crossed response, not a state to show. */
class CrossedBrowserAnswerError extends Error {
  constructor() {
    super('daemon returned another session');
    this.name = 'CrossedBrowserAnswerError';
  }
}

/**
 * Browser identity is daemon-issued and read back from the response, so the
 * server-derived session id is checked against the requested scope before any
 * caller can act on it — a slow or crossed response must not publish another
 * session's state.
 */
const parseBrowserStatus = (scope: BrowserSessionScope, body: unknown): BrowserStatus => {
  const status = BrowserStatusSchema.parse(body);
  if (status.sessionId !== scope.sessionId) throw new CrossedBrowserAnswerError();
  return status;
};

const parseBrowserActionResult = (scope: BrowserSessionScope, body: unknown): BrowserActionResult => {
  const result = BrowserActionResultSchema.parse(body);
  if (result.status.sessionId !== scope.sessionId) throw new CrossedBrowserAnswerError();
  return result;
};

/** Reads the browser status from exactly the daemon that owns this session. */
export const fetchRemoteBrowserStatus = async (
  daemon: BrowserDaemon,
  scope: BrowserSessionScope,
): Promise<BrowserStatus> => {
  assertScopeDaemon(daemon, scope);
  return parseBrowserStatus(
    scope,
    await daemon.client.call(SESSION_BROWSER_ROUTES.status, { params: sessionParams(scope), quiet: true }),
  );
};

/** Executes one validated browser action through the daemon. */
export const runRemoteBrowserAction = async (
  daemon: BrowserDaemon,
  scope: BrowserSessionScope,
  action: BrowserAction,
): Promise<BrowserActionResult> => {
  assertScopeDaemon(daemon, scope);
  return parseBrowserActionResult(
    scope,
    await daemon.client.call(SESSION_BROWSER_ROUTES.act, {
      params: sessionParams(scope),
      body: action,
      headers: { [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
    }),
  );
};

/**
 * The live display's transport, seen from the viewer: the four things a WebSocket does.
 *
 * A PORT, NOT A `WebSocket`. The display rides the shell's guarded socket on whichever carrier Connections chose, so
 * there is no bare socket to hand back; this shape is what lets the viewer stay ignorant of which carrier it is on
 * (and lets a test drive it).
 */
export interface RemoteBrowserSocket {
  readonly readyState: number;
  binaryType: BinaryType;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RemoteBrowserSocketFactory = (daemon: BrowserDaemon, scope: BrowserSessionScope) => RemoteBrowserSocket;

/**
 * The close a refused display reports: `1008` for a refusal asking again cannot change — the caller
 * is not allowed — and `1011` for one that can, such as a page that has not opened yet. The viewer
 * retries the second and never the first: a viewer that retried a `403` would ask a permanent refusal
 * the same question forever.
 */
const refusalClose = (status: number): number => (status === 401 || status === 403 ? 1008 : 1011);

/** What the session says when the daemon answers a stream open with a refusal (`the daemon refused this stream: 403`). */
const REFUSED_STREAM = /refused this stream: (\d{3})/u;

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

/**
 * One browser display stream as the socket the viewer reads.
 *
 * Bytes are `FYBC` chunks (`wire/stream.ts`, R548) and are reassembled here into the `FYBF` envelopes the viewer
 * decodes, one `message` event per whole frame. A stream whose framing breaks is ended with `1003` — the route's own
 * repair is a fresh attach — rather than painted from bytes nobody can attribute to a page. Input is one JSON event per
 * text record and is never split (R549).
 */
class RemoteBrowserStreamSocket implements RemoteBrowserSocket {
  readyState = SOCKET_CONNECTING;
  binaryType: BinaryType = 'arraybuffer';
  readonly #listeners = new Map<string, ((event: Event) => void)[]>();
  /** What happened before anyone listened for it: the socket opens inside the factory, the viewer listens after. */
  readonly #unheard = new Map<string, Event[]>();
  #handle: { send(frame: string): void; close(code?: number, reason?: string): void } | undefined;
  #assembly: BrowserStreamAssembly = EMPTY_BROWSER_STREAM_ASSEMBLY;

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
    const missed = this.#unheard.get(type) ?? [];
    this.#unheard.delete(type);
    for (const event of missed) listener(event);
  }

  /** Input is JSON text, one complete event per record. A send that cannot go is simply not sent. */
  send(data: string): void {
    if (this.readyState !== SOCKET_OPEN) return;
    try {
      this.#handle?.send(data);
    } catch {
      // The stream ended under this send; its close is already on the way to the viewer.
    }
  }

  close(code = 1000, reason = 'viewer detached'): void {
    if (this.readyState === SOCKET_CLOSED) return;
    this.readyState = SOCKET_CLOSED;
    this.#handle?.close(code, reason);
  }

  attach(handle: { send(frame: string): void; close(code?: number, reason?: string): void }): void {
    this.#handle = handle;
    if (this.readyState === SOCKET_CLOSED) handle.close();
  }

  /** The socket could not be opened at all. */
  failed(reason: string): void {
    if (this.readyState === SOCKET_CLOSED) return;
    this.#emit('error', new Event('error'));
    this.#ended(1006, reason);
  }

  receive(frame: string | Uint8Array): void {
    // The display is server-to-client bytes; text from the daemon is a shape this stream does not have.
    if (this.readyState === SOCKET_CLOSED || typeof frame === 'string') return;
    this.opened();
    const step = assembleBrowserStream(this.#assembly, frame);
    if (!step.ok) {
      this.close(1003, 'the viewer could not read this stream');
      this.#emit('close', new CloseEvent('close', { code: 1003, reason: step.message }));
      return;
    }
    this.#assembly = step.assembly;
    for (const envelope of step.envelopes) {
      // A genuine ArrayBuffer of exactly the envelope: the viewer reads `event.data` as one.
      const data = envelope.buffer.slice(envelope.byteOffset, envelope.byteOffset + envelope.byteLength);
      this.#emit('message', new MessageEvent('message', { data }));
    }
  }

  /**
   * The stream ended. A stream the daemon (or the carrier) closed carries its close code, passed through as it came:
   * `1008` stops the viewer with its reason, `1013` or `1011` lets it ask again. A stream that never opened has no
   * code, only a sentence, and a daemon refusal carries its status in it.
   */
  ended(reason: string, code?: number): void {
    if (code !== undefined) {
      this.#ended(code, reason);
      return;
    }
    const refused = REFUSED_STREAM.exec(reason);
    if (refused !== null) {
      this.#emit('error', new Event('error'));
      this.#ended(refusalClose(Number(refused[1])), reason);
      return;
    }
    this.#ended(1006, reason);
  }

  opened(): void {
    if (this.readyState !== SOCKET_CONNECTING) return;
    this.readyState = SOCKET_OPEN;
    this.#emit('open', new Event('open'));
  }

  #ended(code: number, reason: string): void {
    if (this.readyState === SOCKET_CLOSED) return;
    this.readyState = SOCKET_CLOSED;
    this.#emit('close', new CloseEvent('close', { code, reason }));
  }

  #emit(type: string, event: Event): void {
    const heard = this.#listeners.get(type) ?? [];
    if (heard.length === 0) this.#unheard.set(type, [...(this.#unheard.get(type) ?? []), event]);
    for (const listener of heard) listener(event);
  }
}

/**
 * The live display as one guarded socket on the shell's client: the contract-hash guard runs before it opens, and
 * the credential is the device's, never this module's.
 */
export const remoteBrowserSocketFactory: RemoteBrowserSocketFactory = (daemon, scope) => {
  assertScopeDaemon(daemon, scope);
  const socket = new RemoteBrowserStreamSocket();
  if (!canOpenSocket(daemon.client)) {
    socket.failed('this client cannot open the browser display');
    return socket;
  }
  try {
    socket.attach(
      daemon.client.socket(SESSION_BROWSER_ROUTES.stream, sessionParams(scope), {
        onOpen: () => socket.opened(),
        onFrame: frame => socket.receive(frame),
        onClose: (reason, code) => socket.ended(reason, code),
      }),
    );
  } catch (caught) {
    socket.failed(caught instanceof Error ? caught.message : 'the display stream did not open');
  }
  return socket;
};

/**
 * Decodes the daemon's atomic page-id/JPEG frame envelope, failing closed on
 * everything else.
 *
 * A message is rejected unless its magic, version, declared page-id length,
 * UTF-8 page id, and payload size all agree with the envelope. There is
 * deliberately no fallback for an unidentified message: bytes the decoder cannot
 * attribute to a page are bytes the viewer cannot honestly render, and painting
 * them would show one page's pixels under another page's identity.
 */
export const decodeRemoteBrowserFrame = (message: ArrayBuffer): RemoteBrowserFrame | null => {
  const bytes = new Uint8Array(message);
  if (bytes.byteLength < FRAME_HEADER_BYTES) return null;
  if (!FRAME_MAGIC.every((value, index) => bytes[index] === value)) return null;
  if (bytes[4] !== FRAME_VERSION) return null;
  const pageIdBytes = new DataView(message).getUint16(5, false);
  if (pageIdBytes === 0 || pageIdBytes > BROWSER_MAX_PAGE_ID_LENGTH * 4) return null;
  const jpegOffset = FRAME_HEADER_BYTES + pageIdBytes;
  const jpegLength = bytes.byteLength - jpegOffset;
  if (jpegLength <= 0 || jpegLength > MAX_JPEG_BYTES) return null;
  try {
    const id = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(FRAME_HEADER_BYTES, jpegOffset));
    if (
      id.length === 0 ||
      id.length > BROWSER_MAX_PAGE_ID_LENGTH ||
      new TextEncoder().encode(id).byteLength !== pageIdBytes
    )
      return null;
    return { kind: 'tagged', pageId: id, jpegBytes: message.slice(jpegOffset) };
  } catch {
    return null;
  }
};

export const remoteViewportForContainer = (
  width: number,
  height: number,
  mode: RemoteViewportMode,
): { readonly width: number; readonly height: number } | null => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  if (mode === 'desktop') return { width: 1280, height: 800 };
  return {
    width: Math.max(320, Math.min(1920, Math.round(width))),
    height: Math.max(240, Math.min(1200, Math.round(height))),
  };
};

export const remoteCanvasPoint = (
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  canvasWidth: number,
  canvasHeight: number,
  clientX: number,
  clientY: number,
): { readonly x: number; readonly y: number } => {
  const width = Math.max(1, canvasWidth);
  const height = Math.max(1, canvasHeight);
  return {
    x: Math.max(0, Math.min(width - 1, ((clientX - rect.left) * width) / Math.max(1, rect.width))),
    y: Math.max(0, Math.min(height - 1, ((clientY - rect.top) * height) / Math.max(1, rect.height))),
  };
};

const REMOTE_MULTI_CLICK_MS = 500;
const REMOTE_MULTI_CLICK_SLOP = 5;
export const REMOTE_MAX_CLICK_COUNT = 3;

export interface RemoteClickRun {
  readonly count: number;
  readonly at: number;
  readonly x: number;
  readonly y: number;
}

/**
 * `PointerEvent.detail` is 0 for pointerdown/pointerup, so it can never carry a
 * click run. Track the run here from time plus distance instead, and send the
 * SAME count on press and release so Chrome sees a well-formed multi-click.
 */
export const nextRemoteClickRun = (
  previous: RemoteClickRun | null,
  point: { readonly x: number; readonly y: number },
  at: number,
): RemoteClickRun => {
  const continues =
    previous !== null &&
    at - previous.at <= REMOTE_MULTI_CLICK_MS &&
    Math.abs(point.x - previous.x) <= REMOTE_MULTI_CLICK_SLOP &&
    Math.abs(point.y - previous.y) <= REMOTE_MULTI_CLICK_SLOP;
  return {
    count: continues ? Math.min(REMOTE_MAX_CLICK_COUNT, previous.count + 1) : 1,
    at,
    x: point.x,
    y: point.y,
  };
};

/**
 * True for the LOCAL paste chord, which must reach the surface's own paste
 * handler rather than being forwarded as a keystroke. Forwarding it makes the
 * remote Chrome paste the REMOTE clipboard, which the reader never asked for.
 */
export const isLocalPasteChord = (event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): boolean => (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v';

export type RemotePointerButton = 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward';

const POINTER_BUTTONS: readonly RemotePointerButton[] = ['left', 'middle', 'right', 'back', 'forward'];

/** Maps a DOM `PointerEvent.button` index onto the CDP button vocabulary. */
export const remotePointerButton = (button: number): RemotePointerButton => POINTER_BUTTONS[button] ?? 'none';

/** Packs DOM modifier flags into the CDP modifier bitmask. */
export const remoteInputModifiers = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

export interface RemoteKeyEvent {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly location: number;
  readonly repeat: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  /** `getModifierState('AltGraph')`: Windows reports AltGr as Ctrl+Alt, which is not a chord. */
  readonly altGraph?: boolean;
}

/**
 * The text a key-down types by itself, or null when it is a command, a chord or a named key.
 *
 * Enter types a carriage return: CDP inserts a newline into a textarea (or submits a form) only for an
 * Enter key-down that carries `\r` as its text. Any other key types text only when the browser already
 * resolved it to ONE character (a code point, so an astral emoji counts). Ctrl and Cmd make a shortcut.
 * Alt alone is a shortcut for an ASCII key but
 * the layout's own character for a non-ASCII one (macOS Option+O is "ø"). AltGr is always layout
 * text: German "@" is AltGr+Q, and Windows reports AltGr as Ctrl+Alt.
 */
export const remoteKeyText = (event: RemoteKeyEvent): string | null => {
  if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) return '\r';
  if ([...event.key].length !== 1 || event.metaKey) return null;
  if (event.altGraph === true) return event.key;
  if (event.ctrlKey) return null;
  if (event.altKey) return (event.key.codePointAt(0) ?? 0) > 0x7f ? event.key : null;
  return event.key;
};

/**
 * Keys that start or continue an IME / dead-key composition rather than naming a key.
 * They must reach the page's text sink untouched: the composed text arrives as `insertText`.
 */
export const isRemoteCompositionKey = (event: { readonly key: string; readonly keyCode: number }): boolean =>
  event.keyCode === 229 || event.key === 'Dead' || event.key === 'Process' || event.key === 'Unidentified';

/**
 * Builds one keyboard input event. `text` is attached for a key-down that types a character (see
 * `remoteKeyText`): sending it for a chord would make Chrome insert the character *and* run the
 * shortcut.
 */
export const remoteKeyInput = (event: RemoteKeyEvent, type: 'keyDown' | 'keyUp'): BrowserInputEvent => {
  const text = type === 'keyDown' ? remoteKeyText(event) : null;
  const layoutText = event.altGraph === true;
  const modifiers = remoteInputModifiers(layoutText ? { ...event, altKey: false, ctrlKey: false } : event);
  return {
    kind: 'key',
    type,
    key: event.key,
    code: event.code,
    ...(text === null ? {} : { text, unmodifiedText: text }),
    windowsVirtualKeyCode: event.keyCode,
    nativeVirtualKeyCode: event.keyCode,
    modifiers,
    autoRepeat: event.repeat,
    isKeypad: event.location === 3,
  };
};

/**
 * Turns a retained key-down into the key-up that releases it. Modifiers are
 * cleared deliberately: the release runs after focus is already gone, so the
 * live modifier state is unknowable and a stale one would strand Chrome in it.
 */
export const remoteKeyRelease = (pressed: BrowserInputEvent): BrowserInputEvent | null => {
  if (pressed.kind !== 'key') return null;
  const { text: _text, unmodifiedText: _unmodifiedText, ...rest } = pressed;
  return { ...rest, type: 'keyUp', modifiers: 0, autoRepeat: false };
};

/** Tab copy comes from the real page, never from a client-side guess. */
export const remotePageLabel = (page: BrowserPageSummary): string => {
  const title = page.title.trim();
  if (title) return title;
  if (!page.url || page.url === 'about:blank') return 'New tab';
  try {
    return new URL(page.url).hostname || page.url;
  } catch {
    return page.url;
  }
};
