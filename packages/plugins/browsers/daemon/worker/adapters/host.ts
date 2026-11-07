import { join } from 'node:path';

/**
 * GAP (kernel ports): the host facts the agent browser needs and no kernel port gives a half yet — the state
 * folder Chrome's profile lives in (Chrome takes a real `--user-data-dir`), a private temporary folder for staged
 * downloads, the program search path and the operator's `FY_CHROME_BIN`, and the platform. Read in this ONE file so
 * the `banned-globals` findings are here and nowhere else; a kernel `host` port replaces it.
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
  /** A program on this host's PATH at the moment of use, or `undefined`. */
  which(name: string): string | undefined;
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
    which: name => Bun.which(name, { PATH: process.env.PATH ?? '' }) ?? undefined,
  };
}
