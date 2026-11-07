import type {
  AccountChange,
  AccountChangeOutcome,
  AccountChangeView,
  ComponentCatalog,
  LayeredProfileCatalog,
  MachineView,
  Recommendation,
  RecommendationRequest,
  RuntimeCatalog,
  SetupScan,
} from '../../../contract/index.ts';

/**
 * The ports the runtime, profile, model-set, import, scan and recommend verbs share.
 *
 * EVERY WRITE GOES THROUGH THE DAEMON. This terminal never edits a configuration file: it names one
 * change, the daemon derives the next setup and previews it, and a second explicit call applies
 * exactly what was previewed. That is the same reviewed path the app takes, so the two can never
 * describe one change differently.
 */

/** The daemon routes these verbs read and write through (`/v1/runtimes/...`). */
export interface IRuntimesGateway {
  machine(): Promise<MachineView>;
  components(): Promise<ComponentCatalog>;
  profiles(): Promise<LayeredProfileCatalog>;
  runtimes(): Promise<RuntimeCatalog>;
  stage(change: AccountChange): Promise<AccountChangeView>;
  apply(changeId: string): Promise<AccountChangeOutcome>;
  scan(): Promise<SetupScan>;
  recommend(request: RecommendationRequest): Promise<Recommendation>;
}

/** The slice of the terminal these verbs print through; the shell's `TerminalIo` is adapted onto it. */
export interface IAccountOutput {
  /** Something worked. */
  success(message: string): void;
  /** stdout exactly as given: a report, or JSON for a script. */
  report(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** Asking a person something. Never used off a terminal. */
export interface IAccountPrompt {
  ask(message: string): Promise<string>;
}

/** Everything a verb needs, built once per call in `cli/index.ts`. */
export interface AccountCommandDeps {
  readonly gateway: IRuntimesGateway;
  readonly out: IAccountOutput;
  /**
   * Absent when nobody can be asked: a destructive change then needs `--yes`.
   * GAP(kernel): `TerminalIo` has out/err/isTty and no way to read an answer, so the shipped wiring never sets this.
   */
  readonly prompt?: IAccountPrompt;
  /** The shipped command name, so every hint names a command that exists. */
  readonly binaryName: string;
  /**
   * Milliseconds since the epoch, for `--until` waits and the "already passed" check.
   * GAP(kernel): `CliContext` carries no clock, so the shipped wiring leaves this unset and `--until` takes only an
   * absolute date or time.
   */
  readonly now?: () => number;
}

/** The flags every write shares. */
export interface AccountWriteOptions {
  /** Show the preview and change nothing. */
  readonly dryRun?: boolean;
  /** Skip the question a destructive change asks, for a script. */
  readonly yes?: boolean;
  readonly json?: boolean;
}

/** A refusal this terminal reports in plain words, with a non-zero exit. */
export class AccountCommandError extends Error {
  override readonly name = 'AccountCommandError';
}
