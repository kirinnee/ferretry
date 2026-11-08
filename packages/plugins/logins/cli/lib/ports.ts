import type { ChangeAuthority } from './authority.ts';
import type {
  HarnessLoginCodexMethod,
  HarnessLoginFlow,
  HarnessLoginSubmission,
  LoginChange,
  LoginChangeOutcome,
  LoginChangeView,
  LoginList,
  LoginTestResult,
  LoginView,
  ModelCatalogRefreshResult,
  ModelCatalogsView,
  ProviderPresetCatalog,
} from '../../contract/index.ts';

/**
 * The ports the login verbs share. A sign-in is the harness's own: the daemon holds no token while it runs, and
 * this terminal only shows the page to open and hands one code (or address) back, which goes straight to the
 * harness child and is kept nowhere.
 */

/** The daemon routes these verbs read and write through (`/v1/logins/...`, `/v1/models...`). */
export interface ILoginsGateway {
  logins(): Promise<LoginList>;
  check(loginId: string): Promise<LoginView>;
  /** An environment login's Test. `allowInference` is the consent to one token. */
  test(loginId: string, allowInference: boolean): Promise<LoginTestResult>;
  presets(): Promise<ProviderPresetCatalog>;
  models(): Promise<ModelCatalogsView>;
  refreshModels(): Promise<ModelCatalogRefreshResult>;
  /**
   * Start a login's sign-in, or pick up the one already running for it (`resumed`). `restart` ends that one, and
   * clears a leftover Codex sign-in from the callback port, then starts afresh.
   */
  startSignIn(loginId: string, method?: HarnessLoginCodexMethod, restart?: boolean): Promise<HarnessLoginFlow>;
  signInStatus(flowId: string): Promise<HarnessLoginFlow>;
  submitSignInCode(flowId: string, code: string): Promise<HarnessLoginSubmission>;
  /** Look in the store of a sign-in that ended `recheck` again, launching nothing. */
  recheckSignIn(flowId: string): Promise<HarnessLoginSubmission>;
  cancelSignIn(flowId: string): Promise<HarnessLoginFlow>;
  /** What this caller may do to the machine: Gate's grants for the fleet's `configure` axis. */
  authority(): Promise<ChangeAuthority>;
  /** Hold one change and say what applying it would do. Nothing is written. */
  stage(change: LoginChange): Promise<LoginChangeView>;
  /** Apply exactly the change that was staged. */
  apply(changeId: string): Promise<LoginChangeOutcome>;
}

/** The slice of the terminal these verbs print through; the shell's `TerminalIo` is adapted onto it. */
export interface ILoginsOutput {
  /** Something worked. */
  success(message: string): void;
  /** stdout exactly as given: a report, or JSON for a script. */
  report(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** Asking a person something. Never used off a terminal. */
interface ILoginsPrompt {
  ask(message: string): Promise<string>;
}

/** Everything a verb needs, built once per call in `cli/index.ts`. */
export interface LoginsCommandDeps {
  readonly gateway: ILoginsGateway;
  readonly out: ILoginsOutput;
  /** Absent when nobody can be asked (no terminal): a sign-in that needs a pasted code is then refused. */
  readonly prompt?: ILoginsPrompt;
  /** The shipped command name, so every hint names a command that exists. */
  readonly binaryName: string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
}

/** A refusal this terminal reports in plain words, with a non-zero exit. */
export class LoginsCommandError extends Error {
  override readonly name = 'LoginsCommandError';
}
