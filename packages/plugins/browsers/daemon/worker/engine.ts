import type { SpawnPort } from '@ferretry/kernel/contract';
import { type BrowserEngine as BrowserEngineId, DEFAULT_BROWSER_ENGINE } from '../../contract/index.ts';
import type { BrowserHost } from '../adapters/host.ts';
import { agentBrowserArguments, BrowserControlError, selectChromeExecutable } from './control/index.ts';

/**
 * THE ENGINE SEAM: what the launcher needs from a browser engine, and nothing else of it.
 *
 * Which binary to run, how to ask it for its version, and the argv that starts it for one identity. The launcher owns
 * everything around a browser (the lease, the port, the display, the proxy relay, the worker, the teardown) and reaches
 * the engine only through this, so a second engine is a new implementation of it and not a change to the launcher.
 * `chromium` is the only one, and CloakBrowser is deliberately not written.
 */
export interface BrowserEngine {
  readonly id: BrowserEngineId;
  /** The executable this host will run, or the refusal sentence that names what to install. */
  executable(
    host: Pick<BrowserHost, 'platform' | 'exists' | 'which'>,
    environment: Readonly<Record<string, string | undefined>>,
  ): string;
  /** The engine's own version line, used for the honest user agent and recorded on the lease. */
  version(spawn: Pick<SpawnPort, 'run'>, executable: string): Promise<string>;
  /** The argv that starts it for one identity's profile (headless unless the owner chose a real window). */
  command: typeof agentBrowserArguments;
}

/** Google Chrome before Chromium, or `FY_CHROME_BIN`: the one engine the machine has always run. */
export const chromiumEngine: BrowserEngine = {
  id: 'chromium',
  executable: (host, environment) =>
    selectChromeExecutable(host.platform, environment.FY_CHROME_BIN, host.exists, {
      home: environment.HOME,
      path: environment.PATH,
      available: command => host.which(command, environment.PATH) !== undefined,
    }),
  version: async (spawn, executable) => {
    const ran = await spawn.run(executable, ['--version']);
    const version = ran.stdout.trim();
    if (ran.exitCode !== 0 || version === '')
      throw new BrowserControlError('launch_failed', 'Chrome did not report a version');
    return version;
  },
  command: agentBrowserArguments,
};

const ENGINES: Readonly<Record<BrowserEngineId, BrowserEngine>> = { chromium: chromiumEngine };

/** The implementation of a configured engine. Total: the schema admits no engine this does not know. */
export function engineFor(id: BrowserEngineId = DEFAULT_BROWSER_ENGINE): BrowserEngine {
  return ENGINES[id];
}
