import type {
  AttachmentView,
  SendRecord,
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
  /**
   * stdout exactly as given, for a rendering that carries its own colour. `success` paints green,
   * which flattens a report where one row must stand out — the amber of a `ps` row with no focus
   * card is the case that made this seam.
   */
  report(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/**
 * The one cell-level colour a session report carries: amber, for the cell a reader must notice (a
 * running session with no focus card). The composition root wires chalk in, so NO_COLOR and a
 * non-TTY stdout turn it into the identity — and the table measures column widths on the plain
 * text, never on what this returns.
 */
export interface ICellColour {
  amber(cell: string): string;
}

/**
 * The board read `ps` names each focus card's lane from, behind one method so the controller never
 * paginates or retries itself. When the board cannot be read the method rejects, and the caller
 * shows the card ids without lane names rather than failing the listing.
 */
export interface ISessionBoard {
  /** Every card the one read covered: card id → lane name. Cards it missed are simply absent. */
  laneNames(): Promise<ReadonlyMap<string, string>>;
}

/**
 * The daemon operations the session commands need, and nothing else.
 *
 * The CLI reaches the daemon only over the protocol client; this narrow port keeps the controllers
 * independent of the 30-method client interface and makes them testable with a hand-written double.
 */
export interface ISessionApi {
  list(): Promise<readonly SessionView[]>;
  get(id: string): Promise<SessionView>;
  suggestNames(count: number): Promise<string[]>;
  start(input: StartSessionRequestInput, requestId?: string): Promise<SessionView>;
  send(id: string, input: SendRequest): Promise<SendResult>;
  /** Where one send settled — the ledger fate the daemon has proven. */
  sendStatus(id: string, sendId: string): Promise<SendRecord>;
  answer(id: string, toolUseId: string, labels: string[], other?: string, responses?: string[]): Promise<SessionView>;
  interrupt(id: string): Promise<SessionView>;
  resume(id: string, message?: string): Promise<SessionView>;
  signal(id: string, kind: SignalKind, message?: string, options?: SignalOptions): Promise<SessionView>;
  /** Renames an agent: a new task title, a new first name, or both. */
  rename(id: string, name?: string, teammate?: string): Promise<SessionView>;
  upload(id: string, file: string): Promise<AttachmentView>;
}

/** Wall-clock port — the liveness ledger renders ages, so the clock is injected, never ambient. */
export interface IClock {
  nowMs(): number;
}

/** The clock a `send --wait` polls on, injected so the wait is testable without real time passing. */
export interface SendWaitClock {
  nowMs(): number;
  sleep(milliseconds: number): Promise<void>;
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
}
