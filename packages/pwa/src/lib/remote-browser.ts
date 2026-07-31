import {
  BROWSER_MAX_PAGE_ID_LENGTH,
  BrowserActionResultSchema,
  BrowserStatusSchema,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserStatus,
} from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
import { DaemonResponseError, type DaemonFetch } from './runtime-models.ts';

const FRAME_MAGIC = Uint8Array.of(0x4b, 0x42, 0x52, 0x46); // KBRF
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 7;
const MAX_JPEG_BYTES = 8 * 1024 * 1024;

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

/** Reads the browser status from exactly the daemon that owns this session. */
export const fetchRemoteBrowserStatus = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = fetch,
): Promise<BrowserStatus> => {
  assertScopeDaemon(daemon, scope);
  const request = daemonRequest(daemon, browserPath(scope));
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return BrowserStatusSchema.parse(await response.json());
};

/** Executes one validated browser action through the paired daemon. */
export const runRemoteBrowserAction = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  action: BrowserAction,
  fetcher: DaemonFetch = fetch,
): Promise<BrowserActionResult> => {
  assertScopeDaemon(daemon, scope);
  const request = daemonRequest(daemon, browserPath(scope), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kteam-request-id': crypto.randomUUID() },
    body: JSON.stringify(action),
  });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return BrowserActionResultSchema.parse(await response.json());
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

/** Decodes the daemon's atomic page-id/JPEG frame envelope, failing closed. */
export const decodeRemoteBrowserFrame = (message: ArrayBuffer): RemoteBrowserFrame | null => {
  const bytes = new Uint8Array(message);
  if (bytes.byteLength === 0) return null;
  const compared = Math.min(bytes.byteLength, FRAME_MAGIC.byteLength);
  const prefix = FRAME_MAGIC.slice(0, compared).every((value, index) => bytes[index] === value);
  if (prefix && bytes.byteLength < FRAME_MAGIC.byteLength) return null;
  const tagged =
    bytes.byteLength >= FRAME_MAGIC.byteLength && FRAME_MAGIC.every((value, index) => bytes[index] === value);
  if (!tagged) return bytes.byteLength <= MAX_JPEG_BYTES ? { kind: 'legacy', jpegBytes: message } : null;
  if (bytes.byteLength < FRAME_HEADER_BYTES || bytes[4] !== FRAME_VERSION) return null;
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
