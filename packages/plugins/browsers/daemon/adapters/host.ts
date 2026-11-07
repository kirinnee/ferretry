import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserWorkerProgram, selectBrowserWorker } from '../worker/program.ts';

/**
 * GAP (kernel ports): the host facts the agent browser needs and no kernel port gives a half yet — the state
 * folder Chrome's profile lives in (Chrome takes a real `--user-data-dir`), a private temporary folder for staged
 * downloads, the program search path and the operator's `FY_CHROME_BIN`, whether a path exists, the platform and
 * architecture, and where this daemon's own executable (and so the compiled browser worker beside it) is. Read in
 * this ONE daemon-side file so the `banned-globals` findings are here and visible; a kernel `host` port replaces it.
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

export function processHost(): BrowserHost {
  const environment = process.env;
  const home = environment.FY_HOME ?? join(environment.HOME ?? '.', '.ferretry');
  return {
    stateDirectory: join(home, 'state', 'browsers'),
    stageDirectory: join(home, 'tmp', 'browser-stage'),
    uploadDirectory: join(home, 'tmp', 'browser-upload'),
    environment,
    platform: process.platform,
    arch: process.arch,
    which: (name, path) => Bun.which(name, { PATH: path ?? process.env.PATH ?? '' }) ?? undefined,
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
