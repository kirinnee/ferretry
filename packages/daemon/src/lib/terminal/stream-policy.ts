import { TerminalResizeFrameSchema, type TerminalSize } from '@ferretry/protocol';

/**
 * Pure policy for one attached terminal stream.
 *
 * A viewer socket carries pane bytes downstream and two kinds of client frame upstream: binary
 * frames are raw terminal input, text frames are bounded resize JSON. Everything in this module is
 * a decision about those frames — framing limits, operation parsing, the input queue budget, and
 * the backpressure/redraw ladder for a viewer that falls behind. There is no IO, no timer, and no
 * socket here: the caller owns the socket, the clock, and the terminal service, and applies the
 * decisions this module returns.
 */

/** Client frame as delivered by the socket: text control JSON, or binary terminal input. */
export type TerminalStreamFrame = string | ArrayBuffer | ArrayBufferView;

/** Text control frames are small; anything larger is a protocol abuse rather than a resize. */
export const TERMINAL_MAX_CONTROL_FRAME_BYTES = 16 * 1024;

/** A single paste is the largest legitimate input frame. */
export const TERMINAL_MAX_INPUT_FRAME_BYTES = 64 * 1024;

/** Total unwritten client input tolerated while writes drain into the pane. */
export const TERMINAL_MAX_QUEUED_INPUT_BYTES = 1024 * 1024;

/** Downstream buffer above which a viewer counts as behind and stops receiving raw deltas. */
export const TERMINAL_MAX_BUFFERED_OUTPUT_BYTES = 1024 * 1024;

/** How long to wait before re-testing a behind viewer's socket for a redraw. */
export const TERMINAL_REDRAW_POLL_MS = 100;

/** WebSocket close reasons this stream can produce, paired with their close codes. */
export const TERMINAL_STREAM_CLOSES = {
  viewerDisconnected: { code: 1000, reason: 'terminal viewer disconnected' },
  invalidFrame: { code: 1008, reason: 'invalid terminal input' },
  queueOverflow: { code: 1009, reason: 'terminal input queue exceeded' },
  operationFailed: { code: 1011, reason: 'terminal operation failed' },
  sendFailed: { code: 1011, reason: 'terminal output send failed' },
  redrawFailed: { code: 1011, reason: 'terminal redraw failed' },
  viewerUnavailable: { code: 1013, reason: 'terminal viewer unavailable' },
} as const;

export type TerminalStreamClose = (typeof TERMINAL_STREAM_CLOSES)[keyof typeof TERMINAL_STREAM_CLOSES];

/** A client frame reduced to the operation the terminal service must perform. */
export type TerminalOperation =
  | { readonly kind: 'input'; readonly bytes: Uint8Array }
  | { readonly kind: 'resize'; readonly size: TerminalSize };

/** An operation plus the byte weight charged against the input queue budget until it completes. */
export interface TerminalChargedOperation {
  readonly operation: TerminalOperation;
  readonly bytes: number;
}

export type TerminalFrameDecision =
  | { readonly outcome: 'accepted'; readonly charged: TerminalChargedOperation }
  | { readonly outcome: 'rejected'; readonly close: TerminalStreamClose };

export type TerminalQueueDecision =
  | { readonly outcome: 'queued'; readonly queuedBytes: number }
  | { readonly outcome: 'rejected'; readonly close: TerminalStreamClose };

export type TerminalSendDecision =
  | { readonly outcome: 'sent' }
  | { readonly outcome: 'rejected'; readonly close: TerminalStreamClose };

/** What to do with one chunk of pane output for this viewer. */
export type TerminalOutputDecision =
  /** Forward the raw delta as-is. */
  | { readonly action: 'forward' }
  /** Viewer is behind: drop the delta, mark the stream desynced, and owe it a full redraw. */
  | { readonly action: 'drop' };

/** Everything the redraw ladder needs to know about the stream, as owned by the caller. */
export interface TerminalRedrawState {
  readonly closed: boolean;
  readonly desynced: boolean;
  /** True while a snapshot is already in flight. */
  readonly redrawRunning: boolean;
  /** True while a redraw is already scheduled to fire. */
  readonly redrawScheduled: boolean;
  readonly bufferedBytes: number;
  /** Bumped by the caller on every dropped delta; identifies the desync a snapshot repairs. */
  readonly droppedVersion: number;
}

export type TerminalRedrawDecision =
  /** Nothing owed: the stream is closed, in sync, or already repairing itself. */
  | { readonly action: 'idle' }
  /** Still behind: wait `TERMINAL_REDRAW_POLL_MS` and ask again. */
  | { readonly action: 'defer' }
  /** Socket has drained: take a full pane snapshot and repair `version`. */
  | { readonly action: 'snapshot'; readonly version: number };

export type TerminalRedrawResolution =
  /** The snapshot covered every dropped delta; the stream is in sync again. */
  | { readonly outcome: 'resynced' }
  /** Deltas were dropped while the snapshot was in flight; stay desynced and redraw again. */
  | { readonly outcome: 'stale' };

/**
 * UTF-8 size of `value`, counted without allocating an encoded copy.
 *
 * Framing limits must be cheap to enforce: the size of a frame is the reason to reject it, so
 * encoding it first would let an oversized frame cost memory before it is refused.
 */
