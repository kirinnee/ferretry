import { dirname, join } from 'node:path';
import type { LaunchResult, Probe } from '../../lib/world.ts';

/** The daemon's binary. It ships in the same archive as `fy`, so it is looked for beside `fy` first. */
export const DAEMON_BINARY = 'fyd';

const WAIT_MS = 30_000;
const LOOK_MS = 200;

export interface LaunchPorts {
  /** Where `fy` itself lives (`process.execPath` of the compiled binary). */
  readonly selfPath: string;
  readonly exists: (path: string) => boolean;
  readonly which: (name: string) => string | null;
  /** Starts a process detached from this one, its output discarded. */
  readonly spawnDetached: (
    command: readonly string[],
    environment: Readonly<Record<string, string | undefined>>,
  ) => void;
  readonly probe: () => Promise<Probe>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly nowMs: () => number;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export function findDaemonBinary(ports: Pick<LaunchPorts, 'selfPath' | 'exists' | 'which'>): string | undefined {
  const beside = join(dirname(ports.selfPath), DAEMON_BINARY);
  if (ports.exists(beside)) return beside;
  return ports.which(DAEMON_BINARY) ?? undefined;
}

/** Starts the daemon and waits for it to answer. The daemon's own lock refuses a second one, so a race is harmless. */
export async function launchDaemon(ports: LaunchPorts): Promise<LaunchResult> {
  const binary = findDaemonBinary(ports);
  if (binary === undefined)
    return {
      started: false,
      why: `cannot find ${DAEMON_BINARY} beside this program or on PATH; install it, or start it yourself`,
    };
  ports.spawnDetached([binary], ports.environment);
  const until = ports.nowMs() + WAIT_MS;
  let last: Probe = await ports.probe();
  while (last.state === 'down' && ports.nowMs() < until) {
    await ports.sleep(LOOK_MS);
    last = await ports.probe();
  }
  return last.state === 'up'
    ? { started: true, baseUrl: last.baseUrl }
    : {
        started: false,
        why: `started ${DAEMON_BINARY}, but it is not answering at ${last.baseUrl} (${last.why}); see its log under the home's logs/`,
      };
}
