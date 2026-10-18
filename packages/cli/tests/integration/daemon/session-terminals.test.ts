import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import { TmuxSessionTerminalServer } from '../../../src/adapters/daemon/session-terminals.ts';
import type { CommandOutcome } from '../../../src/lib/daemon/ports.ts';

/**
 * Ending the daemon's private tmux server, against a real tmux where the answer depends on one.
 *
 * The socket is the whole identity: these tests start their own server on a scratch socket, so a
 * tmux the person running the suite has open is unreachable from here by construction.
 */

const TMUX = Bun.which('tmux');
const roots = new Set<string>();
const sockets = new Set<string>();

async function scratchSocket(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-terminals-'));
  roots.add(root);
  return join(root, 'tmux.sock');
}

/** Answers every command with one outcome, for the replies a real tmux is awkward to provoke. */
function answering(outcome: CommandOutcome): { run: () => Promise<CommandOutcome> } {
  return { run: () => Promise.resolve(outcome) };
}

afterEach(async () => {
  for (const socket of sockets) Bun.spawnSync([TMUX ?? 'tmux', '-S', socket, 'kill-server']);
  sockets.clear();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe('ending the session terminal server', () => {
  it('should report no server when nothing ever listened on the socket, without running tmux', async () => {
    // Arrange — a tmux that would fail if it were asked.
    const socket = await scratchSocket();
    const terminals = new TmuxSessionTerminalServer(answering({ code: 1, stdout: '', stderr: 'asked' }));

    // Act + Assert
    should(await terminals.end(socket)).deepEqual({ kind: 'none' });
  });

  it.skipIf(TMUX === null)('should end a running server and every pane in it', async () => {
    // Arrange
    const socket = await scratchSocket();
    const started = Bun.spawnSync([TMUX ?? 'tmux', '-f', '/dev/null', '-S', socket, 'new-session', '-d', 'sleep 600']);
    should(started.exitCode).equal(0);
    sockets.add(socket);

    // Act
    const ending = await new TmuxSessionTerminalServer(new BunDaemonProcess(), TMUX ?? 'tmux').end(socket);

    // Assert — and the server is really gone: asking it anything now fails.
    should(ending).deepEqual({ kind: 'ended' });
    should(Bun.spawnSync([TMUX ?? 'tmux', '-S', socket, 'has-session']).exitCode).not.equal(0);
  });

  it.skipIf(TMUX === null)('should report no server for a socket an exited server left behind', async () => {
    // Arrange — a file at the address, with nothing listening.
    const socket = await scratchSocket();
    await writeFile(socket, '');

    // Act + Assert
    should(await new TmuxSessionTerminalServer(new BunDaemonProcess(), TMUX ?? 'tmux').end(socket)).deepEqual({
      kind: 'none',
    });
  });

  it('should say tmux is missing when it cannot be run at all', async () => {
    // Arrange
    const socket = await scratchSocket();
    await writeFile(socket, '');

    // Act + Assert — the real process port's own answer for a command that does not exist.
    should(
      await new TmuxSessionTerminalServer(new BunDaemonProcess(), '/nonexistent/fy-test/tmux').end(socket),
    ).deepEqual({ kind: 'failed', reason: '/nonexistent/fy-test/tmux was not found on PATH' });
  });

  it('should carry what tmux said when it refused for any other reason', async () => {
    // Arrange
    const socket = await scratchSocket();
    await writeFile(socket, '');
    const terminals = new TmuxSessionTerminalServer(
      answering({ code: 1, stdout: '', stderr: 'protocol version mismatch (client 8, server 7)\n' }),
    );

    // Act + Assert
    should(await terminals.end(socket)).deepEqual({
      kind: 'failed',
      reason: 'protocol version mismatch (client 8, server 7)',
    });
  });

  it('should name the exit code when tmux refused and said nothing', async () => {
    // Arrange
    const socket = await scratchSocket();
    await writeFile(socket, '');

    // Act + Assert
    should(await new TmuxSessionTerminalServer(answering({ code: 3, stdout: '', stderr: '' })).end(socket)).deepEqual({
      kind: 'failed',
      reason: 'tmux exited 3',
    });
  });
});
