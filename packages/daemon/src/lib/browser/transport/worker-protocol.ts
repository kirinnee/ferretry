import {
  BROWSER_MAX_PAGE_ID_LENGTH,
  BrowserPageActionSnapshotSchema,
  BrowserPageSnapshotSchema,
  type BrowserErrorCode,
  type BrowserPageActionSnapshot,
  type BrowserPageSnapshot,
  type BrowserPageSummary,
  type BrowserScreencastFrame,
} from '@ferretry/protocol';

/** A page with no URL of its own is a blank tab; the wire schema has no room for an empty string. */
export const BLANK_PAGE_URL = 'about:blank';
export const MAX_WORKER_PAGES = 40;
export const MAX_WORKER_URL_CHARS = 4_096;
export const MAX_WORKER_TITLE_CHARS = 500;
export const MAX_WORKER_ERROR_CHARS = 200;
export const MAX_SCREENSHOT_BASE64_CHARS = 24 * 1024 * 1024;
export const MAX_FRAME_BASE64_CHARS = 16 * 1024 * 1024;
export const MAX_READ_TEXT_CHARS = 200_000;
/**
 * A screenshot reply is the largest legitimate record. Anything past it plus JSON overhead is a
 * worker that has lost the protocol, and there is no resynchronization point before the newline.
 */
export const MAX_WORKER_PROTOCOL_LINE_CHARS = MAX_SCREENSHOT_BASE64_CHARS + 2 * 1024 * 1024;

/** A transport failure with the wire error code and HTTP status the API surface should report. */
export class BrowserTransportError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BrowserTransportError';
  }
}

function bounded(value: unknown, limit: number, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, limit) : fallback;
}

/**
 * Page ids are opaque protocol identity, so truncation is never safe: a too-long id would otherwise
 * become the exact prefix of a real page's id.
 */
function pageIdentity(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= BROWSER_MAX_PAGE_ID_LENGTH
    ? value
    : undefined;
}

/**
 * Errors keep their first line and only then the length cap. Slicing alone lets a buggy worker
 * smuggle page text through the trailing lines of a short first line, and page content must never
 * reach a durable status.
 */
export function coarseWorkerError(value: unknown): string {
  return typeof value === 'string' ? (value.split(/\r?\n|\r/, 1)[0] ?? '').slice(0, MAX_WORKER_ERROR_CHARS) : '';
}

