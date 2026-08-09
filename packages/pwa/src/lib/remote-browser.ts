import {
  BROWSER_MAX_PAGE_ID_LENGTH,
  type BrowserAction,
  type BrowserActionResult,
  BrowserActionResultSchema,
  type BrowserInputEvent,
  type BrowserPageSummary,
  type BrowserStatus,
  BrowserStatusSchema,
  FY_REQUEST_ID_HEADER,
} from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

/**
 * The daemon's browser frame envelope, v1: magic, version, page-id byte length,
 * page id, then the JPEG bytes, all in one binary message.
 *
 * These four bytes are ASCII `FYBF` and MUST stay byte-identical to the daemon's
 * `FRAME_ENVELOPE_MAGIC`, because the daemon owns the only encoder and this is a
 * second, hand-written decoder. The port originally kept the pre-Ferretry magic,
 * and the mismatch was INVISIBLE: an unrecognized magic used to be handed to the
 * viewer as an untagged JPEG, so every real frame's own header became "pixels"
 * and its page id was silently dropped. An unknown magic now fails closed, and
 * the legacy-wire gate rejects the old constant by name.
 */
const FRAME_MAGIC = Uint8Array.of(0x46, 0x59, 0x42, 0x46);
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 7;
const MAX_JPEG_BYTES = 8 * 1024 * 1024;

/**
 * One decoded frame.
 *
 * `decodeRemoteBrowserFrame` only ever returns `tagged`: a message it cannot
 * attribute to a page is rejected, not downgraded. The `legacy` member is
 * UNREACHABLE and retained only so existing consumers that still branch on it
 * keep compiling; it is removed together with the last such branch, and nothing
 * in this module can construct it.
 */
export type RemoteBrowserFrame =
  | { readonly kind: 'tagged'; readonly pageId: string; readonly jpegBytes: ArrayBuffer }
  | { readonly kind: 'legacy'; readonly jpegBytes: ArrayBuffer };

export type RemoteViewportMode = 'responsive' | 'desktop';

const assertScopeDaemon = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('browser scope must belong to the requested daemon');
};

const browserPath = (scope: DaemonSessionScope): string =>
  `/v1/sessions/${encodeURIComponent(scope.sessionId)}/browser`;

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/**
 * Browser identity is daemon-issued and read back from the response, so the
 * server-derived session id is checked against the requested scope before any
 * caller can act on it — a slow or crossed response must not publish another
 * session's state.
 */
const parseBrowserStatus = (scope: DaemonSessionScope, body: unknown): BrowserStatus => {
  const status = BrowserStatusSchema.parse(body);
  if (status.sessionId !== scope.sessionId) throw new DaemonResponseError(502, 'daemon returned another session');
  return status;
};

const parseBrowserActionResult = (scope: DaemonSessionScope, body: unknown): BrowserActionResult => {
  const result = BrowserActionResultSchema.parse(body);
  if (result.status.sessionId !== scope.sessionId)
    throw new DaemonResponseError(502, 'daemon returned another session');
  return result;
};

/** Reads the browser status from exactly the daemon that owns this session. */
export const fetchRemoteBrowserStatus = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = browserFetch,
): Promise<BrowserStatus> => {
  assertScopeDaemon(daemon, scope);
  const request = daemonRequest(daemon, browserPath(scope));
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return parseBrowserStatus(scope, await response.json());
};

/** Executes one validated browser action through the paired daemon. */
export const runRemoteBrowserAction = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  action: BrowserAction,
  fetcher: DaemonFetch = browserFetch,
): Promise<BrowserActionResult> => {
  assertScopeDaemon(daemon, scope);
  const request = daemonRequest(daemon, browserPath(scope), {
    method: 'POST',
    headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
    body: JSON.stringify(action),
  });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return parseBrowserActionResult(scope, await response.json());
};

/** Buys the short-lived credential the browser WebSocket must carry instead of a durable device token. */
export const fetchRemoteBrowserStreamTicket = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = browserFetch,
): Promise<string> => {
  assertScopeDaemon(daemon, scope);
  const request = daemonRequest(daemon, `${browserPath(scope)}/stream/ticket`, { method: 'POST' });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  const body = (await response.json()) as { readonly ticket?: unknown };
  if (typeof body.ticket !== 'string' || body.ticket.trim() === '')
    throw new DaemonResponseError(502, 'daemon returned no browser stream ticket');
  return body.ticket;
};

/**
 * Builds a viewer URL from a per-connection ticket. Device credentials are
 * deliberately absent: WebSocket URLs are routinely retained in diagnostics.
 */
export const remoteBrowserStreamUrl = (daemon: DaemonConnection, scope: DaemonSessionScope, ticket: string): string => {
  assertScopeDaemon(daemon, scope);
  if (ticket.trim() === '') throw new Error('browser stream ticket must not be empty');
  const url = new URL(`${browserPath(scope)}/stream`, `${daemon.baseUrl}/`);
  if (url.origin !== new URL(daemon.baseUrl).origin) throw new Error('browser stream must remain on the paired daemon');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return url.toString();
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

export const REMOTE_MULTI_CLICK_MS = 500;
export const REMOTE_MULTI_CLICK_SLOP = 5;
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
}

/**
 * Builds one keyboard input event. `text` is attached only for an unmodified
 * printable key-down: sending it for a chord would make Chrome insert the
 * character *and* run the shortcut.
 */
export const remoteKeyInput = (event: RemoteKeyEvent, type: 'keyDown' | 'keyUp'): BrowserInputEvent => {
  const printable = type === 'keyDown' && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
  return {
    kind: 'key',
    type,
    key: event.key,
    code: event.code,
    ...(printable ? { text: event.key, unmodifiedText: event.key } : {}),
    windowsVirtualKeyCode: event.keyCode,
    nativeVirtualKeyCode: event.keyCode,
    modifiers: remoteInputModifiers(event),
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
