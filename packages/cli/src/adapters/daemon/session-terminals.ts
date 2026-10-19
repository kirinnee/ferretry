import { lstat } from 'node:fs/promises';
import type { IDaemonProcessPort, ISessionTerminalServerPort, SessionTerminalEnding } from '../../lib/daemon/ports.ts';

/**
 * What tmux prints when nothing is serving a socket: no server, or a socket file left by one that
 * already exited. Either way there is no agent to end.
 */
const NO_SERVER = /no server running|error connecting|no such file or directory|connection refused/i;

/**
 * Ends the daemon's private tmux server with `tmux -S <socket> kill-server`.
 *
 * `kill-server` is tmux's own "end every session", so each pane's agent gets the hang-up a closed
 * terminal sends rather than a signal this client aimed at a pid it read from somewhere. The socket is
 * the address and the identity at once: a server on any other socket — the operator's own tmux, or
 * another state home's — is unreachable through it.
 */
export class TmuxSessionTerminalServer implements ISessionTerminalServerPort {
  constructor(
    private readonly processes: Pick<IDaemonProcessPort, 'run'>,
    private readonly tmux = 'tmux',
  ) {}

  async end(socket: string): Promise<SessionTerminalEnding> {
    // No socket means no server ever listened there, and asking tmux would only print an error.
    if ((await lstat(socket).catch(() => undefined)) === undefined) return { kind: 'none' };
    const outcome = await this.processes.run([this.tmux, '-S', socket, 'kill-server']);
    if (outcome.code === 0) return { kind: 'ended' };
    if (outcome.code === 127) return { kind: 'failed', reason: `${this.tmux} was not found on PATH` };
    const said = outcome.stderr.trim();
    if (NO_SERVER.test(said)) return { kind: 'none' };
    return { kind: 'failed', reason: said === '' ? `${this.tmux} exited ${String(outcome.code)}` : said };
  }
}
