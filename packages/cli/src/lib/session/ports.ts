import type {
  AttachmentView,
  SendRequest,
  SendResult,
  SessionView,
  SignalKind,
  SignalOptions,
  StartSessionRequestInput,
} from '@ferretry/protocol';

/**
 * Presentation port for the session controllers.
 *
 * Declared here rather than imported from `src/adapters` so the domain owns its own contract; the
 * shipped `ConsoleIo` adapter satisfies it structurally and the composition root bridges the two.
 * `success`/`warn` are stdout, `error` is stderr — which is why every advisory note a `--json`
 * caller must not see goes through `error`.
 */
export interface ISessionIo {
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/**
 * The daemon operations the session commands need, and nothing else.
 *
 * The CLI reaches the daemon only over the protocol client; this narrow port keeps the controllers
 * independent of the 30-method client interface and makes them testable with a hand-written double.
 */
export interface ISessionApi {
  list(): Promise<SessionView[]>;
  get(id: string): Promise<SessionView>;
  suggestNames(count: number): Promise<string[]>;
  start(input: StartSessionRequestInput, requestId?: string, boardCapability?: string): Promise<SessionView>;
  send(id: string, input: SendRequest): Promise<SendResult>;
  answer(id: string, toolUseId: string, labels: string[], other?: string, responses?: string[]): Promise<SessionView>;
  interrupt(id: string): Promise<SessionView>;
  resume(id: string, message?: string): Promise<SessionView>;
  signal(id: string, kind: SignalKind, message?: string, options?: SignalOptions): Promise<SessionView>;
  upload(id: string, file: string): Promise<AttachmentView>;
}

/** Wall-clock port — the liveness ledger renders ages, so the clock is injected, never ambient. */
export interface IClock {
  nowMs(): number;
}

/** Filesystem reads the session commands need: `--prompt-file`, `--message-file`, attachments. */
export interface ISessionFiles {
  /** Reads a UTF-8 text file, trimmed. Rejects with a caller-facing message when unreadable. */
  readText(path: string): Promise<string>;
  /** Reads a file as a base64 attachment payload. */
  readAttachment(path: string): Promise<{ filename: string; mime?: string; base64: string }>;
}

/**
 * Ambient facts the process supplies once, at the composition root.
 *
 * `callerSessionId` is `FY_SESSION_ID`: present when the caller is itself running inside a
 * Ferretry pane, which is what makes peer attribution and `send --ask` possible. The CLI never
 * reads the state home to learn any of this.
 */
export interface SessionEnvironment {
  readonly callerSessionId?: string;
  readonly cwd: string;
  readonly boardCapability?: string;
}
