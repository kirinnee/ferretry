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
  HarnessLoginCodexMethod,
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

/** The daemon routes the account model reads and writes through. Satisfied by the protocol client. */
export interface IAccountGateway {
  machine(): Promise<FleetMachineView>;
  components(): Promise<FleetComponentCatalog>;
  profiles(): Promise<FleetLayeredProfileCatalog>;
  runtimes(): Promise<FleetRuntimeCatalog>;
  credentials(): Promise<FleetCredentialList>;
  check(credentialId: string): Promise<FleetCredentialView>;
  stage(change: FleetAccountChange): Promise<FleetAccountChangeView>;
  apply(changeId: string): Promise<FleetAccountChangeOutcome>;
  scan(): Promise<FleetSetupScan>;
  installTools(harnesses: readonly AccountHarness[]): Promise<FleetToolInstallResult>;
  exportBundle(): Promise<FleetCloneBundle>;
  /** `method` is Codex's choice of sign-in; absent means its default, a device code. */
  startSignIn(credentialId: string, method?: HarnessLoginCodexMethod): Promise<HarnessLoginFlow>;
  signInStatus(flowId: string): Promise<HarnessLoginFlow>;
  submitSignInCode(flowId: string, code: string): Promise<HarnessLoginSubmission>;
  cancelSignIn(flowId: string): Promise<HarnessLoginFlow>;
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
