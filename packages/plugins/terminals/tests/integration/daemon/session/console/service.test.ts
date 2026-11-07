import { describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunTmuxProcess } from '../../../../src/adapters/index.ts';
import { SessionConsoleError, SessionConsoleService } from '../../../../src/lib/index.ts';
import { waitForValue } from '../../support/wait-for.ts';

/**
 * THE CONSOLE OVER A REAL tmux SERVER: what the reader typed is what the pane received.
 *
 * The pane runs `cat`, so its screen is an exact echo of its input. The proof is replaced — which pane
 * belongs to which session is `SessionAttachService`'s question, tested on its own — but the keys go
 * through the real `send-keys -H` against a private socket, so a quoting or hex mistake shows up as
 * the wrong text on the screen rather than as a passing argument vector.
 */
async function world() {
  const tmux = Bun.which('tmux');
  if (tmux === null) throw new Error('tmux is required for this test and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-console-'));
  const server = new BunTmuxProcess(tmux, join(root, 's'));
  const created = await server.execute(['new-session', '-d', '-s', 'agent', '-x', '80', '-y', '10', 'cat']);
  should(created.code).equal(0, created.stderr);
  const paneId = (await server.execute(['display-message', '-p', '-t', 'agent', '#{pane_id}'])).stdout.trim();
  const proof = {
    resolve: async () => ({ socketPath: join(root, 's'), tmuxSession: 'agent', paneId, pid: 2, processStartTicks: 1 }),
  };
  const screen = async (): Promise<string> =>
    (await server.execute(['capture-pane', '-p', '-t', paneId])).stdout.replaceAll(/\n+$/gu, '');
  const until = async (expected: string): Promise<string> => {
    return await waitForValue(
      async () => {
        const text = await screen();
        return text.includes(expected) ? text : undefined;
      },
      `the pane to show ${JSON.stringify(expected)}`,
    );
  };
  return {
    server,
    console: new SessionConsoleService(proof, server),
    until,
    close: async () => {
      await server.execute(['kill-server']);
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('SessionConsoleService over a real tmux', () => {
  it('should deliver text, Enter and tmux-significant characters byte for byte', async () => {
    // Arrange — `;` and a key name are what a non-hex send-keys would interpret instead of typing.
    const subject = await world();
    try {
      // Act
      const written = await subject.console.write('s1', new TextEncoder().encode('echo a;b Enter é\r'));
      const screen = await subject.until('echo a;b Enter é\necho a;b Enter é');

      // Assert — `cat` echoes the line once as typed and once as its own output.
      should(written).equal(18);
      should(screen.split('\n').slice(0, 2)).deepEqual(['echo a;b Enter é', 'echo a;b Enter é']);
    } finally {
      await subject.close();
    }
  });

  it('should refuse with what tmux said once the pane is gone', async () => {
    // Arrange
    const subject = await world();
    try {
      await subject.server.execute(['kill-server']);

      // Act / Assert
      await should(subject.console.write('s1', new TextEncoder().encode('x'))).be.rejectedWith(SessionConsoleError);
    } finally {
      await subject.close();
    }
  });
});
