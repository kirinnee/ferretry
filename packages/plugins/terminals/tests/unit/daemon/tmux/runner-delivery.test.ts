import { describe, expect, it } from 'bun:test';
import type { RunnerHandle } from '@ferretry/core-ferrets/contract';
import type { InputHolds } from '@ferretry/kernel/contract';
import { type ActRecord, testActRunner, TestMintedIds } from '@ferretry/kernel/testing';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { ComposerUnconfirmedError } from '../../../../daemon/adapters/tmux/composer-fill.ts';
import { PaneNotReadyError, PaneStrandedError } from '../../../../daemon/adapters/tmux/pane-delivery.ts';
import { FakeTmuxServer } from '../../../integration/daemon/support/fake-tmux-server.ts';

// This fixture is an in-memory composer; no tmux process or real sleep is used.
function subject() {
  const server = new FakeTmuxServer();
  const acts: ActRecord[] = [];
  const handle = '%7' as RunnerHandle;
  let pane = { id: '%7', pid: 4242, session: 'fy-f-hadi', created: 1000 };
  let held = false;
  let holdAfterBuffer = false;
  const holds: InputHolds = {
    decide: () => (held ? { refused: 'input_pending' } : 'allow'),
  };
  const runner = new TmuxRunner({
    tmux: {
      execute: async (args, stdin) => {
        if (args[0] === 'display-message' && args.at(-1)?.startsWith('#{pane_id}|')) {
          return server.alive
            ? {
                code: 0,
                stdout: `${pane.id}|${pane.pid}|${server.dead ? '1' : '0'}|${pane.session}|${pane.created}`,
                stderr: '',
              }
            : { code: 1, stdout: '', stderr: 'no such pane' };
        }
        const result = await server.execute(args, stdin);
        if (holdAfterBuffer && args[0] === 'load-buffer') held = true;
        return result;
      },
    },
    spawn: {
      run: async () => {
        throw new Error('delivery must not spawn');
      },
      start: () => {
        throw new Error('delivery must not start');
      },
    },
    socketPath: '/fixture/tmux.sock',
    instantOf: () => 'now' as never,
    now: () => 'now' as never,
    delivery: {
      act: testActRunner({
        holds: () => holds,
        actor: () => 'ferret',
        minted: new TestMintedIds(),
        record: act => acts.push(act),
      }),
      sleep: async ms => server.advance(ms),
    },
  });
  return {
    runner,
    server,
    acts,
    handle,
    hold: () => {
      held = true;
    },
    holdAfterBuffer: () => {
      holdAfterBuffer = true;
    },
    replace: (change: Partial<typeof pane>) => {
      pane = { ...pane, ...change };
    },
  };
}

describe('tmux runner message delivery', () => {
  it('delivers one multiline turn by guarded paste to the exact pane handle', async () => {
    const { runner, server, acts, handle } = subject();
    let before = 0;

    const result = await runner.deliver(handle, {
      text: 'first line\nsecond line',
      beforeWrite: async () => {
        before++;
      },
    });

    expect(result).toBe('turn-started');
    expect(before).toBe(1);
    expect(server.submitted).toEqual(['first line\nsecond line']);
    expect(server.heldBuffers()).toEqual([]);
    expect(
      server.calls.filter(call => call.includes('-t')).every(call => call[call.indexOf('-t') + 1] === handle),
    ).toBe(true);
    expect(acts.length).toBe(3); // load, paste, Enter
    expect(acts.every(act => act.op === 'keys' && act.target.key === handle && act.outcome === 'ran')).toBe(true);
  });

  it('reports a locally handled slash command as delivered', async () => {
    const { runner, server, handle } = subject();
    server.localCommand = true;

    expect(await runner.deliver(handle, { text: '/help' })).toBe('handled-local');
    expect(server.submitted).toEqual(['/help']);
  });

  for (const state of ['absent', 'dead', 'person', 'mismatch', 'invalid'] as const) {
    it(`D15 rejects a ${state} handle without keys, a launch or a restart`, async () => {
      const world = subject();
      if (state === 'absent') world.server.alive = false;
      if (state === 'dead') world.server.dead = true;
      if (state === 'person') world.replace({ session: 'fy-webterm-person' });
      if (state === 'mismatch') world.replace({ id: '%8' });

      await expect(
        world.runner.deliver(state === 'invalid' ? ('bad' as RunnerHandle) : world.handle, { text: 'work' }),
      ).rejects.toBeInstanceOf(PaneNotReadyError);
      expect(world.server.calls).toEqual([]);
      expect(world.acts).toEqual([]);
    });
  }

  it('refuses a held pane before any payload is typed', async () => {
    const { runner, server, handle, hold } = subject();
    hold();

    await expect(runner.deliver(handle, { text: 'work' })).rejects.toThrow('input card');
    expect(
      server.calls.some(call => call[0] === 'send-keys' || call[0] === 'load-buffer' || call[0] === 'paste-buffer'),
    ).toBe(false);
    expect(server.composer).toBe('');
  });

  it('rechecks the hold before a paste and cleans the loaded buffer when it is refused', async () => {
    const { runner, server, handle, holdAfterBuffer } = subject();
    holdAfterBuffer();

    await expect(runner.deliver(handle, { text: 'first line\nsecond line' })).rejects.toThrow('input card');
    expect(server.calls.some(call => call[0] === 'paste-buffer')).toBe(false);
    expect(server.heldBuffers()).toEqual([]);
    expect(server.composer).toBe('');
  });

  it('rejects a replacement incarnation immediately before the write', async () => {
    const { runner, server, handle, replace } = subject();

    await expect(
      runner.deliver(handle, { text: 'work', beforeWrite: async () => replace({ pid: 9999 }) }),
    ).rejects.toThrow();
    expect(server.calls.some(call => call[0] === 'send-keys' || call[0] === 'paste-buffer')).toBe(false);
  });

  it('B153 preserves a typed but unconfirmed send without retyping or erasing it', async () => {
    const { runner, server, handle } = subject();
    server.stalledUntilMs = 100_000;

    await expect(runner.deliver(handle, { text: 'one send' })).rejects.toBeInstanceOf(ComposerUnconfirmedError);
    expect(server.calls.filter(call => call[0] === 'send-keys' && call.includes('-l'))).toHaveLength(1);
    expect(server.calls.some(call => call.at(-1) === 'C-u' || call.at(-1) === 'Enter')).toBe(false);
  });

  it('B153 preserves a stranded send in the composer after bounded Enter attempts', async () => {
    const { runner, server, handle } = subject();
    server.swallowEnters = 100;

    await expect(runner.deliver(handle, { text: 'one send' })).rejects.toBeInstanceOf(PaneStrandedError);
    expect(server.calls.filter(call => call[0] === 'send-keys' && call.includes('-l'))).toHaveLength(1);
    expect(server.calls.filter(call => call.at(-1) === 'Enter')).toHaveLength(3);
    expect(server.composer).toContain('one send');
  });
});
