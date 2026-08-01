import type { FyEvent, SessionState, SessionView } from '@ferretry/protocol';
import type {
  IMarkerProbe,
  IReadsClock,
  IReadsDeadline,
  IReadsGateway,
  IReadsIo,
} from '../../../src/lib/reads/ports.ts';

export const INSTANT = '2026-02-01T09:08:07.000Z';

/** Terminal output, captured so a test can tell stdout from stderr and read the exit code. */
export class CapturingReadsIo implements IReadsIo {
  readonly out: string[] = [];
  readonly err: string[] = [];
  exitCode: number | undefined;

  success(message: string): void {
    this.out.push(message);
  }

  error(message: string): void {
    this.err.push(message);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }
}

/**
 * A clock that never actually waits.
 *
 * Every sleep ADVANCES the clock by its own duration, which is what makes a timeout and an idle notice
 * testable: the loop believes the requested time passed, and the suite runs in microseconds.
 */
export class FakeClock implements IReadsClock {
  readonly sleeps: number[] = [];
  afterSleep: (() => void) | undefined;
  readonly #deadlines: Array<{
    readonly at: number;
    readonly controller: AbortController;
    cancelled: boolean;
  }> = [];

  constructor(private current = 0) {}

  nowMs(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const deadline of this.#deadlines) {
      if (!deadline.cancelled && deadline.at <= this.current) deadline.controller.abort();
    }
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return;
    this.sleeps.push(milliseconds);
    this.advance(milliseconds);
    this.afterSleep?.();
  }

  startDeadline(milliseconds: number): IReadsDeadline {
    const deadline = {
      at: this.current + milliseconds,
      controller: new AbortController(),
      cancelled: false,
    };
    this.#deadlines.push(deadline);
    return {
      signal: deadline.controller.signal,
      cancel: () => {
        deadline.cancelled = true;
      },
    };
  }
}

/** A marker probe scripted with the polls at which the deliverable appears. */
export class ScriptedMarker implements IMarkerProbe {
  readonly asked: string[] = [];

  constructor(private readonly answers: boolean[] = []) {}

  resolve(path: string): string {
    return path.startsWith('/') ? path : `/work/${path}`;
  }

  async exists(path: string): Promise<boolean> {
    this.asked.push(path);
    return this.answers.shift() ?? false;
  }
}

export const sessionState = (overrides: Partial<SessionState> = {}): SessionState =>
  ({ status: 'running', ...overrides }) as SessionState;

export const sessionView = (state: SessionState): SessionView =>
  ({ config: { id: 's1' }, state, directory: '/state/s1' }) as unknown as SessionView;

export const fyEvent = (sequence: number, overrides: Partial<FyEvent> = {}): FyEvent => ({
  sequence,
  time: INSTANT,
  sessionId: 's1',
  type: 'session.created',
  source: 'daemon',
  data: { note: sequence },
  ...overrides,
});

/** The daemon reads, scripted per call so a poll loop can be walked one answer at a time. */
export class ScriptedReadsGateway implements IReadsGateway {
  readonly eventCalls: Array<{ id: string; after?: number; limit?: number }> = [];
  readonly historyCalls: Array<{ id: string; after?: number; limit?: number }> = [];
  readonly getCalls: string[] = [];
  readonly getSignals: Array<AbortSignal | undefined> = [];
  readonly logCalls: Array<{ id: string; turn?: number }> = [];
  readonly eventSignals: Array<AbortSignal | undefined> = [];

  constructor(
    private readonly script: {
      readonly views?: SessionView[];
      readonly pages?: FyEvent[][];
      readonly history?: FyEvent[];
      readonly screen?: string;
      readonly transcript?: string;
      readonly getError?: Error;
      readonly eventError?: Error;
      readonly blockGetUntilAbort?: boolean;
      readonly blockEventsUntilAbort?: boolean;
    } = {},
  ) {}

  async get(id: string, signal?: AbortSignal): Promise<SessionView> {
    this.getCalls.push(id);
    this.getSignals.push(signal);
    if (this.script.getError !== undefined) throw this.script.getError;
    if (this.script.blockGetUntilAbort === true) {
      if (signal === undefined) throw new Error('the blocking get needs a cancellation signal');
      await new Promise<never>((_resolve, reject) => {
        const cancel = (): void => reject(new Error('get cancelled'));
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      });
    }
    const views = this.script.views ?? [];
    return views.length > 1 ? (views.shift() as SessionView) : (views[0] ?? sessionView(sessionState()));
  }

  async snapshot(_id: string): Promise<string> {
    return this.script.screen ?? '';
  }

  async logs(id: string, turn?: number): Promise<string> {
    this.logCalls.push({ id, ...(turn === undefined ? {} : { turn }) });
    return this.script.transcript ?? '';
  }

  async events(id: string, after?: number, limit?: number, signal?: AbortSignal): Promise<FyEvent[]> {
    this.eventCalls.push({ id, ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit }) });
    this.eventSignals.push(signal);
    if (this.script.eventError !== undefined) throw this.script.eventError;
    if (this.script.blockEventsUntilAbort === true) {
      if (signal === undefined) throw new Error('the blocking event read needs a cancellation signal');
      await new Promise<never>((_resolve, reject) => {
        const cancel = (): void => reject(new Error('event read cancelled'));
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      });
    }
    return this.script.pages?.shift() ?? [];
  }

  async history(id: string, after?: number, limit?: number): Promise<FyEvent[]> {
    this.historyCalls.push({
      id,
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit }),
    });
    return this.script.history ?? [];
  }
}
