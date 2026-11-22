import type { TmuxCommandPort } from '../../../../daemon/lib/tmux/contracts.ts';
import { waitFor } from './wait-for.ts';

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The pids of every tmux process still naming `socket` as its `-S` (a tmux server keeps the argv of the client that
 * started it, which is how `scripts/test/tmux-sweep.ts` finds one). The socket is this test's own private one, so
 * this reads nobody else's process.
 */
function tmuxOnSocket(socket: string): readonly number[] {
  const listed = Bun.spawnSync(['ps', '-A', '-ww', '-o', 'pid=', '-o', 'args='], { stdout: 'pipe', stderr: 'ignore' });
  return listed.stdout
    .toString()
    .split('\n')
    .flatMap(line => {
      const match = /^\s*(\d+)\s+(\S*\/)?tmux\s(.*)$/u.exec(line);
      const flagged = match?.[3]?.split(/\s+/u) ?? [];
      return match !== null && flagged[flagged.indexOf('-S') + 1] === socket ? [Number(match[1])] : [];
    });
}

/**
 * End the tmux server behind `tmux` (its private `socket`) and WAIT until nothing is left of it.
 *
 * `kill-server` answers as soon as the server has been told to exit; the server process lingers for a moment after
 * (hanging up its panes), and `scripts/test/swept.sh` fails any run in which a tmux process on a test's socket is
 * still alive when the test process ends. So the fixture records the server's own pid (the one `#{pid}` names),
 * tells it to exit, waits for exactly that pid, then waits for every process still naming its own socket, and
 * SIGKILLs those by pid only if they outlast the safety net. Nothing is matched outside this test's socket.
 */
export async function stopTmuxServer(tmux: TmuxCommandPort, socket: string): Promise<void> {
  const asked = await tmux.execute(['display-message', '-p', '#{pid}']);
  const pid = Number.parseInt(asked.stdout.trim(), 10);
  await tmux.execute(['kill-server']);
  const kill = (pids: readonly number[]): void => {
    for (const each of pids) {
      try {
        process.kill(each, 'SIGKILL');
      } catch {
        // Gone between the check and the signal.
      }
    }
  };
  if (asked.code === 0 && Number.isInteger(pid) && pid > 1) {
    await waitFor(() => !running(pid), `tmux server ${pid} to exit after kill-server`).catch(() => kill([pid]));
  }
  await waitFor(() => tmuxOnSocket(socket).length === 0, `every tmux process on ${socket} to exit`).catch(() =>
    kill(tmuxOnSocket(socket)),
  );
}
