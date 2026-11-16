/**
 * What a Codex runtime leaves behind at launch that a session has to answer for (docs/design/account-model.md §8.4;
 * measured on codex 0.162.1, the U4 latest-version drift). Starting offline is the contract's `codex-launch.ts`.
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
 *   a pid is signalled only when the KERNEL finds the process still running from that home's
 *   `packages/app-server-daemon/`. Anything else is left alone.
 * - **When in doubt, leave it running.** Every unknown — no pid file, a process that cannot be
 *   inspected, a home whose users cannot be listed — ends with the daemon left as Codex left it,
 *   which is exactly what happened before this existed. Stopping is housekeeping; it never fails a
 *   stop or a reap.
 */
import type { FencedPath, OwnFolder, ProcessesPort, RootHandle } from '@ferretry/kernel/contract';
import { wrapperNameOf } from '../manifest.ts';

/** Where Codex records its app-server daemon processes, relative to ONE `CODEX_HOME`. */
const CODEX_PID_FILES = ['app-server-daemon/daemon.pid', 'app-server-daemon/daemon-updater.pid'] as const;

/** The folder every executable of one home's app-server daemon runs from, relative to that home. */
const APP_SERVER_PACKAGES = 'packages/app-server-daemon';

/** A pid file is a few dozen bytes; anything larger is not one. */
const PID_FILE_LIMIT = 4096;

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
interface CodexRuntimeInventory {
  accounts(): Promise<readonly CodexRuntimeAccount[]>;
}

/**
 * What the supervisor stands on: the fleet root (unscoped; every path below is under `homes/<id>` of ONE validated
 * runtime id) and the kernel's process port. The kernel answers pids and yes/no only (never a command line or an
 */
export interface CodexAppServerHost {
  /** `kernel.roots.root('fleet')`, UNSCOPED: the kernel answers a process question only for a folder at or under `homes/<id>` of the whole fleet root (a handle scoped to one home is refused there). */
  readonly fleet: RootHandle;
  readonly processes: Pick<ProcessesPort, 'runsFrom' | 'usersOf' | 'terminate'>;
}

export interface CodexAppServerSupervisorDeps {
  readonly inventory: CodexRuntimeInventory;
  readonly host: CodexAppServerHost;
  /** `<FY_HOME>/fleet/homes`: the only place a runtime's config directory may be. */
  readonly homesDirectory: string | (() => string);
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

/** The runtime id a home is: exactly ONE segment below the homes directory (`homes/<id>`), else `undefined`. */
export function runtimeHomeId(home: string, homesDirectory: string): string | undefined {
  const prefix = `${trimSlash(homesDirectory)}/`;
  if (!home.startsWith(prefix)) return undefined;
  const id = home.slice(prefix.length);
  return id === '' || id.includes('/') || id === '.' || id === '..' ? undefined : id;
}

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
    const homes = typeof this.deps.homesDirectory === 'string' ? this.deps.homesDirectory : this.deps.homesDirectory();
    const home = codexRuntimeHome(wrapper, await this.deps.inventory.accounts(), homes);
    const id = home === undefined ? undefined : runtimeHomeId(home, homes);
    if (home === undefined || id === undefined) return { kind: 'not-a-codex-runtime' };
    const root = this.deps.host.fleet;
    const homeFolder_ = `homes/${id}`;
    const at = (relative: string): FencedPath => {
      const resolved = root.resolve(relative === '.' ? homeFolder_ : `${homeFolder_}/${relative}`);
      if (!resolved.ok) throw new Error(`${relative} is not reachable in the runtime's home (${resolved.error})`);
      return resolved.value;
    };
    const daemon = await this.#daemonPids(root, at);
    if (daemon.pids.length === 0) return { kind: 'not-running', home };
    const attempts = this.deps.attempts ?? 10;
    const homeOwn: OwnFolder = { root, path: at('.') };
    for (let attempt = 1; ; attempt++) {
      const users = await this.deps.host.processes.usersOf('CODEX_HOME', homeOwn);
      if (users === undefined) return { kind: 'undecided', reason: `who is using ${home} could not be listed` };
      if (users.every(pid => daemon.pids.includes(pid))) break;
      if (attempt >= attempts) return { kind: 'in-use', home };
      await this.deps.sleep(this.deps.intervalMs ?? 200);
    }
    const signalled: number[] = [];
    for (const pid of daemon.pids) {
      const outcome = await this.deps.host.processes.terminate(pid, daemon.under);
      if (outcome === 'signalled') signalled.push(pid);
    }
    return signalled.length === 0
      ? { kind: 'undecided', reason: `the kernel signalled none of the recorded processes of ${home}` }
      : { kind: 'stopped', home, pids: signalled };
  }

  /** The recorded daemon pids whose process really runs from that home's app-server package right now. */
  async #daemonPids(
    root: RootHandle,
    at: (relative: string) => FencedPath,
  ): Promise<{ readonly pids: readonly number[]; readonly under: OwnFolder }> {
    const under: OwnFolder = { root, path: at(APP_SERVER_PACKAGES) };
    const pids: number[] = [];
    for (const file of CODEX_PID_FILES) {
      const text = await root.readText(at(file), PID_FILE_LIMIT).catch(() => undefined);
      const pid = text === undefined ? undefined : parseCodexPidFile(text);
      // No package folder (nothing was ever installed there) makes the kernel refuse: no daemon of this home runs from it.
      if (pid !== undefined && (await this.deps.host.processes.runsFrom(pid, under).catch(() => false))) pids.push(pid);
    }
    return { pids, under };
  }
}
