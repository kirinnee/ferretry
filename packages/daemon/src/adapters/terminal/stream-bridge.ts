import {
  planTerminalRedraw,
  type TerminalCapture,
  type TerminalViewerSize,
  terminalFullRedraw,
} from '../../lib/terminal/redraw.ts';
import { TERMINAL_REATTACH_LINES } from '../../lib/terminal/runtime-policy.ts';
import {
  admitTerminalFrame,
  decideTerminalSend,
  parseTerminalFrame,
  releaseTerminalFrame,
  TERMINAL_INPUT_REDRAW_LADDER_MS,
  TERMINAL_MAX_BUFFERED_OUTPUT_BYTES,
  TERMINAL_MAX_REDRAW_BYTES,
  TERMINAL_POLL_HISTORY_LINES,
  TERMINAL_REDRAW_POLL_MS,
  TERMINAL_STREAM_CLOSES,
  type TerminalStreamFrame,
} from '../../lib/terminal/stream-policy.ts';

export interface TerminalStreamService {
  write(sessionId: string, terminalId: string, bytes: Uint8Array): Promise<void>;
  resize(sessionId: string, terminalId: string, cols: number, rows: number): Promise<unknown>;
  /** The pane with its newest `historyLines` of history: a window for a poll, the whole limit for a full redraw. */
  capture(sessionId: string, terminalId: string, historyLines: number): Promise<TerminalCapture>;
  /**
   * What of a capture may be drawn at this instant. Asked synchronously, right where the bridge resumes
   * from a capture and before it sends or remembers a frame, so a screen that was fine when it was read
   * is not drawn after the terminal was quarantined. Absent, every capture may be drawn.
   */
  publishable?(sessionId: string, terminalId: string, capture: TerminalCapture): TerminalCapture;
}

export interface TerminalStreamDownstream {
  send(bytes: Uint8Array, permit?: () => boolean): number | undefined;
  close(code: number, reason: string): void;
  /** Bytes the transport is still holding, when it can report them. A transport that cannot is
   *  treated as drained, which is the only assumption under which a stream keeps flowing at all. */
  bufferedBytes?(): number;
}

/** A cancellable one-shot timer, so the bridge never holds a runtime timer handle. */
export interface TerminalStreamTimer {
  cancel(): void;
}

export interface TerminalStreamScheduler {
  schedule(callback: () => void, milliseconds: number): TerminalStreamTimer;
}

/**
 * WebSocket-shaped adapter that applies pure stream policy to the terminal lifecycle port.
 *
 * Output is a POLL, not a subscription: tmux offers a pane capture, not a delta feed. What this
 * stream SENDS is the smallest frame that turns the viewer's screen into the latest capture — the rows
 * that changed, or the lines that scrolled plus the screen — and a complete redraw only when there is
 * nothing it may safely be a delta against (`lib/terminal/redraw.ts` owns that decision). That is what
 * keeps the backpressure answer cheap — see `redraw`.
 */
export class TerminalStreamBridge {
  private closed = false;
  private queuedBytes = 0;
  private serial = Promise.resolve();
  private poll?: TerminalStreamTimer;
  /**
   * The capture of the last frame the transport ACCEPTED: what the viewer's screen shows now.
   *
   * Every frame is computed against it, so an unchanged pane sends nothing at all — an idle terminal
   * polled ten times a second used to cost ten identical full redraws a second, and over a relay each
   * one is a sealed record, a credit and a metered frame — and a changed one sends only the change.
   * Only a frame the transport took counts: one it DROPPED (`send` answering `0`) never reached the
   * viewer, so this is forgotten and the next poll sends a complete redraw. A resize forgets it too,
   * because the viewer's emulator has just reflowed — but only when the size actually changed.
   */
  private lastSent?: TerminalCapture;
  /**
   * The size this viewer last said its emulator is. A delta paints rows by position, which is only
   * right for an emulator the pane's own size; a viewer that never said, or whose size another viewer's
   * resize has since overridden, is sent complete redraws.
   */
  private viewer?: TerminalViewerSize;
  /**
   * Which rung of {@link TERMINAL_INPUT_REDRAW_LADDER_MS} the next poll uses. Past the last rung the
   * ordinary tick applies; a keystroke puts it back to the first.
   */
  private rung = TERMINAL_INPUT_REDRAW_LADDER_MS.length;

  constructor(
    private readonly service: TerminalStreamService,
    private readonly sessionId: string,
    private readonly terminalId: string,
    private readonly downstream: TerminalStreamDownstream,
    private readonly scheduler: TerminalStreamScheduler,
  ) {}

  async open(): Promise<void> {
    await this.redraw();
    this.schedule();
  }

  fromClient(frame: TerminalStreamFrame): void {
    if (this.closed) return;
    const parsed = parseTerminalFrame(frame);
    if (parsed.outcome === 'rejected') {
      this.finish(parsed.close.code, parsed.close.reason);
      return;
    }
    const admitted = admitTerminalFrame(this.queuedBytes, parsed.charged.bytes);
    if (admitted.outcome === 'rejected') {
      this.finish(admitted.close.code, admitted.close.reason);
      return;
    }
    this.queuedBytes = admitted.queuedBytes;
    this.serial = this.serial
      .then(async () => {
        if (parsed.charged.operation.kind === 'input') {
          await this.service.write(this.sessionId, this.terminalId, parsed.charged.operation.bytes);
          this.hurry();
        } else {
          const { cols, rows } = parsed.charged.operation.size;
          // Only a CHANGED size reflows the viewer's emulator. A repeat of the size it already has
          // keeps the picture, so the next poll stays a delta instead of a complete redraw.
          if (this.viewer?.cols !== cols || this.viewer?.rows !== rows) this.lastSent = undefined;
          this.viewer = { cols, rows };
          await this.service.resize(this.sessionId, this.terminalId, cols, rows);
        }
      })
      .catch(() =>
        this.finish(TERMINAL_STREAM_CLOSES.operationFailed.code, TERMINAL_STREAM_CLOSES.operationFailed.reason),
      )
      .finally(() => {
        this.queuedBytes = releaseTerminalFrame(this.queuedBytes, parsed.charged.bytes);
      });
  }

