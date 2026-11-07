import type { FerretSummary } from '../../../../contract/index.ts';
import type {
  ISessionApi,
  ISessionIo,
  RenameChange,
  SignalAnswer,
  SignalKind,
  SignalOptions,
  StartBody,
} from '../../../../cli/lib/session/ports.ts';
import { SessionPresenter } from '../../../../cli/lib/session/presenter.ts';
import { sessionView } from './session-fixtures.ts';

/** Captured terminal output, so a test asserts what a user would actually see. */
export class CapturedIo implements ISessionIo {
  readonly out: string[] = [];
  readonly err: string[] = [];
  /** The same stdout as `out`, recorded apart so a test can tell the unpainted seam was used. */
  readonly reported: string[] = [];
  exitCode = 0;

  success(message: string): void {
    this.out.push(message);
  }

  report(message: string): void {
    this.out.push(message);
    this.reported.push(message);
  }

  warn(message: string): void {
    this.out.push(message);
  }

  error(message: string): void {
    this.err.push(message);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }
}

export interface ApiCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Every daemon call a ferret verb can make, recorded rather than performed. */
export class RecordingApi implements ISessionApi {
  readonly calls: ApiCall[] = [];

  constructor(
    private readonly responses: {
      list?: FerretSummary[];
      get?: FerretSummary | ((reference: string) => FerretSummary);
      suggestNames?: string[];
      rename?: FerretSummary;
      signal?: SignalAnswer;
      failWith?: Error;
    } = {},
  ) {}

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.responses.failWith !== undefined) throw this.responses.failWith;
  }

  async list(): Promise<readonly FerretSummary[]> {
    this.record('list');
    return this.responses.list ?? [];
  }

  async get(reference: string): Promise<FerretSummary> {
    this.record('get', reference);
    const get = this.responses.get;
    return typeof get === 'function' ? get(reference) : (get ?? sessionView({ id: reference }));
  }

  async suggestNames(count: number): Promise<string[]> {
    this.record('suggestNames', count);
    return this.responses.suggestNames ?? [];
  }

  async start(body: StartBody): Promise<{ readonly id: string }> {
    this.record('start', body);
    return { id: 'ses-1' };
  }

  async stop(
    reference: string,
    reason?: string,
    how?: 'now' | 'polite',
  ): Promise<{ readonly id: string; readonly state?: string }> {
    this.record('stop', reference, reason, how);
    return { id: reference, state: 'stopped' };
  }

  async resume(reference: string, message?: string): Promise<{ readonly id: string }> {
    this.record('resume', reference, message);
    return { id: reference };
  }

  async rename(reference: string, change: RenameChange): Promise<FerretSummary> {
    this.record('rename', reference, change);
    return (
      this.responses.rename ??
      sessionView({
        id: reference,
        ...(change.name === undefined ? {} : { name: change.name }),
        ...(change.title === undefined ? {} : { title: change.title }),
      })
    );
  }

  async signal(reference: string, kind: SignalKind, message?: string, options?: SignalOptions): Promise<SignalAnswer> {
    this.record('signal', reference, kind, message, options);
    return this.responses.signal ?? {};
  }

  methods(): string[] {
    return this.calls.map(call => call.method);
  }
}

export function capturedPresenter(): { io: CapturedIo; presenter: SessionPresenter } {
  const io = new CapturedIo();
  return { io, presenter: new SessionPresenter(io) };
}
