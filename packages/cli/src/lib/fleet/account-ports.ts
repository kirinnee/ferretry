import type {
  FleetAccountChange,
  FleetAccountChangeOutcome,
  FleetAccountChangeView,
  FleetCloneBundle,
  FleetComponentCatalog,
  FleetCredentialList,
  FleetCredentialView,
  FleetLayeredProfileCatalog,
  FleetMachineView,
  FleetRuntimeCatalog,
  FleetSetupScan,
  FleetToolInstallResult,
  HarnessLoginFlow,
  HarnessLoginSubmission,
} from '@ferretry/protocol';

/**
 * The ports the account-model commands (`setup`, `machine`, `runtime`, `credential`, `profile`,
 * `component`) share (docs/design/account-model.md §6.2).
 *
 * EVERY WRITE GOES THROUGH THE DAEMON. This terminal never edits a configuration file: it names one
 * change, the daemon derives the next setup and previews it, and a second explicit call applies
 * exactly what was previewed. That is the same reviewed path the browser takes, so the two can never
 * describe one change differently.
 */

/** Which harness a credential, tool or runtime belongs to. */
export type AccountHarness = 'claude' | 'codex';

/**
 * What a caller off this machine must show for one write.
 *
 * `unlock` is the short-lived header a locked caller trades its operator password for; `password` is
 * the per-change confirmation the daemon asks for again. Both live for one command and are never kept.
 */
export interface AccountAuthority {
  readonly unlock?: string;
  readonly password?: string;
}

/** The daemon routes the account model reads and writes through. Satisfied by the protocol client. */
export interface IAccountGateway {
  machine(): Promise<FleetMachineView>;
  components(): Promise<FleetComponentCatalog>;
  profiles(): Promise<FleetLayeredProfileCatalog>;
  runtimes(): Promise<FleetRuntimeCatalog>;
  credentials(): Promise<FleetCredentialList>;
  /** Trade the operator password for a short-lived unlock. */
  unlock(password: string): Promise<string>;
  check(credentialId: string, authority: AccountAuthority): Promise<FleetCredentialView>;
  stage(change: FleetAccountChange, authority: AccountAuthority): Promise<FleetAccountChangeView>;
  apply(changeId: string, authority: AccountAuthority): Promise<FleetAccountChangeOutcome>;
  scan(authority: AccountAuthority): Promise<FleetSetupScan>;
  installTools(harnesses: readonly AccountHarness[], authority: AccountAuthority): Promise<FleetToolInstallResult>;
  exportBundle(authority: AccountAuthority): Promise<FleetCloneBundle>;
  startSignIn(credentialId: string, authority: AccountAuthority): Promise<HarnessLoginFlow>;
  signInStatus(flowId: string, authority: AccountAuthority): Promise<HarnessLoginFlow>;
  submitSignInCode(flowId: string, code: string, authority: AccountAuthority): Promise<HarnessLoginSubmission>;
  cancelSignIn(flowId: string, authority: AccountAuthority): Promise<HarnessLoginFlow>;
}

/** The slice of the terminal these commands print through. The shipped console adapter satisfies it. */
interface IAccountOutput {
  /** Something worked. */
  success(message: string): void;
  /** stdout exactly as given: a report, or JSON for a script. */
  report(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** Asking a person something. Never used off a terminal. */
interface IAccountPrompt {
  ask(message: string): Promise<string>;
  /** A value the terminal must not echo: the operator password. */
  askSecret(message: string): Promise<string>;
}

/** Everything an account-model command needs, built once in the composition root. */
export interface AccountCommandDeps {
  readonly gateway: IAccountGateway;
  readonly out: IAccountOutput;
  readonly prompt: IAccountPrompt;
  /** Whether a person is at both ends of this terminal. Off a terminal nothing is ever asked. */
  readonly interactive: boolean;
  /** The shipped command name, so every hint names a command that exists. */
  readonly binaryName: string;
  /** The operator password from standard input, for a script off this machine. */
  readonly readPasswordFromStdin: () => Promise<string>;
  /** Read a local file a person named (a component's text, a clone bundle). */
  readonly readText: (path: string) => Promise<string>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
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
