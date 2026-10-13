/**
 * Two things a Codex runtime does at launch that a session has to answer for
 * (docs/design/account-model.md §8.4; measured on codex 0.162.1, the U4 latest-version drift).
 *
 * ## The app-server daemon a Codex TUI leaves behind
 *
 * Codex starts a background app server under its OWN `CODEX_HOME` the first time a TUI runs there,
 * and it outlives the TUI: two processes, the server and its updater loop, each recorded in a pid
 * file under `<CODEX_HOME>/app-server-daemon/`, each running an executable Codex installed under
 * `<CODEX_HOME>/packages/app-server-daemon/`. `codex app-server daemon stop` stops the server and
 * leaves the updater running, so Ferretry stops both itself.
 *
 * Which daemon is a session's to stop is decided here, and the rule is narrow on purpose:
 *
 * - **Only a runtime's own config directory.** The home comes from the PUBLISHED account the session
 *   ran, and it must lie inside the fleet's homes directory. The person's own `~/.codex` — and any
 *   version-1 home configured outside the fleet — is never a candidate, whatever runs there.
 * - **Only when nothing else uses that home.** Two sessions on one runtime share one `CODEX_HOME`, and
 *   so does the person running that runtime's wrapper in their own terminal. A daemon is stopped only
 *   when no process other than the daemon pair still carries that `CODEX_HOME`.
 * - **Only a process that is that home's daemon.** A pid file is a claim, and a pid can be reused, so
 *   a pid is signalled only when the process's command line is an executable under that home's
 *   `packages/app-server-daemon/`. Anything else is left alone.
 * - **When in doubt, leave it running.** Every unknown — no pid file, a process that cannot be
 *   inspected, a home whose users cannot be listed — ends with the daemon left as Codex left it,
 *   which is exactly what happened before this existed. Stopping is housekeeping; it never fails a
 *   stop or a reap.
 *
 * ## Starting offline
 *
 * With a ChatGPT login, Codex asks the network for "workspace routing" while its TUI boots and exits
 * when it cannot reach it. The pane is left showing a JSON-RPC error and nothing else, so a session
 * that failed this way is told so in words: {@link CODEX_OFFLINE_LAUNCH_ERROR}.
 */
import { wrapperNameOf } from '@ferretry/fleet';

/** The sentence a launch failure starts with when Codex could not reach the network while starting. */
export const CODEX_OFFLINE_LAUNCH_ERROR = 'Codex needs a network connection to start';

/**
 * What Codex prints when its startup network call fails. Matched loosely enough to survive the
 * JSON-RPC code changing, and narrowly enough that no other failure reads as "offline".
 */
const OFFLINE_SIGNATURES: readonly RegExp[] = [/workspace routing discovery failed/iu];

/**
 * The launch error for a Codex pane that died while starting, or `undefined` when its screen does not
 * show the offline failure. `paneText` is what the dead pane last showed.
 */
export function codexLaunchFailure(paneText: string): string | undefined {
  if (!OFFLINE_SIGNATURES.some(signature => signature.test(paneText))) return undefined;
  return `${CODEX_OFFLINE_LAUNCH_ERROR}. It could not reach OpenAI while starting, so the session ended before it could take any work. Check this machine's network connection, then start the session again.`;
}

/** Where Codex records its app-server daemon's processes, under one `CODEX_HOME`. */
export function codexAppServerPidFiles(codexHome: string): readonly string[] {
  const directory = `${trimSlash(codexHome)}/app-server-daemon`;
  return [`${directory}/daemon.pid`, `${directory}/daemon-updater.pid`];
}

/** The directory every executable of one home's app-server daemon runs from. */
export function codexAppServerPackageDirectory(codexHome: string): string {
  return `${trimSlash(codexHome)}/packages/app-server-daemon/`;
}

/** The pid a Codex pid file records (`{"pid": N, …}`), or `undefined` for anything else. */
export function parseCodexPidFile(text: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const pid = (parsed as { readonly pid?: unknown }).pid;
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

/** Whether `commandLine` is a process running an executable from that home's app-server package. */
export function isCodexAppServerProcess(codexHome: string, commandLine: string): boolean {
  return commandLine.trimStart().startsWith(codexAppServerPackageDirectory(codexHome));
}

/** One published account, as much of it as this decision reads. */
export interface CodexRuntimeAccount {
  readonly kind: 'claude' | 'codex';
  readonly wrapper: string;
  readonly home: string;
}

/**
 * The `CODEX_HOME` whose daemon a session that ran `wrapper` may have started, or `undefined` when it
 * ran nothing Ferretry publishes as a Codex runtime with a home inside `homesDirectory`.
 */
export function codexRuntimeHome(
  wrapper: string,
  published: readonly CodexRuntimeAccount[],
  homesDirectory: string,
): string | undefined {
  const name = wrapperNameOf(wrapper);
  const account = published.find(row => row.wrapper === wrapper || wrapperNameOf(row.wrapper) === name);
  if (account?.kind !== 'codex') return undefined;
  const homes = `${trimSlash(homesDirectory)}/`;
  const home = trimSlash(account.home);
  // Inside the homes directory, with no `.`/`..` segment that could climb back out of it.
  if (!home.startsWith(homes) || home.split('/').some(segment => segment === '.' || segment === '..')) return undefined;
  return home;
}

const trimSlash = (path: string): string => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path);

