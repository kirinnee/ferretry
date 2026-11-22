import {
  hostProcessReader,
  identify,
  signalVerified,
  stillRunning,
  type ProcessIdentity,
} from '../../../support/daemon/process-identity.ts';
import { waitFor } from './wait-for.ts';

/** The whole teardown of one tmux server: well under the 120 s a file gets, so a stuck one fails by name, not by timeout. */
export const TEARDOWN_BUDGET_MS = 30_000;

/** What one bounded tmux command (its own child, held here) answered. */
interface Asked {
  readonly code: number | null;
  readonly stdout: string;
}

/**
 * One tmux command on the private `socket`, killed at `limitMs` if it has not finished. The child is this function's
 * own: it holds the handle, so killing it can reach nothing else.
 */
async function ask(executable: string, socket: string, command: readonly string[], limitMs: number): Promise<Asked> {
  const child = Bun.spawn([executable, '-S', socket, ...command], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(limitMs, 1));
  try {
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, stdout };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every tmux process whose argv names `socket` as its `-S` (a tmux server keeps the argv of the client that started
 * it, which is how `scripts/test/tmux-sweep.ts` finds one), as an identity taken now. The socket is this test's own
 * private one. Only reads: nothing here signals.
 */
function onSocket(socket: string): readonly ProcessIdentity[] {
  const listed = Bun.spawnSync(['ps', '-A', '-ww', '-o', 'pid=', '-o', 'args='], { stdout: 'pipe', stderr: 'ignore' });
  return listed.stdout
    .toString()
    .split('\n')
    .flatMap(line => {
      const match = /^\s*(\d+)\s+(\S*\/)?tmux\s/u.exec(line);
      const found = match === null ? undefined : identify(Number(match[1]), socket, hostProcessReader);
      return found === undefined ? [] : [found];
    });
}

/**
 * End the tmux server on a test's private `socket` and WAIT until nothing is left of it.
 *
 * `kill-server` answers as soon as the server has been told to exit; the server process lingers for a moment after
 * (hanging up its panes), and `scripts/test/swept.sh` fails any run in which a tmux process on a test's socket is
 * still alive when the test process ends. So, inside ONE budget (`budgetMs`, from entry to return):
 *
 * 1. the processes on the socket are recorded as identities (pid + start time, argv naming the private socket), the
 *    server's own among them (the pid it answers `#{pid}` with);
 * 2. the server is told `tmux -S <socket> kill-server`, each command bounded, its child killed at the bound;
 * 3. the fixture waits until every recorded process is gone (a process that exited, or whose pid was reused, is gone);
 * 4. only a process still running after that is SIGKILLed, and only after {@link signalVerified} re-checks that the
 *    pid still carries the recorded start time and still names the socket. A pid that was reused is never signalled.
 *
 * It fails, naming what is left, rather than outlive the budget. A control client the caller started must be
 * stopped first (`ControlModeTmuxProcess.stop()`): tmux 3.6a keeps a server and a client that is still detaching
 * waiting on each other once `kill-server` arrives in between.
 */
export async function stopTmuxServer(
  executable: string,
  socket: string,
  budgetMs: number = TEARDOWN_BUDGET_MS,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  const left = (): number => Math.max(deadline - Date.now(), 0);
  const recorded = new Map<number, ProcessIdentity>();
  const record = (found: ProcessIdentity | undefined): void => {
    if (found !== undefined) recorded.set(found.pid, found);
  };

  const asked = await ask(executable, socket, ['display-message', '-p', '#{pid}'], Math.min(5000, left()));
  if (asked.code === 0) record(identify(Number.parseInt(asked.stdout.trim(), 10), socket, hostProcessReader));
  for (const found of onSocket(socket)) record(found);

  await ask(executable, socket, ['kill-server'], Math.min(5000, left()));

  const remaining = (): readonly ProcessIdentity[] => [
    ...[...recorded.values()].filter(each => stillRunning(each, hostProcessReader)),
    ...onSocket(socket).filter(each => !recorded.has(each.pid)),
  ];
  // The last 3 s of the budget are kept for the fallback below.
  const exited = await waitFor(() => remaining().length === 0, 'every tmux process on the socket to exit', {
    within: Math.max(left() - 3000, 0),
  }).then(
    () => true,
    () => false,
  );
  if (exited) return;

  for (const each of remaining()) signalVerified(each, socket, 'SIGKILL');
  await waitFor(
    () => remaining().length === 0,
    `tmux ${remaining()
      .map(each => each.pid)
      .join(', ')} on ${socket} to exit`,
    {
      within: left(),
    },
  );
}
