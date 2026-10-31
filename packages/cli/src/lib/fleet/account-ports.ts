import type { IConfigGateway } from '../config/ports.ts';
import type {
  FleetAccountChange,
  FleetAccountChangeOutcome,
  FleetAccountChangeView,
  FleetCloneBundle,
  FleetComponentCatalog,
  FleetCredentialList,
  FleetCredentialTestResult,
  FleetCredentialView,
  FleetLayeredProfileCatalog,
  FleetMachineView,
  FleetProviderPresetCatalog,
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
  /** An environment login's Test (docs/provider-presets.md). `allowInference` is the consent to one token. */
  test(credentialId: string, allowInference: boolean): Promise<FleetCredentialTestResult>;
  /** The provider presets an environment login is made from. */
  presets(): Promise<FleetProviderPresetCatalog>;
  /**
   * Every secret NAME this daemon's store already holds — never a value — so a one-click add
   * (docs/provider-presets.md) can tell "already set ✓" from one it still has to fill.
   */
  secretNames(): Promise<ReadonlySet<string>>;
  /** Stores a secret VALUE for a one-click login. Never logged, never echoed, never read back. */
  putSecret(name: string, value: string): Promise<void>;
  stage(change: FleetAccountChange): Promise<FleetAccountChangeView>;
  apply(changeId: string): Promise<FleetAccountChangeOutcome>;
  scan(): Promise<FleetSetupScan>;
  installTools(harnesses: readonly AccountHarness[]): Promise<FleetToolInstallResult>;
  exportBundle(): Promise<FleetCloneBundle>;
  /** `method` is Codex's choice of sign-in; absent means its default, a device code. */
  /**
   * Start a credential's sign-in, or pick up the one already running for it (`resumed`). `restart`
   * ends that one — and clears a leftover Codex sign-in from the callback port — then starts afresh.
   */
  startSignIn(credentialId: string, method?: HarnessLoginCodexMethod, restart?: boolean): Promise<HarnessLoginFlow>;
  signInStatus(flowId: string): Promise<HarnessLoginFlow>;
  submitSignInCode(flowId: string, code: string): Promise<HarnessLoginSubmission>;
  /** Look in the store of a sign-in that ended `recheck` again, launching nothing. */
  recheckSignIn(flowId: string): Promise<HarnessLoginSubmission>;
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
  /** Like {@link ask}, but never echoed: for a secret value a one-click add still has to collect. */
  askHidden(message: string): Promise<string>;
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
  /**
   * The process environment, read-only: how `fy login add --from-env` sees what is already in this
   * shell (docs/provider-presets.md). A value may be `undefined` exactly as Node reports it.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * A secret VALUE piped in on stdin, off a terminal, for a one-click add with exactly one secret
   * still missing (the same path `fy secret set` uses). Never argv, never echoed.
   */
  readonly readSecretValue: () => Promise<string>;
  /** The checked configuration-file write `fy login budget` edits a login's file through. Absent: not offered. */
  readonly config?: Pick<IConfigGateway, 'file' | 'write'>;
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
