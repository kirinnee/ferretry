/**
 * What the `machine` verbs need, behind ports so the pure rules and the terminal flow are tested without a daemon.
 * Moved from today's `fleet/account-ports.ts`, narrowed to what the machine verbs use.
 *
 * EVERY WRITE GOES THROUGH THE DAEMON. This terminal never edits a configuration file: it names one change, the daemon
 * derives the next setup and previews it, and a second explicit call applies exactly what was previewed. That is the
 * same reviewed path the app takes, so the two can never describe one change differently.
 */
import type {
  AccountChange,
  AccountChangeOutcome,
  AccountChangeView,
  CloneBundle,
  CloneReview,
  CloneReviewRequest,
  MachineView,
  SetupScan,
  ToolInstallResult,
} from '@ferretry/plugin-runtimes/contract';

/** A tool this machine knows, as the runtimes contract spells it. */
export type MachineHarness = MachineView['tools'][number]['harness'];

export interface IMachineGateway {
  machine(): Promise<MachineView>;
  stage(change: AccountChange): Promise<AccountChangeView>;
  apply(changeId: string): Promise<AccountChangeOutcome>;
  scan(): Promise<SetupScan>;
  installTools(harnesses: readonly MachineHarness[]): Promise<ToolInstallResult>;
  exportBundle(): Promise<CloneBundle>;
  reviewClone(request: CloneReviewRequest): Promise<CloneReview>;
  /** Whether a record of that source existed. */
  forgetCloneSource(source: string): Promise<boolean>;
}

/** The slice of the terminal these verbs print through. */
export interface IMachineOutput {
  /** Something worked. */
  success(message: string): void;
  /** stdout exactly as given: a report, or JSON for a script. */
  report(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** Asking a person something. Never used off a terminal. */
export interface IMachinePrompt {
  ask(message: string): Promise<string>;
}

/** Everything a machine verb needs, built once per call. */
export interface MachineDeps {
  readonly gateway: IMachineGateway;
  readonly out: IMachineOutput;
  readonly prompt: IMachinePrompt;
  /** Whether anybody is at a terminal to answer. */
  readonly interactive: boolean;
  /** A local file's text; throws when it cannot be read. */
  readonly readText: (path: string) => Promise<string>;
  /** The shipped command name, so every hint names a command that exists. */
  readonly binaryName: string;
}

/** The flags every write shares. */
export interface MachineWriteOptions {
  /** Show the preview and change nothing. */
  readonly dryRun?: boolean;
  /** Skip the question a destructive change asks, for a script. */
  readonly yes?: boolean;
  readonly json?: boolean;
}

/** A refusal these verbs report in plain words, with a non-zero exit. */
export class MachineCommandError extends Error {
  override readonly name = 'MachineCommandError';
}
