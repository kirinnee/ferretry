import type { FerretSummary, StartOptions } from '../../../contract/index.ts';

/**
 * Presentation port for the ferret verbs. `success`/`report`/`warn` are stdout, `error` is stderr — which is why every
 * advisory note a `--json` caller must not see goes through `error`. The CLI half's `VerbIo` satisfies it over the
 * shell's terminal, and keeps the exit code the verb answers.
 */
export interface ISessionIo {
  success(message: string): void;
  /** stdout exactly as given, for a rendering that carries its own colour. */
  report(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/**
 * The one cell-level colour a report carries: amber, for the cell a reader must notice. The shell's terminal carries
 * no colour, so the CLI half wires the identity; the table measures widths on the plain text either way.
 */
export interface ICellColour {
  amber(cell: string): string;
}

/**
 * `POST /v1/ferrets`'s body: who to start, on what, where, with which prompt (Ferrets' start, §2.2), and today's start
 * fields flat beside them (the contract's `StartOptions`: the model, the supervision timers, the label, …).
 */
export interface StartBody extends StartOptions {
  readonly name?: string;
  readonly parent?: string;
  readonly pack?: string;
  readonly role?: 'lead' | 'helper';
  readonly harness?: string;
  readonly runtime?: string;
  readonly login?: string;
  readonly folder: string;
  readonly prompt?: string;
}

/** What `fy rename` changes: a new first name, a new task title, or both. */
export interface RenameChange {
  readonly name?: string;
  readonly title?: string;
}

/** A lifecycle signal (`fy signal`): what the ferret says of its own work. */
export type SignalKind = 'done' | 'help' | 'waiting' | 'working';
export const SIGNAL_KINDS: readonly SignalKind[] = ['done', 'help', 'waiting', 'working'];

export interface SignalOptions {
  readonly until?: string;
  readonly condition?: string;
  readonly peer?: string;
}

/** What `POST /v1/ferrets/:ferretId/signal` answers about a declared wait. */
export interface SignalAnswer {
  readonly waiting?: {
    readonly until?: string;
    readonly condition?: string;
    readonly peer?: string;
    readonly peerName?: string;
  };
}

/**
 * The daemon operations the ferret verbs need, and nothing else: each is one Ferrets route (`/v1/ferrets/…`). The
 * controllers stay independent of the shell's client and testable with a hand-written double.
 */
export interface ISessionApi {
  list(): Promise<readonly FerretSummary[]>;
  /** One ferret, by id or name; the daemon resolves the name. */
  get(reference: string): Promise<FerretSummary>;
  suggestNames(count: number): Promise<string[]>;
  /** `requestId` is the caller's idempotency key (`--request-id`); omitted, the start mints its own. */
  start(body: StartBody, requestId?: string): Promise<{ readonly id: string }>;
  /** Stops one ferret; `reason` is recorded in its history. */
  stop(
    reference: string,
    reason?: string,
    how?: 'now' | 'polite',
  ): Promise<{ readonly id: string; readonly state?: string }>;
  /** Revives one ferret; `message` is recorded with the revival. */
  resume(reference: string, message?: string): Promise<{ readonly id: string }>;
  /** A new first name, a new task title, or both. */
  rename(reference: string, change: RenameChange): Promise<FerretSummary>;
  signal(reference: string, kind: SignalKind, message?: string, options?: SignalOptions): Promise<SignalAnswer>;
}

/** Wall-clock port — ages are rendered against it when the shell supplies one. */
export interface IClock {
  nowMs(): number;
}

/**
 * Ambient facts the shell supplies once. `callerSessionId` is the ferret this `fy` runs inside; `cwd` the folder a
 * start defaults to. Either may be unknown to a CLI half, and every verb that needs one says how to name it instead.
 */
export interface SessionEnvironment {
  readonly callerSessionId?: string;
  readonly cwd?: string;
}
