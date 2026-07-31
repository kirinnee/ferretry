import type {
  AttachmentView,
  SendRequest,
  SendResult,
  SessionView,
  SignalKind,
  SignalOptions,
} from '@ferretry/protocol';
import type { IClock, ISessionApi, ISessionFiles, ISessionIo } from '../../../src/lib/session/ports.ts';
import { SessionPresenter } from '../../../src/lib/session/presenter.ts';

/** Captured terminal output, so a test asserts what a user would actually see. */
export class CapturedIo implements ISessionIo {
  readonly out: string[] = [];
  readonly err: string[] = [];
  exitCode = 0;

  success(message: string): void {
    this.out.push(message);
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

/** A clock frozen at the instant the fixtures were written. */
const FROZEN_NOW = Date.parse('2026-01-01T00:10:00.000Z');
const frozenClock: IClock = { nowMs: () => FROZEN_NOW };

/** A stored attachment, as the daemon reports one after an upload. */
export const attachmentView: AttachmentView = {
  id: 'att-1',
  filename: 'shot.png',
  mime: 'image/png',
  size: 4,
  sha256: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z',
};

export interface ApiCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Every daemon call a session command can make, recorded rather than performed. */
export class RecordingApi implements ISessionApi {
  readonly calls: ApiCall[] = [];

  constructor(
    private readonly responses: {
      list?: SessionView[];
      get?: SessionView | (() => SessionView);
      suggestNames?: string[];
      start?: SessionView;
      send?: SendResult;
      answer?: SessionView;
      interrupt?: SessionView;
      resume?: SessionView;
      signal?: SessionView;
      upload?: AttachmentView;
      failWith?: Error;
    } = {},
  ) {}

  private record<T>(method: string, args: readonly unknown[], value: T | undefined): Promise<T> {
    this.calls.push({ method, args });
    if (this.responses.failWith !== undefined) return Promise.reject(this.responses.failWith);
    if (value === undefined) return Promise.reject(new Error(`the test did not stub ${method}`));
    return Promise.resolve(value);
  }

  list(): Promise<SessionView[]> {
    return this.record('list', [], this.responses.list);
  }

  get(id: string): Promise<SessionView> {
    const stub = this.responses.get;
    return this.record('get', [id], typeof stub === 'function' ? stub() : stub);
  }

  suggestNames(count: number): Promise<string[]> {
    return this.record('suggestNames', [count], this.responses.suggestNames);
  }

  start(...args: Parameters<ISessionApi['start']>): Promise<SessionView> {
    return this.record('start', args, this.responses.start);
  }

  send(id: string, input: SendRequest): Promise<SendResult> {
    return this.record('send', [id, input], this.responses.send);
  }

  answer(...args: Parameters<ISessionApi['answer']>): Promise<SessionView> {
    return this.record('answer', args, this.responses.answer);
  }

  interrupt(id: string): Promise<SessionView> {
    return this.record('interrupt', [id], this.responses.interrupt);
  }

  resume(id: string, message?: string): Promise<SessionView> {
    return this.record('resume', [id, message], this.responses.resume);
  }

  signal(id: string, kind: SignalKind, message?: string, options?: SignalOptions): Promise<SessionView> {
    return this.record('signal', [id, kind, message, options], this.responses.signal);
  }

  upload(id: string, file: string): Promise<AttachmentView> {
    return this.record('upload', [id, file], this.responses.upload);
  }

  /** The methods called, in order — the cheapest way to assert an ordering rule. */
  methods(): string[] {
    return this.calls.map(call => call.method);
  }
}

/** In-memory files, so a controller test never touches a disk. */
export class FakeFiles implements ISessionFiles {
  readonly reads: string[] = [];

  constructor(
    private readonly texts: Readonly<Record<string, string>> = {},
    private readonly attachments: Readonly<Record<string, { filename: string; mime?: string; base64: string }>> = {},
  ) {}

  readText(path: string): Promise<string> {
    this.reads.push(path);
    const text = this.texts[path];
    return text === undefined ? Promise.reject(new Error(`cannot read ${path}`)) : Promise.resolve(text);
  }

  readAttachment(path: string): Promise<{ filename: string; mime?: string; base64: string }> {
    this.reads.push(path);
    const attachment = this.attachments[path];
    return attachment === undefined
      ? Promise.reject(new Error(`cannot read attachment ${path}`))
      : Promise.resolve(attachment);
  }
}

/** A presenter writing into a captured IO with a frozen clock. */
export function capturedPresenter(): { io: CapturedIo; presenter: SessionPresenter } {
  const io = new CapturedIo();
  return { io, presenter: new SessionPresenter(io, frozenClock) };
}
