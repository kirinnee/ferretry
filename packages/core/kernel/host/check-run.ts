import type { DaemonImplementation } from '../manifest/implement.ts';
import { copiedClock } from './adapters/clock.ts';
import { nodeFs } from './adapters/node-fs.ts';
import { bunWorkers } from './adapters/process.ts';
import { nodeTempDirs } from './adapters/temp-dir.ts';
import { checkHost, processAlive, tcpProbe } from './check.ts';
import { checkDeadlineMs, loadRegistry, runPluginChecks } from './check-plugins.ts';

export interface CheckRun {
  readonly home: string;
  readonly host: string;
  readonly port: number;
  readonly daemonName: string;
  readonly version: string;
  /** Reads the plugin registry. Called only AFTER the home and address lines are out, so a registry that fails to load costs a line, not the verdict. */
  readonly loadImplementations: () => Promise<readonly DaemonImplementation[]>;
}

/** How long the registry may take to load before the host stops the check (the per-plugin deadline comes after). */
const REGISTRY_LOAD_DEADLINE_MS = 30_000;
/** How long the process may linger once the check has answered. */
const LINGER_MS = 3000;
/** How long the removal of leftover temp directories may take once the exit has started. */
const REMOVAL_BACKSTOP_MS = 1000;

/** `fyd --check` with the real adapters: prints to stdout and returns the exit code. */
export async function runCheck(run: CheckRun): Promise<number> {
  const { home, host, port } = run;
  // The kernel's own timer and exit, taken before any plugin code is imported or run: a plugin that patches the
  // globals afterwards (or at import) cannot reach what these hold.
  const arm = globalThis.setTimeout;
  const disarm = globalThis.clearTimeout;
  const exit = process.exit.bind(process);
  const nowMs = Date.now.bind(Date);
  const tempDirs = nodeTempDirs(home);
  const stopAt = (ms: number, code: number, message?: string, say?: (line: string) => void): (() => void) => {
    const timer = arm(() => {
      if (message !== undefined) say?.(message);
      // Remove what a late selftest recreated, but never let the removal itself keep the process: a backstop exits.
      arm(() => exit(code), REMOVAL_BACKSTOP_MS).unref();
      void tempDirs.removeAll().finally(() => exit(code));
    }, ms);
    timer.unref();
    return () => disarm(timer);
  };
  const code = await checkHost({
    fs: nodeFs(() => crypto.randomUUID()),
    home,
    host,
    port,
    daemonName: run.daemonName,
    probe: tcpProbe,
    alive: processAlive,
    say: line => void process.stdout.write(`${line}\n`),
    plugins: async (say, verdict) => {
      // Armed BEFORE the plugins are imported or asked anything, so `--check` can never hang on one of them.
      const stopLoading = stopAt(
        REGISTRY_LOAD_DEADLINE_MS,
        verdict,
        'plugins      ! the plugin registry did not load in time — the home and address verdict above stands',
        say,
      );
      const implementations = await loadRegistry(run.loadImplementations, say);
      stopLoading();
      if (implementations === undefined) return;
      stopAt(
        checkDeadlineMs(implementations),
        verdict,
        'plugins      ! the plugin checks did not finish in time — the home and address verdict above stands',
        say,
      );
      await runPluginChecks(
        {
          implementations,
          facts: { home, host, port, version: run.version, platform: process.platform, arch: process.arch },
          workers: bunWorkers(),
          tempDirs,
          clock: copiedClock(arm, disarm, nowMs),
        },
        say,
      );
    },
  });
  // A selftest that timed out may recreate its directory after the kernel removed it: remove what is left on the normal
  // exit path too, where no timer would run.
  await tempDirs.removeAll().catch(() => {});
  // A selftest that timed out may still hold a native thread or recreate its directory: stop it shortly after the verdict.
  stopAt(LINGER_MS, code);
  return code;
}
