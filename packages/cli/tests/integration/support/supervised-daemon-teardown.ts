import { rm } from 'node:fs/promises';
import { sweepTmuxServers, tmuxServersUnder } from '../../../../../scripts/test/tmux-sweep.ts';

/**
 * What a fixture that boots a real `fyd` through the CLI's supervisor started, and must end.
 *
 * Sets rather than arrays because every fixture already kept them that way; the teardown empties
 * them, so the next test starts from nothing whether or not this one passed.
 */
export interface SupervisedDaemonFixture {
  /** The pid each `supervisor.start` handed back. */
  readonly daemons: Set<number>;
  /** Each daemon's private tmux socket. */
  readonly sockets: Set<string>;
  /** Each temporary root, removed last; every socket lies under one. */
  readonly roots: Set<string>;
}

export interface TeardownOptions {
  /** The tmux the fixture booted its daemons with, or `null` when the host has none. */
  readonly tmux: string | null;
  /** How long a daemon may take to exit on SIGTERM before it is killed. */
  readonly exitWithinMs?: number;
  /** How long the servers' processes may take to leave once `kill-server` has answered. */
  readonly settleWithinMs?: number;
}

/** What a fixture passes as the hook's own timeout, so the bounded waits below can run out first. */
export const TEARDOWN_TIMEOUT_MS = 20_000;

const POLL_MS = 20;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

/** Whether `done` held within `withinMs`, read every {@link POLL_MS}. */
async function within(withinMs: number, done: () => boolean): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(POLL_MS);
  }
  return true;
}

/**
 * Ends every daemon, then every tmux server, then proves nothing tmux is left under the roots, and
 * only then removes them.
 *
 * THE ORDER IS THE FIX. These fixtures used to send SIGTERM and run `kill-server` at once, without
 * waiting for the daemon to go. A daemon holds a live control-mode client on its server, and tmux
 * 3.6a, asked to exit in the same instant that client's daemon end closes, keeps the server AND the
 * client running for good: the server waits for a client that is waiting for the server. Measured
 * on a bare server and a Bun parent: SIGTERM then an immediate `kill-server` left both behind 9 runs
 * in 20; letting the parent exit first, or letting `kill-server` finish first, left nothing in 20
 * each. CI run 40615810178 hit it as two "leaked servers" six pids apart on one socket. Waiting for
 * the exit first means no client of a dying daemon is ever on the server `kill-server` ends.
 *
 * BY PROCESS AFTERWARDS. A server still under a root once `kill-server` has run is found by its argv,
 * as the run's own sweep finds it (`scripts/test/tmux-sweep.ts`), killed with everything in its
 * panes, and reported — so the test that left it fails by name instead of the whole run failing on a
 * socket nobody can trace back. The same goes for a daemon that would not stop on SIGTERM.
 */
export async function tearDownSupervisedDaemons(
  fixture: SupervisedDaemonFixture,
  { tmux, exitWithinMs = 10_000, settleWithinMs = 5_000 }: TeardownOptions,
): Promise<void> {
  const failures: string[] = [];
  const daemons = [...fixture.daemons];
  fixture.daemons.clear();
  for (const pid of daemons) signal(pid, 'SIGTERM');
  for (const pid of daemons) {
    if (await within(exitWithinMs, () => !alive(pid))) continue;
    signal(pid, 'SIGKILL');
    await within(exitWithinMs, () => !alive(pid));
    failures.push(`fyd ${String(pid)} was still running ${String(exitWithinMs)} ms after SIGTERM and was killed`);
  }

  const sockets = [...fixture.sockets];
  fixture.sockets.clear();
  if (tmux !== null)
    for (const socket of sockets)
      await Bun.spawn([tmux, '-S', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' }).exited;

  const roots = [...fixture.roots];
  fixture.roots.clear();
  if (!(await within(settleWithinMs, () => tmuxServersUnder(roots).length === 0)))
    for (const server of sweepTmuxServers(roots))
      failures.push(`tmux ${String(server.pid)} outlived kill-server on ${server.socket} and was killed`);
  for (const root of roots) await rm(root, { recursive: true, force: true });

  if (failures.length > 0)
    throw new Error(`the fixture's teardown found what it should not have:\n${failures.join('\n')}`);
}
