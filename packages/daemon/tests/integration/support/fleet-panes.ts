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
 * - closing kills the server, then every process still naming the socket (a server that lost the race,
 *   a client still attached), and waits until none is left.
 */
import { join } from 'node:path';

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
        const left = Bun.spawnSync(['pgrep', '-f', '--', socket]);
        if (left.exitCode !== 0) return;
        Bun.spawnSync(['pkill', '-KILL', '-f', '--', socket]);
        await Bun.sleep(50);
      }
      throw new Error(`tmux processes on ${socket} would not end`);
    },
  };
}