function workerErrorMessage(value: unknown): string {
  const coarse = coarseWorkerError(value);
  return coarse === '' ? 'unknown error' : coarse;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export type WorkerSnapshotResult<TSnapshot> =
  | { readonly ok: true; readonly value: TSnapshot }
  | { readonly ok: false; readonly message: string };

/**
 * The wire schema has the last word at this boundary, exactly as it does for client input: bounding a
 * worker's strings is not the same as knowing the result is a legal snapshot. Without this, a worker
 * that reports `'not a url'` produces a value that the HTTP surface later rejects as a 500, instead of
 * the upstream failure it actually is.
 */
function parsed<TSnapshot>(
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  candidate: unknown,
): WorkerSnapshotResult<TSnapshot> {
  const result = schema.safeParse(candidate);
  return result.success
    ? { ok: true, value: result.data as TSnapshot }
    : { ok: false, message: 'browser worker returned a snapshot the protocol rejects' };
}

/**
 * The worker is a separate process, so its page model is untrusted input: bound every string, cap the
 * tab list, and never let a malformed reply widen the typed snapshot the runtime consumes.
 */
export function normalizeWorkerSnapshot(value: unknown): WorkerSnapshotResult<BrowserPageSnapshot> {
  const raw = asRecord(value);
  const activePageId = pageIdentity(raw['activePageId']);
  if (activePageId === undefined) return { ok: false, message: 'browser worker returned an invalid active page' };

  const all = (Array.isArray(raw['pages']) ? raw['pages'] : []).reduce<BrowserPageSummary[]>((pages, item) => {
    const page = asRecord(item);
    const id = pageIdentity(page['id']);
    if (id !== undefined) {
      pages.push({
        id,
        // kteam let a missing URL through as an empty string, which the wire schema rejects, so a
        // blank tab could fail the whole status response.
        url: bounded(page['url'], MAX_WORKER_URL_CHARS, BLANK_PAGE_URL) || BLANK_PAGE_URL,
        title: bounded(page['title'], MAX_WORKER_TITLE_CHARS),
      });
    }
    return pages;
  }, []);

  const active = all.find(page => page.id === activePageId);
  // An activePageId naming no page is not something to paper over: a status built from it would show
  // an address bar and a tab strip that disagree.
  if (active === undefined) return { ok: false, message: 'browser worker returned an unknown active page' };
  // The cap must never be what hides the active tab — a popup arriving past the limit is exactly the
  // one the viewer is looking at. Spend the last slot on it and keep context order for the rest.
  let pages = all.slice(0, MAX_WORKER_PAGES);
  if (!pages.includes(active)) pages = [...pages.slice(0, MAX_WORKER_PAGES - 1), active];

  const state = raw['pageState'];
  const pageState = state === 'loading' || state === 'error' ? state : 'ready';
  const pageError = coarseWorkerError(raw['pageError']);
  return parsed(BrowserPageSnapshotSchema, {
    // Top-level identity derives from the active summary, so it can never drift from the tab it
    // claims to describe.
    url: active.url,
    title: active.title,
    pages,
    activePageId,
    pageState,
    // The wire schema allows an error string only in the error state, and demands one there.
    ...(pageState === 'error' ? { pageError: pageError === '' ? 'unknown error' : pageError } : {}),
    canGoBack: raw['canGoBack'] === true,
    canGoForward: raw['canGoForward'] === true,
  });
}

/**
 * `actedPageId` is validated on its own, NOT against `pages`: a close legitimately reports a page
 * that no longer exists, and a click reports the opener rather than the popup that is now active. A
 * worker that omits it is refused, because provenance defaulting to the active page misattributes.
 */
export function normalizeWorkerActionSnapshot(value: unknown): WorkerSnapshotResult<BrowserPageActionSnapshot> {
  const actedPageId = pageIdentity(asRecord(value)['actedPageId']);
  if (actedPageId === undefined) return { ok: false, message: 'browser worker returned no acted page' };
  const snapshot = normalizeWorkerSnapshot(value);
  if (!snapshot.ok) return snapshot;
  return parsed(BrowserPageActionSnapshotSchema, { ...snapshot.value, actedPageId });
}

/** Text results are bounded here so no page content can grow without limit inside the daemon. */
export function boundedReadText(value: unknown): string {
  return bounded(asRecord(value)['text'], MAX_READ_TEXT_CHARS);
}

export function boundedScreenshot(value: unknown): string {
  return bounded(asRecord(value)['screenshotBase64'], MAX_SCREENSHOT_BASE64_CHARS);
}

/** Everything a worker line can mean. Anything unrecognized is deliberately inert. */
export type WorkerEvent =
  | { readonly kind: 'ready' }
  | { readonly kind: 'fatal'; readonly message: string }
  | {
      readonly kind: 'frame';
      readonly frame: BrowserScreencastFrame;
      /**
       * Present when the worker wants the daemon to acknowledge this frame before the browser
       * captures the next one, so flow control follows the real path to the viewers.
       */
      readonly ackId?: number;
    }
  | { readonly kind: 'result'; readonly id: number; readonly result: unknown }
  | { readonly kind: 'failure'; readonly id: number; readonly message: string }
  | { readonly kind: 'ignored' };

const IGNORED: WorkerEvent = { kind: 'ignored' };

function parseFrame(message: Readonly<Record<string, unknown>>): WorkerEvent {
  const dataBase64 = message['dataBase64'];
  const width = message['width'];
  const height = message['height'];
  const framePageId = pageIdentity(message['pageId']);
  if (
    typeof dataBase64 !== 'string' ||
    dataBase64.length === 0 ||
    dataBase64.length > MAX_FRAME_BASE64_CHARS ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    // kteam forwarded frames with no identity and let the viewer discard them later. A frame that
    // cannot be attributed to a tab is unusable here, so it never enters the stream.
    framePageId === undefined
  ) {
    return IGNORED;
  }
  const ackId = message['ackId'];
  return {
    kind: 'frame',
    frame: {
      dataBase64,
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      pageId: framePageId,
    },
    // An unusable ack id is dropped rather than guessed at: acknowledging the wrong frame would
    // release a window the browser is still holding.
    ...(typeof ackId === 'number' && Number.isSafeInteger(ackId) ? { ackId } : {}),
  };
}

/** Parses one JSON line from the worker. Malformed lines are ignored, never fatal. */
export function parseWorkerLine(line: string): WorkerEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return IGNORED;
  }
  const message = asRecord(payload);
  switch (message['type']) {
    case 'ready':
      return { kind: 'ready' };
    case 'fatal':
      return { kind: 'fatal', message: workerErrorMessage(message['error']) };
    case 'screencast-frame':
      return parseFrame(message);
    default:
      break;
  }
  const id = message['id'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return IGNORED;
  return message['ok'] === true
    ? { kind: 'result', id, result: message['result'] }
    : { kind: 'failure', id, message: workerErrorMessage(message['error']) };
}

/** One request per line, so the worker can read it without a length prefix. */
export function encodeWorkerRequest(id: number, method: string, params: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify({ id, method, params })}\n`;
}

export interface WorkerLineBatch {
  readonly lines: readonly string[];
  /** A record with no newline in sight has no safe resynchronization point: stop the worker. */
  readonly overflowed: boolean;
}

/**
 * Splits the worker's stdout into JSON lines while refusing to retain an unbounded record. Kept as
 * pure state so the framing rule can be tested with no child involved.
 */
export class WorkerLineAssembler {
  private buffer = '';

  constructor(private readonly maxLineChars: number = MAX_WORKER_PROTOCOL_LINE_CHARS) {}

  push(chunk: string): WorkerLineBatch {
    this.buffer += chunk;
    const lines: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) {
        if (this.buffer.length > this.maxLineChars) {
          this.buffer = '';
          return { lines, overflowed: true };
        }
        return { lines, overflowed: false };
      }
      if (newline > this.maxLineChars) {
        this.buffer = '';
        return { lines, overflowed: true };
      }
      lines.push(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
    }
  }

  reset(): void {
    this.buffer = '';
  }
}
