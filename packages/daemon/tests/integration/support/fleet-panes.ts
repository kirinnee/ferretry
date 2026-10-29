/**
 * REAL tmux panes for a scaled fleet's running sessions, on the daemon's own private socket — and a
 * teardown that leaves no server behind.
 *
 * Both idle-cost tests need the panes a live fleet has: without them every tmux question fails at once
 * and the cost the owner's machine pays never shows. They used to start the panes with one `tmux
 * new-session` per session, back to back. Under CI load a second command can find the first server not
 * yet listening and start a server of its own on the same path, which leaves a server no `kill-server`
 * on that socket can reach — and the run's sweep fails it as a leak. So:
 *
 * - every pane is created by ONE tmux invocation (`new-session … ; new-session …`), so exactly one
 *   server is ever started;
 * - closing kills the server, then every tmux process still naming the socket (a server that lost the
 *   race, a client still attached), and waits until none is left.
 *
 * BY EXACT ARGV, NEVER BY PATTERN. Closing used to `pkill -f` the socket path, which is a REGULAR
 * EXPRESSION matched against every command line on the machine — and the live tmux server's command
 * line is long. Only a tmux process whose arguments hold `-S <this socket>` verbatim is killed now,
 * and only a socket inside a temporary directory is ever closed at all.
 */
import { basename, join } from 'node:path';
import { assertDisposable } from '../../support/ambient-session.ts';

export interface FleetPanes {
  readonly socket: string;
  /** Kills every tmux process on this socket and waits until none is left. Idempotent. */
  close(): Promise<void>;
}

const tmuxExecutable = (): string => {
  const tmux = Bun.which('tmux');
  if (tmux === null) throw new Error('tmux is required for this test and was not found');
  return tmux;
};

/** Every tmux process whose argv names `-S socket` exactly — the server and any client on it. */
function tmuxPidsOn(socket: string): readonly number[] {
  const listed = Bun.spawnSync(['ps', '-A', '-ww', '-o', 'pid=', '-o', 'args='], { stdout: 'pipe', stderr: 'ignore' });
  return listed.stdout
    .toString()
    .split('\n')
    .map(line => /^\s*(\d+)\s+(.*)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter(match => {
      const argv = (match[2] ?? '').split(/\s+/u);
      return (
        basename(argv[0] ?? '') === 'tmux' && argv.some((arg, index) => arg === '-S' && argv[index + 1] === socket)
      );
    })
    .map(match => Number(match[1]))
    .filter(pid => pid !== process.pid);
}

/** The arguments that create every pane in one invocation: `new-session …` joined by `;`. */
function paneCreationArguments(
  sessions: readonly string[],
  command: readonly string[],
  size: { readonly columns: number; readonly rows: number },
): readonly string[] {
  return sessions.flatMap((session, index) => [
    ...(index === 0 ? [] : [';']),
    'new-session',
    '-d',
    '-s',
    session,
    '-x',
    String(size.columns),
    '-y',
    String(size.rows),
    ...command,
  ]);
}

/** One pane per name in `sessions`, each running `command`, on `<home>/tmux.sock`. */
export async function startFleetPanes(
  home: string,
  sessions: readonly string[],
  command: readonly string[] = ['sleep', '3600'],
  size = { columns: 200, rows: 50 },
): Promise<FleetPanes> {
  const tmux = tmuxExecutable();
  const socket = join(home, 'tmux.sock');
  assertDisposable(socket, 'the fleet panes socket');
  const created = Bun.spawnSync([tmux, '-u', '-S', socket, ...paneCreationArguments(sessions, command, size)]);
  if (created.exitCode !== 0) throw new Error(`tmux could not start the fleet's panes: ${created.stderr.toString()}`);
  let closed = false;
  return {
    socket,
    close: async () => {
      if (closed) return;
      closed = true;
      Bun.spawnSync([tmux, '-u', '-S', socket, 'kill-server']);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const left = tmuxPidsOn(socket);
        if (left.length === 0) return;
        for (const pid of left)
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        await Bun.sleep(50);
      }
      throw new Error(`tmux processes on ${socket} would not end`);
    },
  };
}
