import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserWorkerProgram, selectBrowserWorker } from '../worker/program.ts';

/**
 * The host facts the agent browser needs from the operating system itself, which no kernel port can give — the state
 * folder Chrome's profile lives in (Chrome takes a real `--user-data-dir`), a private temporary folder for staged
 * downloads, the program search path and the operator's `FY_CHROME_BIN`, whether a path exists, the platform and
 * architecture, and where this daemon's own executable (and so the compiled browser worker beside it) is. Read in
 * this ONE daemon-side file, a permanent per-file exemption in `banned-globals` (DECISIONS-2 #20), so the reach is
 * here and visible.
 */
export interface BrowserHost {
  /** `state/browsers/` in the home: Chrome's profile (`data/agent`), the display cookies (`x11/`), the lease. */
  readonly stateDirectory: string;
  /** Where the worker stages a page's downloads until the agent saves them (or fifteen minutes pass). */
  readonly stageDirectory: string;
  /** Where the daemon keeps its own copies of the files a page was handed, for the staging time. */
  readonly uploadDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** A program on this host's PATH (or on `path`) at the moment of use, or `undefined`. */
  which(name: string, path?: string): string | undefined;
  exists(path: string): boolean;
  /** The browser worker program: the compiled worker beside the daemon, or the source entry run under Node. */
  workerProgram(): BrowserWorkerProgram;
}

/**
 * The ONLY variables of the daemon's environment this half reads, by name (none are enumerated or spread): the home
 * and the overrides this half owns, plus exactly the names the launchers downstream forward to Chrome, the worker and
 * the opener (`browserEnvironment`, `FORWARDED_ENVIRONMENT`, `OPENER_ENVIRONMENT_NAMES`). A secret-shaped variable
 * (`GITHUB_TOKEN`) is therefore never read and cannot be passed on. The locale is the thirteen standard POSIX `LC_*` names,
 * each by name and never by prefix: a non-standard `LC_*` (macOS `LC_TERMINAL`) is deliberately not read.
 */
export const READ_ENVIRONMENT_NAMES = [
  'FY_HOME',
  'FY_CHROME_BIN',
  'FY_BROWSER_WORKER_SOURCE',
  'FY_BROWSER_WORKER_BIN',
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_COLLATE',
  'LC_NUMERIC',
  'LC_TIME',
  'LC_MONETARY',
  'LC_ADDRESS',
  'LC_IDENTIFICATION',
  'LC_MEASUREMENT',
  'LC_NAME',
  'LC_PAPER',
  'LC_TELEPHONE',
  'TMPDIR',
  'FONTCONFIG_FILE',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_TYPE',
  'DBUS_SESSION_BUS_ADDRESS',
  'BROWSER',
] as const;

/** The allow-listed, defined entries of `source`, taken by name. */
export function allowedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = {};
  for (const name of READ_ENVIRONMENT_NAMES) if (source[name] !== undefined) result[name] = source[name];
  return result;
}

export function processHost(source: Readonly<Record<string, string | undefined>> = process.env): BrowserHost {
  const environment = allowedEnvironment(source);
  const home = environment.FY_HOME ?? join(environment.HOME ?? '.', '.ferretry');
  return {
    stateDirectory: join(home, 'state', 'browsers'),
    stageDirectory: join(home, 'tmp', 'browser-stage'),
    uploadDirectory: join(home, 'tmp', 'browser-upload'),
    environment,
    platform: process.platform,
    arch: process.arch,
    which: (name, path) => Bun.which(name, { PATH: path ?? environment.PATH ?? '' }) ?? undefined,
    exists: path => existsSync(path),
    // Beside the daemon both as invoked and as resolved: a Homebrew or Nix install reaches it through a symlink whose
    // directory holds no worker (today's `browserWorkerProgram`).
    workerProgram: () => {
      const invoked = dirname(process.execPath);
      let resolved = invoked;
      try {
        resolved = dirname(realpathSync(process.execPath));
      } catch {
        // An executable that cannot be resolved is still searched where it was invoked.
      }
      return selectBrowserWorker({
        sourceOverride: environment.FY_BROWSER_WORKER_SOURCE,
        binaryOverride: environment.FY_BROWSER_WORKER_BIN,
        executableDirectories: [invoked, resolved],
        platform: process.platform,
        arch: process.arch,
        sourceEntry: fileURLToPath(new URL('../worker/adapters/main.ts', import.meta.url)),
        exists: existsSync,
      });
    },
  };
}