  close(): void {
    this.finish(
      TERMINAL_STREAM_CLOSES.viewerDisconnected.code,
      TERMINAL_STREAM_CLOSES.viewerDisconnected.reason,
      false,
    );
  }

  private schedule(): void {
    if (this.closed || this.poll) return;
    const delay = TERMINAL_INPUT_REDRAW_LADDER_MS[this.rung] ?? TERMINAL_REDRAW_POLL_MS;
    this.rung = Math.min(this.rung + 1, TERMINAL_INPUT_REDRAW_LADDER_MS.length);
    this.poll = this.scheduler.schedule(() => {
      this.poll = undefined;
      void this.redraw().finally(() => this.schedule());
    }, delay);
  }

  /**
   * Pull the next captures forward. An armed poll is re-armed on the first rung; one already capturing
   * picks the first rung up when it re-arms, so there is still never more than one capture in flight.
   */
  private hurry(): void {
    this.rung = 0;
    if (this.poll === undefined) return;
    this.poll.cancel();
    this.poll = undefined;
    this.schedule();
  }

  /**
   * Sends the frame that brings the viewer up to the pane, unless the viewer is already behind.
   *
   * BACKPRESSURE POLICY: DROP, never queue and never close. A viewer whose socket still holds more
   * than {@link TERMINAL_MAX_BUFFERED_OUTPUT_BYTES} is handed nothing — and is not even captured for,
   * so a stalled reader costs no tmux work either — and the next poll supersedes what was skipped.
   * A dropped frame loses nothing but latency, because the next one is computed from what the viewer
   * was last ACCEPTED to have, never from what it was merely sent: the viewer catches up to the present
   * state rather than replaying a backlog. Queueing instead would grow daemon memory without bound, and
   * closing would end a stream over a reader that is merely slow.
   */
  private async redraw(): Promise<void> {
    if (this.closed) return;
    if ((this.downstream.bufferedBytes?.() ?? 0) > TERMINAL_MAX_BUFFERED_OUTPUT_BYTES) return;
    try {
      // A poll reads a window of history; with no picture to be a delta against, the whole limit at once.
      const depth = this.lastSent === undefined ? TERMINAL_REATTACH_LINES : TERMINAL_POLL_HISTORY_LINES;
      let capture = this.publishable(await this.service.capture(this.sessionId, this.terminalId, depth));
      // CHECKED AGAIN, BECAUSE THE CAPTURE ABOVE IS AN AWAIT. The check at the top of this method was
      // the only one, so a capture in flight when `close()` landed still called `downstream.send`
      // afterwards — a bridge that had been told it was over, writing to a transport that was over
      // too. On a direct socket that is inert. On a relay it was not: the frame reached a session the
      // link had already concluded, and the rendezvous answers a frame naming no live session by
      // closing the DAEMON'S SOCKET, taking every other relayed session with it. The link now refuses
      // that frame on its own side as well; this is the half that belongs to whoever produced it.
      if (this.closed) return;
      const plan = planTerminalRedraw(this.lastSent, capture, this.viewer, TERMINAL_MAX_REDRAW_BYTES);
      if (plan.kind === 'unchanged') return;
      if (plan.kind === 'full' && depth !== TERMINAL_REATTACH_LINES) {
        // A complete redraw is worth the whole history the limit allows, not the poll's window. The
        // pane may have moved on in between; this second capture is simply the newer picture.
        capture = this.publishable(
          await this.service.capture(this.sessionId, this.terminalId, TERMINAL_REATTACH_LINES),
        );
        if (this.closed) return;
      }
      const frame = plan.kind === 'delta' ? plan.frame : terminalFullRedraw(capture, TERMINAL_MAX_REDRAW_BYTES);
      const shown = capture;
      const sent = this.downstream.send(
        new TextEncoder().encode(frame),
        this.service.publishable === undefined ? undefined : () => this.publishable(shown) === shown,
      );
      const result = decideTerminalSend(sent);
      if (result.outcome === 'rejected') {
        this.finish(result.close.code, result.close.reason);
        return;
      }
      this.lastSent = sent === 0 ? undefined : capture;
    } catch {
      this.finish(TERMINAL_STREAM_CLOSES.redrawFailed.code, TERMINAL_STREAM_CLOSES.redrawFailed.reason);
    }
  }

  /** The capture as it may be drawn NOW: asked synchronously where it resumes, so no hold can begin between the check and the send. */
  private publishable(capture: TerminalCapture): TerminalCapture {
    return this.service.publishable?.(this.sessionId, this.terminalId, capture) ?? capture;
  }

  private finish(code: number, reason: string, closeDownstream = true): void {
    if (this.closed) return;
    this.closed = true;
    this.poll?.cancel();
    this.poll = undefined;
    if (closeDownstream) this.downstream.close(code, reason);
  }
}
