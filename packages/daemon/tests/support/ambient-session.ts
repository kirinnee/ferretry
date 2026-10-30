/**
 * NO TEST RUNS INSIDE THE SESSION THAT STARTED IT.
 *
 * An agent's pane inherits the live daemon's environment: `FY_HOME` names the owner's REAL state home
 * and `TMUX` names the live tmux server every agent on the machine runs under. A suite an agent starts
 * from its pane inherits both. Every fixture overrides `FY_HOME` for the daemon it boots, but a fixture
 * that "restores the previous value" hands the real home back to whatever is still running — and with
 * Bun's per-test timeout a timed-out test IS still running — while any `tmux` run without `-S`
 * addresses the server `TMUX` names, where one `kill-server` ends every agent at once. On 2026-10-29
 * every live agent on the dev box lost its pane within the same two seconds while agents were running
 * the integration tier from inside their panes.
 *
 * So the first module of a run to load — the preload every `bunfig.*.toml` names, or any integration
 * support module when a suite is started without one — sheds that session before a single test file
 * runs: it removes the variables a pane carries and records, in {@link PROTECTED_PATHS_VARIABLE}, the
 * homes and sockets they named, so every child the run spawns refuses them too. A run whose temporary
 * directory lies inside one of them refuses to start, and {@link assertDisposable} is what a teardown
 * asks before it kills or removes anything.
 */
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, resolve, sep } from 'node:path';
import { resolveStateHome } from '../../src/lib/state-home.ts';

/** What a pane's environment carries about the session and the daemon it belongs to. */
export const AMBIENT_SESSION_VARIABLES = [
  'FY_HOME',
  'TMUX',
  'TMUX_PANE',
  'FY_SESSION_ID',
  'FY_SESSION_MODE',
  'FY_SESSION_BOARD_CAPABILITY',
  'FY_MEDIA_DIR',
  'FY_CREDENTIAL',
  'FY_RUNTIME',
  'FY_PACK',
  'FY_PACK_ROUTING',
  'FY_HYPERMEDIA',
  'FY_LEARNING_PASSIVE',
] as const;

/**
 * The homes and sockets no test may touch, `PATH`-delimited. Its presence is also the mark that this
 * process tree has already been shed: `scripts/test/swept.sh` sets it before Bun starts, and a later
 * module load must never mistake a test's own temporary `FY_HOME` for an inherited one.
 */
export const PROTECTED_PATHS_VARIABLE = 'FY_TEST_PROTECTED_PATHS';

/** The system temporary roots a disposable path must lie strictly inside. */
const TEMPORARY_BASES = ['/tmp', '/private/tmp', '/var/tmp', '/var/folders'] as const;

type Environment = Record<string, string | undefined>;

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function within(base: string, path: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

function strictlyWithin(base: string, path: string): boolean {
  return path !== base && within(base, path);
}

/** The socket a `TMUX` value names — `<socket>,<server pid>,<session index>` — when it names one. */
export function tmuxSocketOf(value: string | undefined): string | undefined {
  const socket = value?.split(',', 1)[0]?.trim();
  return socket !== undefined && isAbsolute(socket) ? socket : undefined;
}

/** The state home a daemon on this account serves when nothing names another: `~/.<product>`. */
function defaultStateHome(userHome: string): string | undefined {
  try {
    return resolveStateHome({ fyHome: undefined, homeDirectory: userHome });
  } catch {
    return undefined;
  }
}

/** Every protected path this process knows of: what it inherited, and the account's default home. */
export function protectedPaths(
  environment: Environment = process.env,
  userHome: string = process.env.FY_TEST_REAL_HOME ?? homedir(),
): readonly string[] {
  const recorded = (environment[PROTECTED_PATHS_VARIABLE] ?? '').split(delimiter).filter(isAbsolute);
  const home = defaultStateHome(userHome);
  return [...new Set([...recorded, ...(home === undefined ? [] : [home])])];
}

/**
 * Removes the ambient session from `environment` once per process tree, and refuses a run whose
 * temporary directory lies inside a protected path. Idempotent: only the first call in a tree sheds.
 */
export function shedAmbientSession(
  environment: Environment = process.env,
  userHome: string = process.env.FY_TEST_REAL_HOME ?? homedir(),
  temporary: string = tmpdir(),
): readonly string[] {
  if (environment[PROTECTED_PATHS_VARIABLE] === undefined) {
    const inherited = [environment.FY_HOME, tmuxSocketOf(environment.TMUX)].filter(
      (path): path is string => path !== undefined && isAbsolute(path),
    );
    for (const name of AMBIENT_SESSION_VARIABLES) delete environment[name];
    environment[PROTECTED_PATHS_VARIABLE] = inherited.join(delimiter);
  }
  const guarded = protectedPaths(environment, userHome);
  const scratch = canonical(temporary);
  for (const path of guarded) {
    if (within(canonical(path), scratch))
      throw new Error(
        `refusing to run tests: the temporary directory ${scratch} lies inside ${path}, a real state home ` +
          'or tmux socket — point TMPDIR somewhere disposable',
      );
  }
  return guarded;
}

/**
 * Whether a teardown may kill what runs under `path`, or remove it: only a path strictly inside a
 * system temporary root (or this run's own temporary directory), and never one that is, holds, or lies
 * inside a protected home or socket. Throws, naming the path, rather than letting a fixture guess.
 */
export function assertDisposable(
  path: string,
  what: string,
  environment: Environment = process.env,
  userHome: string = process.env.FY_TEST_REAL_HOME ?? homedir(),
): void {
  if (!isAbsolute(path)) throw new Error(`refusing to touch ${what} ${JSON.stringify(path)}: it is not absolute`);
  const target = canonical(path);
  const scratch = canonical(tmpdir());
  const bases = [...TEMPORARY_BASES.map(canonical), ...(scratch === sep ? [] : [scratch])];
  if (!bases.some(base => strictlyWithin(base, target)))
    throw new Error(`refusing to touch ${what} ${target}: it is not inside a temporary directory`);
  for (const guarded of protectedPaths(environment, userHome).map(canonical)) {
    if (within(guarded, target) || within(target, guarded))
      throw new Error(`refusing to touch ${what} ${target}: it is, holds or lies inside ${guarded}`);
  }
}
