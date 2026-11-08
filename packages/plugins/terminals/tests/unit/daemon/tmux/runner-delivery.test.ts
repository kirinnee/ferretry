import { describe, expect, it } from 'bun:test';
import { diedParked, type RunnerHandle, runnerDeliveryFailure } from '@ferretry/core-ferrets/contract';
import type { InputHolds } from '@ferretry/kernel/contract';
import { type ActRecord, testActRunner, TestMintedIds } from '@ferretry/kernel/testing';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { ComposerUnconfirmedError } from '../../../../daemon/adapters/tmux/composer-fill.ts';
import { PaneNotReadyError, PaneStrandedError } from '../../../../daemon/adapters/tmux/pane-delivery.ts';
import { FakeTmuxServer } from '../../../integration/daemon/support/fake-tmux-server.ts';
import { scriptWords } from '../../../integration/daemon/support/script-words.ts';

// This fixture is an in-memory composer; no tmux process or real sleep is used.
function subject(options: { readonly unguarded?: boolean } = {}) {
  const server = new FakeTmuxServer();
  const acts: ActRecord[] = [];
  const handle = '%7' as RunnerHandle;
  let pane = { id: '%7', pid: 4242, session: 'fy-f-hadi', created: 1000, command: 'harness' };
  let held = false;
  let holdAfterBuffer = false;
  let holdAfterPayload = false;
  let beforeGuard: ((write: readonly string[]) => void) | undefined;
  /** No cursor in the pane's metadata: a composer no frame can place. */
  let blindCursor = false;
  /** A tmux command whose call throws (the command port itself failed), for a read that cannot be made. */
  let throwOn: string | undefined;
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
        if (throwOn !== undefined && args[0] === throwOn) throw new Error(`tmux ${throwOn} failed`);
        if (blindCursor && args[0] === 'display-message' && !args.at(-1)?.startsWith('#{pane_id}|')) {
          server.calls.push(args);
          return { code: 0, stdout: '0||||24|80\n', stderr: '' };
        }
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
    delivery:
      options.unguarded === true
        ? undefined
        : {
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
    blindCursor: () => {
      blindCursor = true;
    },
    throwOn: (command: string) => {
      throwOn = command;
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
        // harness-refusals: nothing of the payload typed, so a closed not_ready — a moved cursor row is a redrawing
        // (busy) pane, any other change a gone one — never an unclassified rejection a retry would read as maybe-typed.
        else
          expect(
            runnerDeliveryFailure(
              await delivery.then(
                () => undefined,
                (error: unknown) => error,
              ),
            ),
          ).toEqual({
            kind: 'not_ready',
            why: change === 'prompt' ? 'busy' : 'exited',
          });
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

describe('#23 pane-queue: a queued message is typed only through kernel.act and a held target types nothing', () => {
  /** A fake fixture value standing in for whatever a person would not want typed into the wrong pane. */
  const FIXTURE_SECRET = 'fixture-not-a-secret-7f3a';

  it('#23 pane-queue: every write the queue makes is an act on the exact pane, and it answers what the pane proves', async () => {
    const { runner, server, acts, guards, handle } = subject();

    const outcome = await runner.queue(handle, `queue this ${FIXTURE_SECRET}`);

    expect(['held', 'typed', 'left']).toContain(outcome);
    // The fixture's pane is idle, so Enter submitted it: it left the composer and no queue shows it.
    expect(outcome).toBe('left');
    expect(server.submitted).toEqual([`queue this ${FIXTURE_SECRET}`]);
    // Every keystroke went through the act runner on THIS pane, and through the server-side guard; none raw.
    expect(acts.length).toBeGreaterThan(0);
    expect(acts.every(act => act.op === 'keys' && act.target.key === handle && act.outcome === 'ran')).toBe(true);
    expect(guards.length).toBe(acts.length);
    expect(
      server.calls.filter(call => call.includes('-t')).every(call => call[call.indexOf('-t') + 1] === handle),
    ).toBe(true);
  });

  it('#23 pane-queue: a held target types nothing, and the refusal quotes nothing of the message', async () => {
    const { runner, server, acts, handle, hold } = subject();
    hold();

    const queued = runner.queue(handle, `queue this ${FIXTURE_SECRET}`);

    await expect(queued).rejects.toThrow('input card');
    await queued.catch((error: unknown) => {
      expect(String(error instanceof Error ? error.message : error)).not.toContain(FIXTURE_SECRET);
    });
    expect(
      server.calls.some(call => call[0] === 'send-keys' || call[0] === 'load-buffer' || call[0] === 'paste-buffer'),
    ).toBe(false);
    expect(server.composer).toBe('');
    expect(server.submitted).toEqual([]);
    expect(acts.every(act => act.outcome !== 'ran')).toBe(true);
  });

  it('#23 pane-queue: a handle with nothing behind it rejects without a key or an act', async () => {
    const world = subject();
    world.server.alive = false;

    await expect(world.runner.queue(world.handle, 'work')).rejects.toBeInstanceOf(PaneNotReadyError);
    expect(world.server.calls).toEqual([]);
    expect(world.acts).toEqual([]);
  });
});

/**
 * Today's `TmuxSessionLifecycleLauncher.settled` (britnee's ruling, test (e)): after the first turn, the runner watches
 * the SAME exact pane, read only, for the harness to finish its own startup. Codex 0.166 parks a submission under
 * `Waiting for startup · esc cancel` until its account check answers; a pane that dies in that window rejects with
 * `parked: true`. No key, buffer or paste is ever sent by the wait.
 */
describe('settleStartup (e) the tmux runner waits out a parked startup and writes nothing', () => {
  const writes = (world: ReturnType<typeof subject>) =>
    world.server.commands().filter(command => ['send-keys', 'load-buffer', 'paste-buffer'].includes(command));

  it('settleStartup (e) a pane that shows the park and then dies rejects with parked: true, and no write is made', async () => {
    const world = subject();
    world.server.startupWaitUntilMs = 60_000;
    const advance = world.server.advance.bind(world.server);
    world.server.advance = (ms: number) => {
      advance(ms);
      world.server.dead = true;
    };

    const error = await world.runner.settled(world.handle).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(diedParked(error)).toBe(true);
    expect(writes(world)).toEqual([]);
    expect(world.guards).toEqual([]);
    expect(world.acts).toEqual([]);
  });

  it('settleStartup (e) a pane already dead before any park was seen rejects without parked', async () => {
    const world = subject();
    world.server.dead = true;

    const error = await world.runner.settled(world.handle).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeDefined();
    expect(diedParked(error)).toBe(false);
    expect(writes(world)).toEqual([]);
  });

  it('settleStartup (e) a harness that is up answers settled, and one still parked past the bound answers timed-out, both without a write', async () => {
    const up = subject();
    expect(await up.runner.settled(up.handle)).toBe('settled');
    expect(writes(up)).toEqual([]);

    const slow = subject();
    slow.server.startupWaitUntilMs = Number.MAX_SAFE_INTEGER;
    expect(await slow.runner.settled(slow.handle)).toBe('timed-out');
    expect(writes(slow)).toEqual([]);
    expect(slow.guards).toEqual([]);
  });

  it('settleStartup the last screen of a ferret pane is read by its exact id, dead or alive, and a person’s shell answers nothing', async () => {
    const world = subject();
    world.server.transcript = 'workspace routing discovery failed';
    world.server.dead = true;

    expect(await world.runner.lastScreen(world.handle)).toContain('workspace routing discovery failed');
    expect(world.server.calls.some(call => call[0] === 'capture-pane' && call.at(-1) === world.handle)).toBe(true);
    expect(writes(world)).toEqual([]);

    const shell = subject();
    shell.replace({ session: 'fy-webterm-person' });
    expect(await shell.runner.lastScreen(shell.handle)).toBe('');
    expect(await shell.runner.lastScreen('not-a-pane' as RunnerHandle)).toBe('');
  });
});

/** What a runner rejection says through the contract, or `'resolved'` when it did not reject. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => 'resolved',
    (error: unknown) => runnerDeliveryFailure(error),
  );
}

const typedAnything = (world: ReturnType<typeof subject>): boolean =>
  world.server.calls.some(call => ['send-keys', 'load-buffer', 'paste-buffer'].includes(call[0] ?? ''));

describe('harness-refusals: every rejection the tmux runner knows the cause of carries the closed failure', () => {
  it('harness-refusals a held pane types nothing and says the act’s own code, not the tmux error text', async () => {
    const world = subject();
    world.hold();

    expect(await failureOf(world.runner.deliver(world.handle, { text: 'work' }))).toEqual({
      kind: 'held',
      code: 'input_pending',
    });
    expect(typedAnything(world)).toBe(false);
    expect(await failureOf(world.runner.queue(world.handle, 'work'))).toEqual({ kind: 'held', code: 'input_pending' });
    expect(typedAnything(world)).toBe(false);
  });

  it('harness-refusals a hold met AFTER the payload was typed is typed-but-unconfirmed, never a nothing-typed hold', async () => {
    const world = subject();
    world.holdAfterPayload();

    expect(await failureOf(world.runner.deliver(world.handle, { text: 'one send' }))).toEqual({
      kind: 'unconfirmed',
      stranded: false,
    });
  });

  it('harness-refusals a stranded send is unconfirmed and stranded; a gone pane is not_ready/exited', async () => {
    const stranded = subject();
    stranded.server.swallowEnters = 100;
    expect(await failureOf(stranded.runner.deliver(stranded.handle, { text: 'one send' }))).toEqual({
      kind: 'unconfirmed',
      stranded: true,
    });

    const gone = subject();
    gone.server.alive = false;
    expect(await failureOf(gone.runner.deliver(gone.handle, { text: 'one send' }))).toEqual({
      kind: 'not_ready',
      why: 'exited',
    });
  });

  it('harness-refusals a runner with no act runner bound writes nothing and says holds_unavailable (fail closed)', async () => {
    const world = subject({ unguarded: true });

    expect(await failureOf(world.runner.deliver(world.handle, { text: 'work' }))).toEqual({
      kind: 'held',
      code: 'holds_unavailable',
    });
    expect(await failureOf(world.runner.stopTurn(world.handle, { key: 'Escape', whenIdle: true }))).toEqual({
      kind: 'held',
      code: 'holds_unavailable',
    });
    expect(typedAnything(world)).toBe(false);
  });
});

describe('harness-refusals: stopTurn presses the harness’s stop key under shouldPressStopKey, and never C-c', () => {
  const keys = (world: ReturnType<typeof subject>) =>
    world.server.calls.filter(call => call[0] === 'send-keys').map(call => call.at(-1));

  it('harness-refusals shouldPressStopKey: a working pane gets exactly one Escape, acted on the exact pane', async () => {
    const world = subject();
    world.server.working = true;

    expect(await world.runner.stopTurn(world.handle, { key: 'Escape', whenIdle: false })).toEqual({
      pressed: true,
      working: true,
    });
    expect(keys(world)).toEqual(['Escape']);
    expect(world.server.calls.some(call => call.includes('C-c'))).toBe(false);
    expect(world.acts).toHaveLength(1);
    expect(world.acts[0]).toMatchObject({ op: 'keys', target: { key: world.handle }, outcome: 'ran' });
    expect(world.guards).toHaveLength(1);
  });

  it('harness-refusals shouldPressStopKey: an idle pane whose key is not harmless there is never pressed (Codex quits on it)', async () => {
    const world = subject();
    world.server.working = false;

    expect(await world.runner.stopTurn(world.handle, { key: 'Escape', whenIdle: false })).toEqual({
      pressed: false,
      working: false,
    });
    expect(keys(world)).toEqual([]);
    expect(world.acts).toEqual([]);
  });

  it('harness-refusals shouldPressStopKey: an idle pane is pressed when the key is harmless there', async () => {
    const world = subject();
    world.server.working = false;

    expect(await world.runner.stopTurn(world.handle, { key: 'Escape', whenIdle: true })).toEqual({
      pressed: true,
      working: false,
    });
    expect(keys(world)).toEqual(['Escape']);
  });

  it('harness-refusals a held pane presses nothing and says the hold’s code', async () => {
    const world = subject();
    world.server.working = true;
    world.hold();

    expect(await failureOf(world.runner.stopTurn(world.handle, { key: 'Escape', whenIdle: true }))).toEqual({
      kind: 'held',
      code: 'input_pending',
    });
    expect(keys(world)).toEqual([]);
  });

  it('harness-refusals a gone pane or a person’s shell is not_ready/exited, with no key', async () => {
    for (const change of ['absent', 'person'] as const) {
      const world = subject();
      if (change === 'absent') world.server.alive = false;
      else world.replace({ session: 'fy-webterm-person' });
      expect(await failureOf(world.runner.stopTurn(world.handle, { key: 'Escape', whenIdle: true }))).toEqual({
        kind: 'not_ready',
        why: 'exited',
      });
      expect(keys(world)).toEqual([]);
    }
  });

  it('harness-refusals no caller can make a stop press C-c or any key outside the closed set', async () => {
    for (const key of ['C-c', 'Enter', 'y']) {
      const world = subject();
      world.server.working = true;
      await expect(world.runner.stopTurn(world.handle, { key: key as 'Escape', whenIdle: true })).rejects.toThrow(
        'not a harness stop key',
      );
      expect(world.server.calls).toEqual([]);
    }
  });
});

/** Whether any payload write (a buffer load, a paste or a literal) reached the pane's server. */
const payloadWritten = (world: ReturnType<typeof subject>): boolean =>
  world.server.calls.some(call => call[0] === 'load-buffer' || call[0] === 'paste-buffer' || call.includes('-l'));

describe('harness-refusals: each refusal kind at the tmux runner itself, with no payload key reaching the pane', () => {
  it('harness-refusals composer_occupied: a person’s draft is answered with the draft, and nothing is typed onto it', async () => {
    const world = subject();
    world.server.composer = 'go ahead with all three';
    world.server.cursorHome = true;

    expect(await failureOf(world.runner.deliver(world.handle, { text: 'hello' }))).toEqual({
      kind: 'composer_occupied',
      draft: 'go ahead with all three',
    });
    expect(payloadWritten(world)).toBe(false);
    expect(world.server.composer).toBe('go ahead with all three');
    expect(world.server.submitted).toEqual([]);
  });

  it('harness-refusals composer_occupied: a queue into a busy pane with a draft types nothing', async () => {
    const world = subject();
    world.server.working = true;
    world.server.composer = 'hi';

    expect(await failureOf(world.runner.queue(world.handle, 'hello'))).toEqual({
      kind: 'composer_occupied',
      draft: 'hi',
    });
    expect(typedAnything(world)).toBe(false);
    expect(world.server.composer).toBe('hi');
  });

  it('harness-refusals composer_unreadable: a composer no frame can place types nothing', async () => {
    const world = subject();
    world.server.working = true;
    world.server.composer = 'half a question';
    // No cursor and no colour attributes: neither the cursor nor the ink can tell a draft from a placeholder.
    world.server.attributes = false;
    world.blindCursor();

    expect(await failureOf(world.runner.queue(world.handle, 'read the queued brief'))).toEqual({
      kind: 'composer_unreadable',
    });
    expect(typedAnything(world)).toBe(false);
    expect(world.server.composer).toBe('half a question');
  });

  it('harness-refusals not_ready/busy: a pane that never comes to a prompt gets no payload key', async () => {
    const world = subject();
    world.server.bootCaptures = Number.MAX_SAFE_INTEGER;

    expect(await failureOf(world.runner.deliver(world.handle, { text: 'work' }))).toEqual({
      kind: 'not_ready',
      why: 'busy',
    });
    expect(payloadWritten(world)).toBe(false);
    expect(world.server.submitted).toEqual([]);
  });

  for (const change of ['pid', 'redraw'] as const) {
    it(`harness-refusals a ${change === 'pid' ? 'replaced pane' : 'cursor that moved'} before the first queue write is not_ready, with nothing typed`, async () => {
      const world = subject();
      world.server.working = true;
      world.beforeGuard(() => {
        if (change === 'pid') world.replace({ pid: 9999 });
        else world.server.transcript = `${world.server.transcript}\nmore output`;
      });

      expect(await failureOf(world.runner.queue(world.handle, 'hello'))).toEqual({
        kind: 'not_ready',
        why: change === 'pid' ? 'exited' : 'busy',
      });
      expect(typedAnything(world)).toBe(false);
      expect(world.server.composer).toBe('');
    });
  }
});

describe('harness-refusals: stopTurn answers a failure before the press as not_ready/exited, with nothing pressed', () => {
  const pressed = (world: ReturnType<typeof subject>) => world.server.calls.filter(call => call[0] === 'send-keys');

  for (const change of ['foreground', 'pid', 'owner', 'redraw'] as const) {
    it(`harness-refusals a pane whose ${change === 'redraw' ? 'cursor row' : change} changed between the read and the press is not_ready/exited, and no key reaches it`, async () => {
      const world = subject();
      world.server.working = true;
      world.beforeGuard(() => {
        if (change === 'foreground') world.replace({ command: 'shell' });
        if (change === 'pid') world.replace({ pid: 9999 });
        if (change === 'owner') world.replace({ session: 'fy-webterm-person' });
        // A working pane streaming output: its cursor row moves under the press, and the server guard refuses it.
        if (change === 'redraw') world.server.transcript = `${world.server.transcript}\nmore output`;
      });

      expect(await failureOf(world.runner.stopTurn(world.handle, { key: 'Escape', whenIdle: true }))).toEqual({
        kind: 'not_ready',
        why: 'exited',
      });
      expect(pressed(world)).toEqual([]);
      expect(world.guards).toHaveLength(1);
    });
  }

  it('harness-refusals a pane replaced before the press is refused by the binding itself, before the server guard', async () => {
    const world = subject();
    world.server.working = true;
    // Changed after the first read and before the write's own re-check: the binding refuses it, no guard is sent.
    let reads = 0;
    const capture = world.server.execute.bind(world.server);
    world.server.execute = async (argv, stdin) => {
      const answer = await capture(argv, stdin);
      if (argv[0] === 'capture-pane' && ++reads === 1) world.replace({ created: 2000 });
      return answer;
    };

    expect(await failureOf(world.runner.stopTurn(world.handle, { key: 'Escape', whenIdle: true }))).toEqual({
      kind: 'not_ready',
      why: 'exited',
    });
    expect(pressed(world)).toEqual([]);
    expect(world.guards).toEqual([]);
  });

  it('harness-refusals a first read that fails is not_ready/exited, and nothing is pressed or acted', async () => {
    const world = subject();
    world.server.working = true;
    world.throwOn('capture-pane');

    expect(await failureOf(world.runner.stopTurn(world.handle, { key: 'Escape', whenIdle: true }))).toEqual({
      kind: 'not_ready',
      why: 'exited',
    });
    expect(pressed(world)).toEqual([]);
    expect(world.acts).toEqual([]);
    expect(world.guards).toEqual([]);
  });
});
