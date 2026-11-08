/**
 * `kernel.hostFacts.launchGuard()` on the real machine (today's `testHarnessLaunchGuard`, copied): whether a daemon a
 * test booted must refuse to launch a real harness, and the PATH it searches. The kernel decides ONCE, at boot, from
 * the one variable and the one folder rule below; no plugin reads the environment.
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { HostLaunchGuard } from '../../contract/ports.ts';

/** The variable a test runner sets to say "everything this daemon launches must be a fake". */
const TEST_MODE_VARIABLE = 'FERRETRY_TEST';

/** What a launch guard is decided from: the variable, the home, and the machine's temporary folders. */
export interface LaunchGuardInput {
  /** The test-mode variable's value, if it is set. */
  readonly flag: string | undefined;
  /** The daemon's state home, as an absolute path (resolved through links by the caller). */
  readonly home: string;
  /** The machine's temporary roots, as absolute paths (resolved through links by the caller). */
  readonly temporaryRoots: readonly string[];
}

function within(root: string, path: string): boolean {
  const bare = root.replace(/\/+$/u, '');
  return path === bare || path.startsWith(`${bare}/`);
}

/**
 * Whether the guard is on: the runner said so (`FERRETRY_TEST=1`), or the state home sits under a temporary folder.
 * The second leg catches a test nobody remembered to mark: every suite builds its `FY_HOME` under the temporary
 * directory, and no person keeps the home that holds their sessions and tokens somewhere the system empties.
 */
export function launchGuardActive(input: LaunchGuardInput): boolean {
  if (input.flag === '1') return true;
  return input.temporaryRoots.some(root => root !== '' && within(root, input.home));
}

export interface LaunchGuardOptions {
  readonly home: string;
  /** The process environment; a suite passes its own. Default: the process's. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Resolves a path through links, or answers the path itself when it cannot. Default: `realpath`. */
  readonly canonical?: (path: string) => string;
  /** The machine's temporary folders. Default: `os.tmpdir()`, `/tmp` and `/var/folders`. */
  readonly temporaryRoots?: readonly string[];
}

function realCanonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Decides `active` once, now; `searchPath` is the daemon's `PATH` as it stands each time it is asked. */
export function launchGuardFor(options: LaunchGuardOptions): () => HostLaunchGuard {
  const environment = options.environment ?? process.env;
  const canonical = options.canonical ?? realCanonical;
  const active = launchGuardActive({
    flag: environment[TEST_MODE_VARIABLE],
    home: canonical(options.home),
    temporaryRoots: (options.temporaryRoots ?? [tmpdir(), '/tmp', '/var/folders']).map(canonical),
  });
  return () => {
    const searchPath = environment['PATH'];
    return Object.freeze(searchPath === undefined ? { active } : { active, searchPath });
  };
}

/**
 * What a host that was never told how the kernel decided holds: the guard is ON, with no search path. A wiring that
 * forgets to hand the kernel's decision therefore refuses to launch a real harness instead of silently running one.
 * Production hands the real decision ({@link launchGuardFor}); only a fixture that never asks runs on this.
 */
export const UNDECIDED_LAUNCH_GUARD = (): HostLaunchGuard => Object.freeze({ active: true });
