import type {
  FyEvent,
  FyEventStreamFrame,
  FyEventStreamIdle,
  SessionAttachTarget,
  SessionState,
  SessionView,
} from '@ferretry/protocol';
import type {
  IMarkerProbe,
  IReadsClock,
  IReadsDeadline,
  IReadsGateway,
  IReadsIo,
  ITerminalAttacher,
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
 * Every sleep ADVANCES the clock by its own duration, which is what makes a wait timeout testable:
 * the loop believes the requested time passed, and the suite runs in microseconds.
 */
export class FakeClock implements IReadsClock {
  readonly sleeps: number[] = [];
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

/** An event as the socket wraps it. */
export const eventFrame = (sequence: number, overrides: Partial<FyEvent> = {}): FyEventStreamFrame => ({
  kind: 'event',
  event: fyEvent(sequence, overrides),
});

/** The daemon's proof that a scoped follow is quiet rather than broken. */
export const sessionIdleFrame = (sessionId: string, after: number, idleSeconds = 30): FyEventStreamIdle => ({
  kind: 'idle',
  idleSeconds,
  scope: { kind: 'session', sessionId, after },
});

/** The fleet form, which names a population instead of a cursor. */
export const fleetIdleFrame = (followedSessions: number, idleSeconds = 30): FyEventStreamIdle => ({
  kind: 'idle',
  idleSeconds,
  scope: { kind: 'fleet', followedSessions },
});

export const attachTarget = (overrides: Partial<SessionAttachTarget> = {}): SessionAttachTarget => ({
  socketPath: '/run/user/1000/fy/tmux.sock',
  tmuxSession: 'fy-s1',
  paneId: '%7',
  pid: 4_242,
  processStartTicks: 987_654,
  ...overrides,
});

/** The host handover behind `fy attach`, recorded rather than performed. */
export class RecordingAttacher implements ITerminalAttacher {
  readonly targets: SessionAttachTarget[] = [];

  constructor(
    private readonly code = 0,
    private readonly failure?: Error,
  ) {}

  async attach(target: SessionAttachTarget): Promise<number> {
    this.targets.push(target);
    if (this.failure !== undefined) throw this.failure;
    return this.code;
  }
}

/** The daemon reads, scripted per call so a loop can be walked one answer at a time. */
export class ScriptedReadsGateway implements IReadsGateway {
  readonly eventCalls: Array<{ id: string; after?: number; limit?: number }> = [];
  readonly historyCalls: Array<{ id: string; after?: number; limit?: number }> = [];
  readonly getCalls: string[] = [];
  readonly getSignals: Array<AbortSignal | undefined> = [];
  readonly logCalls: Array<{ id: string; turn?: number }> = [];
  readonly attachCalls: string[] = [];
  readonly streamCalls: Array<{ sessionId: string | undefined; after: number }> = [];
  readonly streamSignals: Array<AbortSignal | undefined> = [];

  constructor(
    private readonly script: {
      readonly views?: SessionView[];
      readonly pages?: FyEvent[][];
      readonly frames?: FyEventStreamFrame[];
      readonly history?: FyEvent[];
      readonly screen?: string;
      readonly transcript?: string;
      readonly target?: SessionAttachTarget;
      readonly getError?: Error;
      readonly attachError?: Error;
      readonly streamError?: Error;
      readonly blockGetUntilAbort?: boolean;
      readonly blockStreamUntilAbort?: boolean;
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

  async attachTarget(id: string): Promise<SessionAttachTarget> {
    this.attachCalls.push(id);
    if (this.script.attachError !== undefined) throw this.script.attachError;
    return this.script.target ?? attachTarget();
  }

  async snapshot(_id: string): Promise<string> {
    return this.script.screen ?? '';
  }

  async logs(id: string, turn?: number): Promise<string> {
    this.logCalls.push({ id, ...(turn === undefined ? {} : { turn }) });
    return this.script.transcript ?? '';
  }

  async events(id: string, after?: number, limit?: number): Promise<FyEvent[]> {
    this.eventCalls.push({ id, ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit }) });
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

  /**
   * Replays the scripted frames the way the socket would: events through `onEvent`, idle proofs
   * through `onIdle`, and — when asked — a feed that only ends because the caller cancelled it.
   */
  async stream(
    sessionId: string | undefined,
    after: number,
    onEvent: (event: FyEvent) => void,
    signal?: AbortSignal,
    onIdle?: (idle: FyEventStreamIdle) => void,
  ): Promise<void> {
    this.streamCalls.push({ sessionId, after });
    this.streamSignals.push(signal);
    if (this.script.streamError !== undefined) throw this.script.streamError;
    for (const frame of this.script.frames ?? []) {
      if (signal?.aborted === true) return;
      if (frame.kind === 'event') onEvent(frame.event);
      else onIdle?.(frame);
    }
    if (this.script.blockStreamUntilAbort !== true) return;
    if (signal === undefined) throw new Error('the blocking stream needs a cancellation signal');
    await new Promise<void>(done => {
      if (signal.aborted) done();
      else signal.addEventListener('abort', () => done(), { once: true });
    });
  }
}
