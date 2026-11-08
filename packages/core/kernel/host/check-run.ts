import type { DaemonImplementation } from '../manifest/implement.ts';
import { systemClock } from './adapters/clock.ts';
import { nodeFs } from './adapters/node-fs.ts';
import { bunWorkers } from './adapters/process.ts';
import { nodeTempDirs } from './adapters/temp-dir.ts';
import { checkHost, processAlive, tcpProbe } from './check.ts';
import { runPluginChecks } from './check-plugins.ts';

export interface CheckRun {
  readonly home: string;
  readonly host: string;
  readonly port: number;
  readonly daemonName: string;
  readonly version: string;
  readonly implementations: readonly DaemonImplementation[];
}

/** `fyd --check` with the real adapters: prints to stdout and returns the exit code. */
export async function runCheck(run: CheckRun): Promise<number> {
  const { home, host, port } = run;
  const code = await checkHost({
    fs: nodeFs(() => crypto.randomUUID()),
    home,
    host,
    port,
    daemonName: run.daemonName,
    probe: tcpProbe,
    alive: processAlive,
    say: line => void process.stdout.write(`${line}\n`),
    plugins: async say =>
      await runPluginChecks(
        {
          implementations: run.implementations,
          facts: { home, host, port, version: run.version, platform: process.platform, arch: process.arch },
          workers: bunWorkers(),
          tempDirs: nodeTempDirs(),
          clock: systemClock(),
        },
        say,
      ),
  });
  // A selftest that timed out may still hold a native thread: this only matters when something else keeps the process alive.
  setTimeout(() => process.exit(code), 3000).unref();
  return code;
}
