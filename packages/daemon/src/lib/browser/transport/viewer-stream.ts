import type { BrowserInputEvent, BrowserScreencastFrame } from '@ferretry/protocol';
import type { FrameClock, FrameTimer } from './contracts.ts';
import { encodeFrameEnvelope } from './envelope.ts';
import { type BrowserKeyInput, keyIdentity, keyReleaseSequence, normalizeBrowserInput } from './input.ts';
import {
  type BrowserViewerHost,
  VIEWER_CLOSE_INTERNAL,
  VIEWER_CLOSE_NORMAL,
  VIEWER_CLOSE_POLICY,
  VIEWER_CLOSE_TOO_LARGE,
  type ViewerAttachment,
  type ViewerDownstream,
  type ViewerStreamOptions,
  type ViewerTerminalSignal,
} from './viewer-contracts.ts';

export const MAX_INPUT_MESSAGE_BYTES = 256 * 1024;
export const MAX_QUEUED_INPUT_BYTES = 1024 * 1024;
/**
 * Frames are disposable state, not a replay stream: admit no bytes behind an already-buffered
 * socket, and keep exactly one latest envelope so recovery paints the current page.
 */
export const MAX_BUFFERED_BYTES = 0;
export const FRAME_RECOVERY_POLL_MS = 16;

/** What the client sent us, before it is known to be anything. */
export type ViewerInputChunk = string | ArrayBuffer | ArrayBufferView;

function chunkBytes(chunk: ViewerInputChunk): Uint8Array {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new Uint8Array(chunk);
}