export function utf8ByteLength(value: string): number {
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) {
      total += 1;
    } else if (unit < 0x800) {
      total += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        total += 4;
        index += 1;
      } else {
        total += 3;
      }
    } else {
      total += 3;
    }
  }
  return total;
}

function rejected(close: TerminalStreamClose): { readonly outcome: 'rejected'; readonly close: TerminalStreamClose } {
  return { outcome: 'rejected', close };
}

function view(frame: Exclude<TerminalStreamFrame, string>): Uint8Array {
  if (ArrayBuffer.isView(frame)) return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  return new Uint8Array(frame);
}

function parseInputFrame(frame: Exclude<TerminalStreamFrame, string>): TerminalFrameDecision {
  const bytes = view(frame);
  if (bytes.byteLength > TERMINAL_MAX_INPUT_FRAME_BYTES) return rejected(TERMINAL_STREAM_CLOSES.invalidFrame);
  // Copy: the socket owns the delivered buffer and may reuse it before the write is serialised.
  return {
    outcome: 'accepted',
    charged: { operation: { kind: 'input', bytes: bytes.slice() }, bytes: bytes.byteLength },
  };
}

function parseControlFrame(frame: string): TerminalFrameDecision {
  const bytes = utf8ByteLength(frame);
  if (bytes > TERMINAL_MAX_CONTROL_FRAME_BYTES) return rejected(TERMINAL_STREAM_CLOSES.invalidFrame);
  let json: unknown;
  try {
    json = JSON.parse(frame);
  } catch {
    return rejected(TERMINAL_STREAM_CLOSES.invalidFrame);
  }
  const parsed = TerminalResizeFrameSchema.safeParse(json);
  if (!parsed.success) return rejected(TERMINAL_STREAM_CLOSES.invalidFrame);
  const { cols, rows } = parsed.data;
  return { outcome: 'accepted', charged: { operation: { kind: 'resize', size: { cols, rows } }, bytes } };
}

/**
 * Reduce one client frame to the operation it requests.
 *
 * Binary frames are raw input, bounded by {@link TERMINAL_MAX_INPUT_FRAME_BYTES}. Text frames are
 * resize control JSON, bounded by {@link TERMINAL_MAX_CONTROL_FRAME_BYTES} and validated against
 * the wire schema, so a resize outside the supported geometry is refused here rather than reaching
 * the pane. Every rejection closes the stream: a client that cannot frame correctly cannot be
 * trusted to keep driving a terminal.
 */
export function parseTerminalFrame(frame: TerminalStreamFrame): TerminalFrameDecision {
  return typeof frame === 'string' ? parseControlFrame(frame) : parseInputFrame(frame);
}

/**
 * Admit a parsed frame into the write queue, or refuse it when the client is producing input
 * faster than the pane can consume it.
 */
export function admitTerminalFrame(queuedBytes: number, frameBytes: number): TerminalQueueDecision {
  const queued = queuedBytes + frameBytes;
  if (queued > TERMINAL_MAX_QUEUED_INPUT_BYTES) return rejected(TERMINAL_STREAM_CLOSES.queueOverflow);
  return { outcome: 'queued', queuedBytes: queued };
}

/** Return the queue budget a completed (or failed) operation was holding. */
export function releaseTerminalFrame(queuedBytes: number, frameBytes: number): number {
  return Math.max(0, queuedBytes - frameBytes);
}

/**
 * Interpret a downstream send result. Sockets that report a negative written count have gone away
 * even though no error was thrown.
 */
export function decideTerminalSend(sent: number | undefined): TerminalSendDecision {
  if (typeof sent === 'number' && sent < 0) return rejected(TERMINAL_STREAM_CLOSES.viewerUnavailable);
  return { outcome: 'sent' };
}

/**
 * Decide whether a viewer still gets raw pane deltas.
 *
 * Once a socket is backed up, forwarding more deltas only grows the backlog, so deltas are dropped
 * and the stream owes the viewer one bounded full redraw instead. A stream that is already
 * desynced keeps dropping until that redraw lands.
 */
export function decideTerminalOutput(state: {
  readonly desynced: boolean;
  readonly bufferedBytes: number;
}): TerminalOutputDecision {
  if (state.desynced || state.bufferedBytes > TERMINAL_MAX_BUFFERED_OUTPUT_BYTES) return { action: 'drop' };
  return { action: 'forward' };
}

/** Whether a redraw poll should be armed now, given one may already be armed or running. */
export function shouldScheduleTerminalRedraw(state: TerminalRedrawState): boolean {
  return !state.closed && !state.redrawRunning && !state.redrawScheduled;
}

/** Decide what an armed redraw poll should do when it fires. */
export function decideTerminalRedraw(state: TerminalRedrawState): TerminalRedrawDecision {
  if (state.closed || !state.desynced || state.redrawRunning) return { action: 'idle' };
  if (state.bufferedBytes > TERMINAL_MAX_BUFFERED_OUTPUT_BYTES) return { action: 'defer' };
  return { action: 'snapshot', version: state.droppedVersion };
}

/**
 * Decide whether a delivered snapshot actually repaired the stream. Deltas dropped while the
 * snapshot was in flight advance the dropped version, which makes the snapshot already stale.
 */
export function resolveTerminalRedraw(snapshotVersion: number, droppedVersion: number): TerminalRedrawResolution {
  return snapshotVersion === droppedVersion ? { outcome: 'resynced' } : { outcome: 'stale' };
}
