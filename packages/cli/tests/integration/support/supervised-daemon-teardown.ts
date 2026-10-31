import { rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { assertDisposable, shedAmbientSession } from '../../../../daemon/tests/support/ambient-session.ts';

// A CLI suite started without its tier's preload still never sees the agent session it was started from.
shedAmbientSession();

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
  /** How long a daemon's control client may take to leave once the daemon has exited, before it is killed. */
  readonly clientsWithinMs?: number;
  /** How long the servers' processes may take to leave once `kill-server` has answered. */
  readonly settleWithinMs?: number;
}

/** What a fixture passes as the hook's own timeout, so the bounded waits below can run out first. */
export const TEARDOWN_TIMEOUT_MS = 150_000;

const POLL_MS = 20;

/**
 * The run's own sweep, run as a process rather than imported: an import would put a `scripts/` file
 * in the integration coverage ledger, which counts adapters only.
 */
const SWEEP = resolve(import.meta.dir, '../../../../../scripts/test/tmux-sweep.ts');

/** A tmux process attached to a server as a client (a daemon's control-mode client is one), not the server itself. */
const CLIENT = /\sattach(?:-session)?\s/u;

/** Every tmux process — server or client — whose argv names one of `sockets`, as `ps` lists it. */
function tmuxOn(sockets: readonly string[]): readonly string[] {
  const listed = Bun.spawnSync(['ps', '-A', '-ww', '-o', 'pid=', '-o', 'args='], { stdout: 'pipe', stderr: 'ignore' });
  return listed.stdout
    .toString()
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      const [, program = ''] = line.split(/\s+/u, 2);
      return basename(program) === 'tmux' && sockets.some(socket => ` ${line} `.includes(` -S ${socket} `));
    });
}

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

/** The paths a teardown may act on; each refused one is left alone and named in `failures`. */
function disposable(paths: readonly string[], what: string, failures: string[]): readonly string[] {
  return paths.filter(path => {
    try {
      assertDisposable(path, what);
      return true;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      return false;
    }
  });
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
 * THE CLIENTS LEAVE FIRST, BY CONDITION. A daemon that has exited has not yet taken its control client with
 * it: the client sees its stdin close and detaches a moment later, and on a loaded runner that moment is
 * long enough for `kill-server` to arrive in the middle of it, which is the same deadlock. CI runs
 * 41170241232 and 41220302930 (`restart-in-flight.test.ts`, two processes sharing four cores) each left one
 * server and one `-C attach-session` client for the whole 30 s settle wait. So `kill-server` waits until
 * no client of these sockets is left; a client that is still there after `clientsWithinMs` is stuck, is
 * killed so the server can answer, and is reported by pid.
 *
 * BY PROCESS AFTERWARDS. A tmux process still naming a socket once `kill-server` has run is found by
 * its argv, as the run's own sweep finds it, killed with everything in its panes by that sweep
 * (`scripts/test/tmux-sweep.ts`), and reported — so the test that left it fails by name instead of
 * the whole run failing on a socket nobody can trace back. The same goes for a daemon that would not
 * stop on SIGTERM.
 *
 * NOTHING OUTSIDE A TEMPORARY DIRECTORY IS EVER KILLED OR REMOVED. Every socket and root is checked by
 * `assertDisposable` before tmux is asked anything: a fixture that resolved its socket from an inherited
 * `FY_HOME` would otherwise run `kill-server` on the live server every agent on the machine runs
 * under. A refused path is left alone and the teardown fails naming it; the daemons the fixture itself
 * started, by pid, are still ended.
 */
export async function tearDownSupervisedDaemons(
  fixture: SupervisedDaemonFixture,
  { tmux, exitWithinMs = 30_000, clientsWithinMs = 10_000, settleWithinMs = 10_000 }: TeardownOptions,
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

  const sockets = disposable([...fixture.sockets], 'the fixture tmux socket', failures);
  fixture.sockets.clear();
  const clientsOn = (): readonly string[] => tmuxOn(sockets).filter(line => CLIENT.test(line));
  if (!(await within(clientsWithinMs, () => clientsOn().length === 0))) {
    const stuck = clientsOn();
    for (const line of stuck) signal(Number.parseInt(line, 10), 'SIGKILL');
    failures.push(
      `a tmux client was still attached ${String(clientsWithinMs)} ms after its daemon exited and was killed:\n${stuck.join('\n')}`,
    );
  }
  if (tmux !== null)
    for (const socket of sockets)
      await Bun.spawn([tmux, '-S', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' }).exited;

  const roots = disposable([...fixture.roots], 'the fixture root', failures);
  fixture.roots.clear();
  if (!(await within(settleWithinMs, () => tmuxOn(sockets).length === 0))) {
    const left = tmuxOn(sockets);
    // Killed with everything in their panes by the one module that knows how; its lines name each pid.
    const swept = Bun.spawnSync([process.execPath, SWEEP, ...roots], { stdout: 'ignore', stderr: 'pipe' });
    failures.push(`tmux outlived kill-server and was killed:\n${left.join('\n')}\n${swept.stderr.toString().trim()}`);
  }
  for (const root of roots) await rm(root, { recursive: true, force: true });

  if (failures.length > 0)
    throw new Error(`the fixture's teardown found what it should not have:\n${failures.join('\n')}`);
}
