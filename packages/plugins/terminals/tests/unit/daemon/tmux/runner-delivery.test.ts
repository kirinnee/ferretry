import { describe, expect, it } from 'bun:test';
import type { RunnerHandle } from '@ferretry/core-ferrets/contract';
import type { InputHolds } from '@ferretry/kernel/contract';
import { type ActRecord, testActRunner, TestMintedIds } from '@ferretry/kernel/testing';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { ComposerUnconfirmedError } from '../../../../daemon/adapters/tmux/composer-fill.ts';
import { PaneNotReadyError, PaneStrandedError } from '../../../../daemon/adapters/tmux/pane-delivery.ts';
import { FakeTmuxServer } from '../../../integration/daemon/support/fake-tmux-server.ts';

/** Decode the quoted arguments of scriptLine for the in-memory server; never run a shell or tmux. */
function scriptWords(script: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < script.length; i++) {
    const char = script[i] ?? '';
    if (quote !== '') {
      if (char === quote) quote = '';
      else if (quote === '"' && char === '\\') {
        const next = script[++i];
        word += next === 'n' ? '\n' : next === 'r' ? '\r' : next;
      } else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

// This fixture is an in-memory composer; no tmux process or real sleep is used.
function subject() {
  const server = new FakeTmuxServer();
  const acts: ActRecord[] = [];
  const handle = '%7' as RunnerHandle;
  let pane = { id: '%7', pid: 4242, session: 'fy-f-hadi', created: 1000, command: 'harness' };
  let held = false;
  let holdAfterBuffer = false;
  let holdAfterPayload = false;
  let beforeGuard: ((write: readonly string[]) => void) | undefined;
  const guards: Array<readonly string[]> = [];
  const cursorRow = () =>
    server.transcript.split('\n').length +
    (server.modal?.split('\n').length ?? 0) +
    (server.working ? 1 : 0) +
    server.composer.split('\n').length -
    1;
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
                stdout: `${pane.id}|${pane.pid}|${server.dead ? '1' : '0'}|${pane.session}|${pane.created}|${pane.command}|${cursorRow()}`,
                stderr: '',
              }
            : { code: 1, stdout: '', stderr: 'no such pane' };
        }
        if (args[0] === 'if-shell') {
          guards.push(args);
          const write = scriptWords(args[5] ?? '');
          beforeGuard?.(write);
          const live: Record<string, string> = {
            pane_id: pane.id,
            pane_pid: String(pane.pid),
            pane_dead: server.dead ? '1' : '0',
            pane_current_command: pane.command,
            cursor_y: String(cursorRow()),
            session_name: pane.session,
            session_created: String(pane.created),
          };
          const comparisons = [...(args[4] ?? '').matchAll(/#\{==:#\{(\w+)\},([^}]*)\}/gu)];
          if (comparisons.length === 0 || !comparisons.every(([, key = '', value]) => live[key] === value))
            return { code: 0, stdout: 'fy-input-guard-refused\n', stderr: '' };
          if (write[0] === 'set-buffer') {
            return await server.execute(['load-buffer', '-b', write[2] ?? '', '-'], write.at(-1)).then(result => {
              if (holdAfterBuffer) held = true;
              return result;
            });
          }
          const result = await server.execute(write);
          if (holdAfterPayload && (write.includes('-l') || write[0] === 'paste-buffer')) held = true;
          return result;
        }
        if (['send-keys', 'paste-buffer', 'load-buffer'].includes(args[0] ?? ''))
          throw new Error('delivery writes must be conditional');
        const result = await server.execute(args, stdin);
        return result;
      },
    },
    spawn: {
      run: async () => {
        throw new Error('delivery must not spawn');
      },
      runBytes: () => Promise.reject(new Error('the fixture runs no bytes')),
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
    guards,
    handle,
    hold: () => {
      held = true;
    },
    holdAfterBuffer: () => {
      holdAfterBuffer = true;
    },
    holdAfterPayload: () => {
      holdAfterPayload = true;
    },
    beforeGuard: (fn: (write: readonly string[]) => void) => {
      beforeGuard = fn;
    },
    replace: (change: Partial<typeof pane>) => {
      pane = { ...pane, ...change };
    },
  };
}

describe('tmux runner message delivery', () => {
  for (const stage of ['literal', 'buffer', 'paste', 'Enter'] as const) {
    for (const change of ['foreground', 'prompt', 'owner', 'pid', 'dead', 'created'] as const) {
      it(`refuses ${change} changes after the lookup before ${stage}, preserving any typed payload`, async () => {
        const world = subject();
        const text = stage === 'buffer' || stage === 'paste' ? 'first line\nsecond line' : 'one send';
        world.beforeGuard(write => {
          const here =
            stage === 'literal'
              ? write.includes('-l')
              : stage === 'buffer'
                ? write[0] === 'set-buffer'
                : stage === 'paste'
                  ? write[0] === 'paste-buffer'
                  : write.at(-1) === 'Enter';
          if (!here) return;
          if (change === 'foreground') world.replace({ command: 'shell' });
          if (change === 'prompt') world.server.modal = 'Do you want to proceed?';
          if (change === 'owner') world.replace({ session: 'fy-webterm-person' });
          if (change === 'pid') world.replace({ pid: 9999 });
          if (change === 'dead') world.server.dead = true;
          if (change === 'created') world.replace({ created: 2000 });
        });

        const delivery = world.runner.deliver(world.handle, { text });
        if (stage === 'Enter') await expect(delivery).rejects.toBeInstanceOf(ComposerUnconfirmedError);
        else await expect(delivery).rejects.toThrow();
        expect(world.server.submitted).toEqual([]);
        expect(world.server.heldBuffers()).toEqual([]);
        const writes = world.server.calls.filter(call => call[0] === 'send-keys' || call[0] === 'paste-buffer');
        expect(writes).toHaveLength(stage === 'Enter' ? 1 : 0);
        expect(world.server.composer).toBe(stage === 'Enter' ? text : '');
      });
    }
  }

  for (const text of ['one send', 'first line\nsecond line']) {
    it(`B153 a hold after ${text.includes('\n') ? 'paste' : 'literal payload'} preserves typed-but-unconfirmed without Enter or retyping`, async () => {
      const world = subject();
      world.holdAfterPayload();

      await expect(world.runner.deliver(world.handle, { text })).rejects.toMatchObject({
        name: 'ComposerUnconfirmedError',
        typings: 1,
      });
      expect(world.server.calls.filter(call => call.includes('-l') || call[0] === 'paste-buffer')).toHaveLength(1);
      expect(world.server.calls.some(call => call.at(-1) === 'Enter' || call.at(-1) === 'C-u')).toBe(false);
      expect(world.server.composer).not.toBe('');
      expect(world.server.submitted).toEqual([]);
    });
  }

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
