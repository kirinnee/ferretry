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

/** `FY_DAEMON_BIN`, the daemon an operator pinned, as the environment gave it; `undefined` when unset or empty. */
const pinnedBinary = (environment: LaunchPorts['environment']): string | undefined =>
  environment.FY_DAEMON_BIN === undefined || environment.FY_DAEMON_BIN.trim() === ''
    ? undefined
    : environment.FY_DAEMON_BIN.trim();

export function findDaemonBinary(ports: Pick<LaunchPorts, 'selfPath' | 'exists' | 'which'>): string | undefined {
  const beside = join(dirname(ports.selfPath), DAEMON_BINARY);
  if (ports.exists(beside)) return beside;
  return ports.which(DAEMON_BINARY) ?? undefined;
}

/** Starts the daemon and waits for it to answer. The daemon's own lock refuses a second one, so a race is harmless. */
export async function launchDaemon(ports: LaunchPorts): Promise<LaunchResult> {
  // A pinned daemon is the daemon: one that is not there is refused, never replaced by whatever PATH finds (the same
  // rule `fy daemon restart` follows), so nobody believes they started the one they named.
  const pinned = pinnedBinary(ports.environment);
  if (pinned !== undefined && !ports.exists(pinned))
    return {
      started: false,
      why: `FY_DAEMON_BIN names ${pinned}, which is not there; install ${DAEMON_BINARY} there or unset it`,
    };
  const binary = pinned ?? findDaemonBinary(ports);
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
