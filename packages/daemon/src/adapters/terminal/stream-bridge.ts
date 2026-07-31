import {
  admitTerminalFrame,
  decideTerminalSend,
  parseTerminalFrame,
  releaseTerminalFrame,
  TERMINAL_REDRAW_POLL_MS,
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
}

export interface TerminalStreamScheduler {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** WebSocket-shaped adapter that applies pure stream policy to the terminal lifecycle port. */
export class TerminalStreamBridge {
  private closed = false;
  private queuedBytes = 0;
  private serial = Promise.resolve();
  private poll?: unknown;

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
        } else {
          const { cols, rows } = parsed.charged.operation.size;
          await this.service.resize(this.sessionId, this.terminalId, cols, rows);
        }
      })
      .catch(() => this.finish(1011, 'terminal operation failed'))
      .finally(() => {
        this.queuedBytes = releaseTerminalFrame(this.queuedBytes, parsed.charged.bytes);
      });
  }

  close(): void {
    this.finish(1000, 'terminal viewer disconnected', false);
  }

  private schedule(): void {
    if (this.closed || this.poll) return;
    this.poll = this.scheduler.setTimeout(() => {
      this.poll = undefined;
      void this.redraw().finally(() => this.schedule());
    }, TERMINAL_REDRAW_POLL_MS);
  }

  private async redraw(): Promise<void> {
    if (this.closed) return;
    try {
      const sent = this.downstream.send(await this.service.capture(this.sessionId, this.terminalId));
      const result = decideTerminalSend(sent);
      if (result.outcome === 'rejected') this.finish(result.close.code, result.close.reason);
    } catch {
      this.finish(1011, 'terminal redraw failed');
    }
  }

  private finish(code: number, reason: string, closeDownstream = true): void {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) this.scheduler.clearTimeout(this.poll);
    this.poll = undefined;
    if (closeDownstream) this.downstream.close(code, reason);
  }
}