function decodeBase64(text: string): Uint8Array | undefined {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * One authenticated viewer stream: atomic page-id/JPEG envelopes flow down, bounded JSON input flows
 * up. Neither direction is logged or persisted, and one slow viewer can never affect another —
 * frames are replaced rather than queued, so nothing accumulates per socket.
 */
export class BrowserViewerStream {
  private closed = false;
  private queuedInputBytes = 0;
  private serial: Promise<void> = Promise.resolve();
  private readonly pressedKeys = new Map<string, BrowserKeyInput>();
  private pendingFrame?: Uint8Array;
  private recoveryTimer?: FrameTimer;
  private readonly maxInputMessageBytes: number;
  private readonly maxQueuedInputBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly recoveryPollMs: number;

  private constructor(
    private readonly host: BrowserViewerHost,
    private readonly sessionId: string,
    private readonly downstream: ViewerDownstream,
    private readonly clock: FrameClock,
    private attachment: ViewerAttachment,
    options: ViewerStreamOptions,
  ) {
    this.maxInputMessageBytes = options.maxInputMessageBytes ?? MAX_INPUT_MESSAGE_BYTES;
    this.maxQueuedInputBytes = options.maxQueuedInputBytes ?? MAX_QUEUED_INPUT_BYTES;
    this.maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    this.recoveryPollMs = Math.max(1, options.recoveryPollMs ?? FRAME_RECOVERY_POLL_MS);
  }

  /**
   * Attaches to the session and starts streaming. Frames and terminal signals that arrive during the
   * attach round trip are replayed into the finished stream, newest state first.
   */
  static async connect(
    host: BrowserViewerHost,
    sessionId: string,
    downstream: ViewerDownstream,
    clock: FrameClock,
    options: ViewerStreamOptions = {},
  ): Promise<BrowserViewerStream> {
    let stream: BrowserViewerStream | undefined;
    let earlyFrame: BrowserScreencastFrame | undefined;
    let earlyTerminal: ViewerTerminalSignal | undefined;
    const attachment = await host.attachViewer(
      sessionId,
      frame => {
        if (stream) stream.acceptFrame(frame);
        else earlyFrame = frame;
      },
      terminal => {
        if (stream) stream.acceptTerminal(terminal);
        else earlyTerminal = terminal;
      },
    );
    stream = new BrowserViewerStream(host, sessionId, downstream, clock, attachment, options);
    // A session that already ended supersedes any frame it produced on the way out.
    if (earlyTerminal) stream.acceptTerminal(earlyTerminal);
    else if (earlyFrame) stream.acceptFrame(earlyFrame);
    return stream;
  }

  /** True once the stream has finished, whichever side ended it. */
  get finished(): boolean {
    return this.closed;
  }

  /** Resolves when every queued input dispatch, including held-key releases, has settled. */
  get settled(): Promise<void> {
    return this.serial;
  }

  /** Handles one client message: bounded, parsed, then dispatched in arrival order. */
  fromClient(chunk: ViewerInputChunk): void {
    if (this.closed) return;
    const bytes = chunkBytes(chunk);
    if (
      bytes.byteLength > this.maxInputMessageBytes ||
      this.queuedInputBytes + bytes.byteLength > this.maxQueuedInputBytes
    ) {
      this.finish(VIEWER_CLOSE_TOO_LARGE, 'browser input queue exceeded');
      return;
    }
    const decoded = this.parseInput(bytes);
    if (decoded === undefined) {
      this.finish(VIEWER_CLOSE_POLICY, 'invalid browser input');
      return;
    }
    // Held keys are recorded on admission, not on dispatch. kteam recorded them inside the serial
    // task, so a viewer that vanished before its keyDown ran left the page with the key stuck down.
    if (decoded.kind === 'key') {
      const identity = keyIdentity(decoded);
      if (decoded.type === 'keyDown') this.pressedKeys.set(identity, decoded);
      else this.pressedKeys.delete(identity);
    }
    this.queuedInputBytes += bytes.byteLength;
    this.serial = this.serial
      .then(async () => {
        if (this.closed) return;
        await this.host.dispatchHumanInput(this.sessionId, decoded);
      })
      .catch(() => {
        this.finish(VIEWER_CLOSE_INTERNAL, 'browser input failed');
      })
      .finally(() => {
        this.queuedInputBytes = Math.max(0, this.queuedInputBytes - bytes.byteLength);
      });
  }

  /** The viewer went away: release its keys and give up its slot without closing a dead socket. */
  close(): void {
    this.finish(VIEWER_CLOSE_NORMAL, 'browser viewer disconnected', false);
  }

  private parseInput(bytes: Uint8Array): BrowserInputEvent | undefined {
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return undefined;
    }
    const result = normalizeBrowserInput(payload);
    return result.ok ? result.value : undefined;
  }

  private acceptFrame(frame: BrowserScreencastFrame): void {
    if (this.closed) return;
    const bytes = decodeBase64(frame.dataBase64);
    // An undecodable or identity-free frame is one bad frame, not a broken viewer: kteam closed the
    // socket here, taking down a healthy view over a single corrupt payload.
    if (bytes === undefined) return;
    const envelope = encodeFrameEnvelope(frame.pageId, bytes);
    if (!envelope.ok) {
      if (envelope.message === 'frame exceeds the byte ceiling') {
        this.finish(VIEWER_CLOSE_TOO_LARGE, 'browser frame exceeded');
      }
      return;
    }
    // Replace, never queue: a viewer that fell behind wants the current pixels.
    this.pendingFrame = envelope.value;
    this.flushPendingFrame();
  }

  private flushPendingFrame(): void {
    if (this.closed || this.pendingFrame === undefined) return;
    if ((this.downstream.bufferedBytes?.() ?? 0) > this.maxBufferedBytes) {
      this.scheduleRecovery();
      return;
    }
    const envelope = this.pendingFrame;
    this.pendingFrame = undefined;
    let sent: number | void;
    try {
      sent = this.downstream.send(envelope);
    } catch {
      this.finish(VIEWER_CLOSE_INTERNAL, 'browser display send failed');
      return;
    }
    if (sent === 0) {
      // The transport dropped this frame rather than accepting it. Retain exactly this latest
      // envelope; a negative result is accepted-but-backpressured and must never be resent.
      this.pendingFrame = envelope;
      this.scheduleRecovery();
    }
  }

  private scheduleRecovery(): void {
    if (this.closed || this.pendingFrame === undefined || this.recoveryTimer !== undefined) return;
    this.recoveryTimer = this.clock.schedule(() => {
      this.recoveryTimer = undefined;
      this.flushPendingFrame();
    }, this.recoveryPollMs);
  }

  private acceptTerminal(terminal: ViewerTerminalSignal): void {
    this.finish(terminal.code, terminal.reason);
  }

  private finish(code: number, reason: string, closeDownstream = true): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingFrame = undefined;
    this.recoveryTimer?.cancel();
    this.recoveryTimer = undefined;

    const releases = keyReleaseSequence(this.pressedKeys.values());
    this.pressedKeys.clear();
    if (releases.length > 0) {
      const release = async (): Promise<void> => {
        for (const input of releases) {
          await this.host.dispatchHumanInput(this.sessionId, input).catch(() => undefined);
        }
      };
      this.serial = this.serial.then(release, release);
    }
    this.attachment.detach();
    if (!closeDownstream) return;
    try {
      this.downstream.close(code, reason);
    } catch {
      // The socket is already gone; there is nothing left to tell it.
    }
  }
}
