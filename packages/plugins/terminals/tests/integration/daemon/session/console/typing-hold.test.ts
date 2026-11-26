import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunSpawn } from '@ferretry/kernel/host';
import { observePane } from '../../../../../daemon/adapters/tmux/pane-observation.ts';
import { KernelTmuxProcess } from '../../../../../daemon/adapters/tmux/kernel-tmux-process.ts';
import { SessionConsoleService, TypingHold } from '../../../../../daemon/lib/session/console/index.ts';
import { TmuxController } from '../../../../../daemon/lib/tmux/controller.ts';
import { waitForValue } from '../../support/wait-for.ts';

/**
 * THE TYPING HOLD OVER A REAL tmux, with NO tmux hook anywhere (owner idea A563): a person's keys are seen in the two
 * doors that lead to a pane — the app's Console, and a client attached with `tmux attach` — and a daemon's own
 * `send-keys` is neither. The attached client is a real one: `script` gives `tmux attach` the terminal it insists on,
 * and what the test writes into its stdin is what a person's keyboard would.
 */
async function world() {
  const tmux = Bun.which('tmux');
  const script = Bun.which('script');
  if (tmux === null || script === null) throw new Error('tmux and script are required for this test');
  const root = await mkdtemp(join(tmpdir(), 'fy-typing-'));
  const socket = join(root, 's');
  const server = new KernelTmuxProcess(bunSpawn({ PATH: process.env.PATH ?? '/usr/bin:/bin' }), socket, tmux);
  const created = await server.execute(['new-session', '-d', '-s', 'agent', '-x', '80', '-y', '10', 'cat']);
  expect(created.code).toBe(0);
  const paneId = (await server.execute(['display-message', '-p', '-t', 'agent', '#{pane_id}'])).stdout.trim();
  // The daemon's clock, moved forward for ONE look so the 5 s hold can be waited out without waiting.
  let skew = 0;
  const hold = new TypingHold(() => Date.now() + skew);
  const proof = {
    resolve: async () => ({ socketPath: socket, tmuxSession: 'agent', paneId, pid: 2, processStartTicks: 1 }),
  };
  const clients: { kill: () => void }[] = [];
  return {
    server,
    paneId,
    hold,
    console: new SessionConsoleService(proof, server, hold),
    held: async (later = 0) => {
      skew = later;
      try {
        return await hold.held(server, paneId, 'agent');
      } finally {
        skew = 0;
      }
    },
    observed: async (later = 0) => {
      skew = later;
      try {
        return await observePane(
          { tmux: server, typing: hold },
          { tmux: new TmuxController(server), session: 'agent' },
          paneId,
        );
      } finally {
        skew = 0;
      }
    },
    /** A person at a terminal: a real attached client, and the stream their keyboard writes to. */
    attach: () => {
      const child = Bun.spawn([script, '-qfc', `${tmux} -S ${socket} attach -t agent`, '/dev/null'], {
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      clients.push({ kill: () => child.kill() });
      return { type: (text: string) => void child.stdin.write(text) };
    },
    close: async () => {
      for (const client of clients) client.kill();
      await server.execute(['kill-server']);
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('the typing hold over a real tmux', () => {
  it('should see a key typed through tmux attach, and let go after the hold, with no hook set', async () => {
    const subject = await world();
    try {
      const person = subject.attach();
      await waitForValue(
        async () => ((await subject.server.execute(['list-clients'])).stdout.trim() === '' ? undefined : true),
        'the client to attach',
      );
      // Its attaching is not typing: only input is, and the second the client began is long past the hold.
      expect(await subject.held(6_000)).toBe(false);

      person.type('hello');
      await waitForValue(async () => ((await subject.held()) ? true : undefined), 'the typed key to hold the pane');
      expect(await subject.held(6_000)).toBe(false);
      // A hook set on the server would list as `name[0] command`: the bare names are tmux's own unset ones.
      expect((await subject.server.execute(['show-hooks', '-g'])).stdout).not.toMatch(/\[\d+\]/u);
    } finally {
      await subject.close();
    }
  });

  it('should hold for a Console key as the pane shows it, and not for the daemon’s own send-keys', async () => {
    const subject = await world();
    try {
      await subject.server.execute(['send-keys', '-t', subject.paneId, '-l', 'daemon']);
      expect(await subject.held()).toBe(false);

      await subject.console.write('s1', new TextEncoder().encode('x'));
      expect(await subject.held()).toBe(true);
      expect(await subject.held(5_000)).toBe(false);
    } finally {
      await subject.close();
    }
  });

  it('should say typing in the observation the send path reads, and only while the hold stands', async () => {
    const subject = await world();
    try {
      expect((await subject.observed()).typing).toBeUndefined();
      await subject.console.write('s1', new TextEncoder().encode('x'));
      expect((await subject.observed()).typing).toBe(true);
      expect((await subject.observed(5_000)).typing).toBeUndefined();
    } finally {
      await subject.close();
    }
  });
});
