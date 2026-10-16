import {
  admitTerminalFrame,
  decideTerminalSend,
  parseTerminalFrame,
  releaseTerminalFrame,
  TERMINAL_INPUT_REDRAW_MS,
  TERMINAL_MAX_BUFFERED_OUTPUT_BYTES,
  TERMINAL_REDRAW_POLL_MS,
  TERMINAL_STREAM_CLOSES,
  type TerminalStreamFrame,
} from '../../lib/terminal/stream-policy.ts';

export interface TerminalStreamService {
  write(sessionId: string, terminalId: string, bytes: Uint8Array): Promise<void>;
  resize(sessionId: string, terminalId: string, cols: number, rows: number): Promise<unknown>;
  capture(sessionId: string, terminalId: string): Promise<Uint8Array>;
}

export interface TerminalStreamDownstream {
  send(bytes: Uint8Array): number | undefined;
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
 * Output is a POLL, not a subscription: tmux offers a pane capture, not a delta feed, so every frame
 * this stream sends is a complete redraw. That is what makes the backpressure answer cheap — see
 * `redraw`.
 */
export class TerminalStreamBridge {
  private closed = false;
  private queuedBytes = 0;
  private serial = Promise.resolve();
  private poll?: TerminalStreamTimer;
  /**
   * The last redraw the transport ACCEPTED, so an unchanged pane is not sent again.
   *
   * The poll runs ten times a second whether or not anything changed, and every frame is a complete
   * redraw — so an idle terminal was ten identical frames a second, forever, for as long as a viewer
   * watched. Over a relay each one is a sealed record, a credit and a metered frame. A redraw equal to
   * the one the viewer already has carries nothing, so it is skipped. Only a frame the transport took
   * counts: one it DROPPED (`send` answering `0`) never reached the viewer, so the next poll sends the
   * same picture again. A resize forgets it, because the viewer's emulator has just reflowed.
   */
  private lastSent?: Uint8Array;
  /** The next poll should come soon rather than on the ordinary tick: a keystroke wants its echo. */
  private soon = false;

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
          this.lastSent = undefined;
          const { cols, rows } = parsed.charged.operation.size;
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
    const delay = this.soon ? TERMINAL_INPUT_REDRAW_MS : TERMINAL_REDRAW_POLL_MS;
    this.soon = false;
    this.poll = this.scheduler.schedule(() => {
      this.poll = undefined;
      void this.redraw().finally(() => this.schedule());
    }, delay);
  }

  /**
   * Pull the next capture forward. An armed poll is re-armed short; one already capturing picks the
   * short delay up when it re-arms, so there is still never more than one capture in flight.
   */
  private hurry(): void {
    this.soon = true;
    if (this.poll === undefined) return;
    this.poll.cancel();
    this.poll = undefined;
    this.schedule();
  }

  /**
   * Sends one full pane snapshot, unless the viewer is already behind.
   *
   * BACKPRESSURE POLICY: DROP, never queue and never close. A viewer whose socket still holds more
   * than {@link TERMINAL_MAX_BUFFERED_OUTPUT_BYTES} is handed nothing — and is not even captured for,
   * so a stalled reader costs no tmux work either — and the next poll supersedes what was skipped.
   * Because every frame is a COMPLETE redraw, a dropped one loses nothing but latency: the viewer
   * catches up to the present state rather than replaying a backlog. Queueing instead would grow
   * daemon memory without bound, and closing would end a stream over a reader that is merely slow.
   */
  private async redraw(): Promise<void> {
    if (this.closed) return;
    if ((this.downstream.bufferedBytes?.() ?? 0) > TERMINAL_MAX_BUFFERED_OUTPUT_BYTES) return;
    try {
      const snapshot = await this.service.capture(this.sessionId, this.terminalId);
      // CHECKED AGAIN, BECAUSE THE CAPTURE ABOVE IS AN AWAIT. The check at the top of this method was
      // the only one, so a capture in flight when `close()` landed still called `downstream.send`
      // afterwards — a bridge that had been told it was over, writing to a transport that was over
      // too. On a direct socket that is inert. On a relay it was not: the frame reached a session the
      // link had already concluded, and the rendezvous answers a frame naming no live session by
      // closing the DAEMON'S SOCKET, taking every other relayed session with it. The link now refuses
      // that frame on its own side as well; this is the half that belongs to whoever produced it.
      if (this.closed) return;
      if (this.lastSent !== undefined && sameBytes(this.lastSent, snapshot)) return;
      const sent = this.downstream.send(snapshot);
      const result = decideTerminalSend(sent);
      if (result.outcome === 'rejected') {
        this.finish(result.close.code, result.close.reason);
        return;
      }
      this.lastSent = sent === 0 ? undefined : snapshot;
    } catch {
      this.finish(TERMINAL_STREAM_CLOSES.redrawFailed.code, TERMINAL_STREAM_CLOSES.redrawFailed.reason);
    }
  }

  private finish(code: number, reason: string, closeDownstream = true): void {
    if (this.closed) return;
    this.closed = true;
    this.poll?.cancel();
    this.poll = undefined;
    if (closeDownstream) this.downstream.close(code, reason);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