/** The published accounts. Satisfied by the daemon's manifest inventory. */
export interface CodexRuntimeInventory {
  accounts(): Promise<readonly CodexRuntimeAccount[]>;
}

/** The process boundary this needs, and nothing more. */
export interface CodexAppServerProcesses {
  /** A file's text, or `undefined` when it is not there. */
  read(path: string): Promise<string | undefined>;
  /** The full command line of a live process, or `undefined` when it is gone or cannot be read. */
  commandLine(pid: number): Promise<string | undefined>;
  /**
   * Every live process whose environment sets `CODEX_HOME` to exactly `codexHome`, or `undefined`
   * when this host cannot say — which this module treats as "somebody might".
   */
  usersOf(codexHome: string): Promise<readonly number[] | undefined>;
  /** Ask a process to exit. */
  terminate(pid: number): Promise<void>;
}

export interface CodexAppServerSupervisorDeps {
  readonly inventory: CodexRuntimeInventory;
  readonly processes: CodexAppServerProcesses;
  /** `<FY_HOME>/fleet/homes`: the only place a runtime's config directory may be. */
  readonly homesDirectory: string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /**
   * How many times to look again for the session's own harness to finish exiting. A killed pane's
   * process takes a moment to go, and until it does it is a user of the home like any other.
   */
  readonly attempts?: number;
  readonly intervalMs?: number;
}

/** What one call decided, as a value a test can assert on. */
export type CodexAppServerOutcome =
  | { readonly kind: 'not-a-codex-runtime' }
  | { readonly kind: 'in-use'; readonly home: string }
  | { readonly kind: 'not-running'; readonly home: string }
  | { readonly kind: 'stopped'; readonly home: string; readonly pids: readonly number[] }
  | { readonly kind: 'undecided'; readonly reason: string };

/**
 * Stops the app-server daemon a finished session's Codex runtime started, when nothing else is using
 * that runtime. Called after a stop and after a reap; never throws.
 */
export class CodexAppServerSupervisor {
  constructor(private readonly deps: CodexAppServerSupervisorDeps) {}

  async afterSessionEnded(wrapper: string): Promise<CodexAppServerOutcome> {
    try {
      return await this.#settle(wrapper);
    } catch (error) {
      return { kind: 'undecided', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async #settle(wrapper: string): Promise<CodexAppServerOutcome> {
    const home = codexRuntimeHome(wrapper, await this.deps.inventory.accounts(), this.deps.homesDirectory);
    if (home === undefined) return { kind: 'not-a-codex-runtime' };
    const daemon = await this.#daemonPids(home);
    if (daemon.length === 0) return { kind: 'not-running', home };
    const attempts = this.deps.attempts ?? 10;
    for (let attempt = 1; ; attempt++) {
      const users = await this.deps.processes.usersOf(home);
      if (users === undefined) return { kind: 'undecided', reason: `who is using ${home} could not be listed` };
      if (users.every(pid => daemon.includes(pid))) break;
      if (attempt >= attempts) return { kind: 'in-use', home };
      await this.deps.sleep(this.deps.intervalMs ?? 200);
    }
    for (const pid of daemon) await this.deps.processes.terminate(pid);
    return { kind: 'stopped', home, pids: daemon };
  }

  /** The recorded daemon pids whose process really is this home's daemon right now. */
  async #daemonPids(home: string): Promise<readonly number[]> {
    const pids: number[] = [];
    for (const file of codexAppServerPidFiles(home)) {
      const text = await this.deps.processes.read(file);
      const pid = text === undefined ? undefined : parseCodexPidFile(text);
      if (pid === undefined) continue;
      const commandLine = await this.deps.processes.commandLine(pid);
      if (commandLine !== undefined && isCodexAppServerProcess(home, commandLine)) pids.push(pid);
    }
    return pids;
  }
}
