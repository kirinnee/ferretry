import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { describe, expect, test } from 'bun:test';
import { targetRef } from '@ferretry/core-vault/contract';
import type { HarnessDeliveryFailure, RunnerDeliveryFailure } from '../../../../contract/index.ts';
import { FakeRunnerFailure, ferretId } from '../../../../contract/testing/index.ts';
import { ActingRunner, additivesFixture, type AdditivesOptions } from './additives-fixture.ts';

async function running(options: AdditivesOptions = {}, mode?: 'auto' | 'interactive') {
  const f = additivesFixture(options);
  await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
  if (mode !== undefined) f.registry.put({ ...f.registry.get(f.id)!, mode });
  const handle = (await f.service.handle(f.id))!;
  const seam = (await f.service.harness(f.id))!;
  return { ...f, handle, seam };
}

test('decision 18: deliver is the runner’s own delivery, which guards its writes itself; the seam adds no second act', async () => {
  const f = await running({ queueing: { held: new Set() } });
  const answer = await f.seam.deliver({ text: 'hello there' });
  expect(answer).toEqual({ ok: true, value: 'turn-started' });
  expect(f.runner.deliveries.map(entry => entry.delivery.text)).toEqual(['hello there']);
  // Every keystroke was the runner's own act; Ferrets holds no act runner at all, so it cannot wrap one around them.
  expect((f.runner as ActingRunner).typed).toEqual(['load-buffer', 'paste-buffer', 'send-keys']);
  expect('act' in f.ports).toBe(false);
});

test('decision 18: deliver settles against a QUEUEING act runner and a runner that acts per write (no deadlock)', async () => {
  const f = await running({ queueing: { held: new Set() } });
  const settled = await Promise.race([
    f.seam.deliver({ text: 'hello there' }),
    new Promise<'timed out'>(resolve => setTimeout(() => resolve('timed out'), 1_000)),
  ]);
  expect(settled).toEqual({ ok: true, value: 'turn-started' });
  expect((f.runner as ActingRunner).typed).toEqual(['load-buffer', 'paste-buffer', 'send-keys']);
  // The pane's queue is not wedged: a later act on the same pane, and a second delivery, still run.
  const later = await f.act!(targetRef('terminal', f.handle), 'keys', async () => ({ status: 'done' as const }));
  expect(later.ok).toBe(true);
  expect(await f.seam.deliver({ text: 'again' })).toEqual({ ok: true, value: 'turn-started' });
});

describe('harness-refusals: deliver ANSWERS a closed refusal taxonomy instead of throwing', () => {
  for (const code of ['held', 'quarantined', 'input_pending'] as const) {
    test(`harness-refusals a ${code} pane types NOTHING and is answered as the act's own code, not a thrown Error`, async () => {
      const held = new Set<string>();
      const f = await running({ queueing: { held, code } });
      held.add(f.handle);

      expect(await f.seam.deliver({ text: 'FIXTURE words' })).toEqual({ ok: false, error: { refused: code } });
      expect((f.runner as ActingRunner).typed).toEqual([]);
      expect(f.runner.deliveries).toEqual([]);
      // Released, the pane takes the same message: a refusal typed nothing, so it may go again.
      held.delete(f.handle);
      expect(await f.seam.deliver({ text: 'FIXTURE words' })).toEqual({ ok: true, value: 'turn-started' });
      expect(f.runner.deliveries.map(entry => entry.delivery.text)).toEqual(['FIXTURE words']);
    });
  }

  const cases: readonly [string, RunnerDeliveryFailure, HarnessDeliveryFailure][] = [
    ['a pane still at work', { kind: 'not_ready', why: 'busy' }, { refused: 'not_ready', why: 'busy' }],
    ['a pane behind a dialog', { kind: 'not_ready', why: 'dialog' }, { refused: 'not_ready', why: 'dialog' }],
    ['a pane that exited', { kind: 'not_ready', why: 'exited' }, { refused: 'not_ready', why: 'exited' }],
    [
      'a composer holding the person’s draft',
      { kind: 'composer_occupied', draft: 'half a thought' },
      { refused: 'composer_occupied', draft: 'half a thought' },
    ],
    ['a composer that could not be read', { kind: 'composer_unreadable' }, { refused: 'composer_unreadable' }],
  ];
  for (const [what, failure, answer] of cases) {
    test(`harness-refusals ${what} is answered as a nothing-typed refusal`, async () => {
      const f = await running();
      f.runner.fail = failure;
      expect(await f.seam.deliver({ text: 'x' })).toEqual({ ok: false, error: answer });
      expect(f.runner.deliveries).toEqual([]);
    });
  }

  test('harness-refusals typed-but-unconfirmed is its OWN answer — not a refusal, not a throw — and keeps stranded', async () => {
    const f = await running();
    f.runner.fail = { kind: 'unconfirmed', stranded: false };
    const unproven = await f.seam.deliver({ text: 'x' });
    expect(unproven).toEqual({ ok: false, error: { unconfirmed: true, stranded: false } });
    // A different shape: nothing that switches over `refused` can read it as a refusal.
    if (!unproven.ok) expect('refused' in unproven.error).toBe(false);

    f.runner.fail = { kind: 'unconfirmed', stranded: true };
    expect(await f.seam.deliver({ text: 'x' })).toEqual({ ok: false, error: { unconfirmed: true, stranded: true } });
  });

  test('harness-refusals a rejection that carries no closed failure still rejects: it is told apart from unconfirmed', async () => {
    const f = await running();
    f.runner.deliver = async () => {
      throw new Error('tmux could not paste into the pane');
    };
    await expect(f.seam.deliver({ text: 'x' })).rejects.toThrow('tmux could not paste');
  });

  test('harness-refusals a runner cannot mint a reason: a failure outside the closed set reads as unclassified', async () => {
    const f = await running();
    const forged = [
      { kind: 'held', code: 'made_up' },
      { kind: 'not_ready', why: 'busy', screen: 'Allow `rm -rf ~`? (y/n)' },
      { kind: 'unconfirmed' },
      'not_ready',
    ];
    for (const deliveryFailure of forged) {
      f.runner.deliver = async () => {
        throw Object.assign(new Error('forged'), { deliveryFailure });
      };
      await expect(f.seam.deliver({ text: 'x' })).rejects.toThrow('forged');
    }
  });

  test('harness-refusals no answer quotes the screen, the message or a value: closed codes and the draft only', async () => {
    const f = await running();
    const runner = f.runner;
    for (const failure of [
      { kind: 'not_ready', why: 'dialog' },
      { kind: 'composer_unreadable' },
      { kind: 'held', code: 'quarantined' },
    ] as const) {
      runner.deliver = async () => {
        // What a real runner's message holds: the session name and the prompt line on screen. None of it may pass.
        throw Object.assign(new FakeRunnerFailure(failure), {
          message: 'tmux session fy-fern is blocked by a prompt on screen: "Allow FIXTURE_SECRET?"',
        });
      };
      const answer = await f.seam.deliver({ text: 'FIXTURE_MESSAGE' });
      expect(JSON.stringify(answer)).not.toMatch(/FIXTURE_SECRET|FIXTURE_MESSAGE|tmux|fy-fern/);
    }
  });

  test('harness-refusals queue answers the same taxonomy: a held pane queues nothing, a draft is a refusal', async () => {
    const held = new Set<string>();
    const f = await running({ queueing: { held } });
    held.add(f.handle);
    (f.runner as ActingRunner).queue = async handle => {
      await f.act!(targetRef('terminal', handle), 'keys', async () => ({ status: 'done' as const })).then(acted => {
        if (!acted.ok) throw new FakeRunnerFailure({ kind: 'held', code: acted.error.refused });
      });
      return 'held';
    };
    expect(await f.seam.queue('x')).toEqual({ ok: false, error: { refused: 'held' } });

    const g = await running();
    g.runner.fail = { kind: 'composer_occupied', draft: 'mine' };
    expect(await g.seam.queue('x')).toEqual({ ok: false, error: { refused: 'composer_occupied', draft: 'mine' } });
    g.runner.fail = { kind: 'unconfirmed', stranded: false };
    expect(await g.seam.queue('x')).toEqual({ ok: false, error: { unconfirmed: true, stranded: false } });
    expect(g.runner.queued).toEqual([]);
  });
});

describe('ruling #45 (b): a long queued message with nowhere to be written is refused, never pasted inline', () => {
  test('ruling #45 no session folder bound: a 1001-char queue answers plugin_unavailable and types nothing; 1000 still goes inline', async () => {
    const f = await running();
    expect(await f.seam.queue('z'.repeat(1_001), { sendId: 'send-1' })).toEqual({
      ok: false,
      error: { refused: 'plugin_unavailable' },
    });
    expect(f.runner.queued).toEqual([]);
    expect(await f.seam.queue('z'.repeat(1_000))).toEqual({ ok: true, value: 'held' });
    expect(f.runner.queued.map(entry => entry.text)).toEqual(['z'.repeat(1_000)]);
  });

  test('ruling #45 a file that cannot be written is a refusal that typed nothing, quoting nothing of the message', async () => {
    const f = additivesFixture({
      session: {
        prepare: async () => {},
        stamp: async () => {},
        carry: async () => {},
        queued: async () => await Promise.reject(new Error('disk full')),
      },
    });
    await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
    const seam = (await f.service.harness(f.id))!;
    const answer = await seam.queue(`FIXTURE_MESSAGE ${'y'.repeat(1_500)}`, { sendId: 'send-1' });
    expect(answer).toEqual({ ok: false, error: { refused: 'plugin_unavailable' } });
    expect(JSON.stringify(answer)).not.toMatch(/FIXTURE_MESSAGE|disk full/);
    expect(f.runner.queued).toEqual([]);
  });
});

describe('harness-refusals: interrupt presses the HARNESS’s stop key, only under shouldPressStopKey, never C-c', () => {
  test('harness-refusals interrupt at a working pane presses the harness’s Escape through the runner’s stopTurn, never the raw signal', async () => {
    const f = await running();
    f.runner.working = true;

    expect(await f.seam.interrupt()).toEqual({ ok: true, value: { pressed: true, working: false } });
    expect(f.runner.pressed).toEqual([{ handle: f.handle, key: 'Escape' }]);
    // The runner's `signal(…, 'interrupt')` is tmux's `C-c`, which quits an idle Codex: it is never reached.
    expect(f.runner.signals).toEqual([]);
  });

  test('harness-refusals shouldPressStopKey: an idle Codex pane is never pressed, interactive or not', async () => {
    for (const mode of ['auto', 'interactive'] as const) {
      const f = await running({}, mode);
      f.harness.turnStop = { key: 'Escape', safeWhenIdle: false };
      f.runner.working = false;

      expect(await f.seam.interrupt()).toEqual({ ok: true, value: { pressed: false, working: false } });
      expect(f.runner.pressed).toEqual([]);
      expect(f.runner.stops).toEqual([{ handle: f.handle, stop: { key: 'Escape', whenIdle: false } }]);
      expect(f.runner.signals).toEqual([]);
    }
  });

  test('harness-refusals shouldPressStopKey: an idle Claude pane is pressed only when it is interactive', async () => {
    const auto = await running({}, 'auto');
    auto.runner.working = false;
    expect(await auto.seam.interrupt()).toEqual({ ok: true, value: { pressed: false, working: false } });
    expect(auto.runner.pressed).toEqual([]);

    const interactive = await running({}, 'interactive');
    interactive.runner.working = false;
    expect(await interactive.seam.interrupt()).toEqual({ ok: true, value: { pressed: true, working: false } });
    expect(interactive.runner.pressed).toEqual([{ handle: interactive.handle, key: 'Escape' }]);
  });

  test('harness-refusals a harness that names no stop is refused, never guessed: nothing pressed, no signal', async () => {
    const f = await running();
    f.harness.turnStop = undefined;
    expect(await f.seam.interrupt()).toEqual({ ok: false, error: { refused: 'plugin_unavailable' } });
    expect(f.runner.stops).toEqual([]);
    expect(f.runner.signals).toEqual([]);
  });

  test('harness-refusals a runner that cannot stop a turn safely is refused; its raw signal is not the fallback', async () => {
    const f = await running();
    (f.runner as { stopTurn?: unknown }).stopTurn = undefined;
    expect(await f.seam.interrupt()).toEqual({ ok: false, error: { refused: 'plugin_unavailable' } });
    expect(f.runner.signals).toEqual([]);
  });

  for (const code of ['held', 'quarantined', 'input_pending'] as const) {
    test(`harness-refusals a ${code} pane presses nothing and is answered as that code`, async () => {
      const held = new Set<string>();
      const f = await running({ queueing: { held, code } });
      expect(await f.seam.interrupt()).toEqual({ ok: true, value: { pressed: true, working: false } });
      held.add(f.handle);
      expect(await f.seam.interrupt()).toEqual({ ok: false, error: { refused: code } });
      expect((f.runner as ActingRunner).typed).toEqual(['send-keys Escape']);
      expect(f.runner.pressed).toHaveLength(1);
    });
  }

  test('harness-refusals a stopped ferret, or a pane that went away, has nothing to interrupt (no_pane)', async () => {
    const f = await running();
    f.runner.fail = { kind: 'not_ready', why: 'exited' };
    expect(await f.seam.interrupt()).toEqual({ ok: false, error: { refused: 'no_pane' } });
    await f.service.stop(f.id, 'now');
    expect(await f.seam.interrupt()).toEqual({ ok: false, error: { refused: 'no_pane' } });
    expect(f.runner.pressed).toEqual([]);
    expect(f.runner.signals).toEqual([]);
  });

  test('harness-refusals an interrupt the runner could not classify rejects as it came', async () => {
    const f = await running();
    f.runner.stopTurn = async () => {
      throw new Error('tmux is not running');
    };
    await expect(f.seam.interrupt()).rejects.toThrow('tmux is not running');
  });
});

test('decision 18: the seam offers deliver, queue (U3), interrupt, transcript and the send path’s pane look and composer acts only; no raw pane write exists', async () => {
  const f = await running();
  expect(Object.keys(f.seam).sort()).toEqual([
    'askedQuestion',
    'clearComposer',
    'deliver',
    'form',
    'heldAt',
    'interrupt',
    'observe',
    'queue',
    'stopActive',
    'submitComposer',
    'transcript',
    'transcriptBytes',
  ]);
  expect(Object.keys(f.seam.transcript).sort()).toEqual(['find', 'follow', 'read', 'readCovering']);
});

test('decision 18: a ferret that stopped since has no pane to act on', async () => {
  const f = await running();
  await f.service.stop(f.id, 'now');
  expect(await f.seam.deliver({ text: 'late' })).toEqual({ ok: false, error: { refused: 'no_pane' } });
  expect(f.runner.deliveries).toEqual([]);
});

test('decision 18: the transcript is read through the ferret’s harness', async () => {
  const f = await running();
  const entry = { id: 'e1', at: '2026-11-07T00:00:00.000Z' as never, role: 'assistant' as const, text: 'hi' };
  (f.harness as { transcript: unknown }).transcript = {
    read: async () => [entry],
    follow: async function* () {},
    find: async () => entry,
  };
  expect(await f.seam.transcript.read()).toEqual([entry]);
  expect(await f.seam.transcript.find('e1')).toEqual(entry);
});

test('decision 18: a ferret’s own seam reads only ITS OWN transcript, never another ferret’s', async () => {
  const f = additivesFixture();
  const stranger = ferretId('stranger');
  f.registry.put({ ...f.registry.get(f.id)!, id: stranger, name: 'stranger' });
  const asked: string[] = [];
  (f.harness as { transcript: unknown }).transcript = {
    read: async (ferret: string) => {
      asked.push(ferret);
      return [
        {
          id: ferret,
          at: '2026-11-07T00:00:00.000Z' as never,
          role: 'assistant' as const,
          text: `secret of ${ferret}`,
        },
      ];
    },
    follow: async function* (ferret: string) {
      asked.push(ferret);
      // A ferret with nothing to follow: the stream ends at once.
      yield* [];
    },
    find: async (ferret: string) => {
      asked.push(ferret);
      return undefined;
    },
  };
  // The direct way is refused: a ferret opening a stranger's seam.
  await expect(f.service.harness(stranger, f.id)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  const own = (await f.service.harness(f.id, f.id))!;
  // The reader has no ferret argument. A stranger's id passed anyway lands in `after`, and the harness reader is still
  // asked about the seam's own ferret only.
  const read = own.transcript.read as unknown as (...args: unknown[]) => Promise<{ text: string }[]>;
  const entries = await read(stranger);
  expect(entries.map(entry => entry.text)).toEqual([`secret of ${f.id}`]);
  await own.transcript.find('e1');
  for await (const _entry of own.transcript.follow(new AbortController().signal)) void _entry;
  expect(asked).toEqual([f.id, f.id, f.id]);
  expect(asked).not.toContain(stranger);
  expect(own.transcript.read.length).toBeLessThanOrEqual(2);
});

test('decision 18: a ferret caller reaches its own and its helpers’ harness, nobody else’s', async () => {
  const f = additivesFixture();
  const lead = ferretId('lead');
  const helper = ferretId('helper');
  const other = ferretId('other');
  const base = f.registry.get(f.id)!;
  f.registry.put({ ...base, id: lead, name: 'lead' });
  f.registry.put({ ...base, id: helper, name: 'helper', parent: lead, role: 'helper' });
  f.registry.put({ ...base, id: other, name: 'other' });
  expect(await f.service.harness(lead, lead)).toBeDefined();
  expect(await f.service.harness(helper, lead)).toBeDefined();
  await expect(f.service.harness(other, lead)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  await expect(f.service.harness(lead, helper)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  // The owner (no caller) reaches any; an unknown ferret has none.
  expect(await f.service.harness(other)).toBeDefined();
  expect(await f.service.harness(ferretId('nobody'), lead)).toBeUndefined();
});

describe('U4: Ferrets’ own delivery wakes the turn watch', () => {
  test('a delivery that landed, and only that one, tells the watch the pane was typed into', async () => {
    const held = new Set<string>();
    const f = await running({ queueing: { held } });
    const told: string[] = [];
    f.ports.delivered = ferret => void told.push(ferret);

    await f.seam.deliver({ text: 'hello there' });
    held.add(f.handle);
    await f.seam.deliver({ text: 'refused words' });

    expect(told).toEqual([f.id]);
  });

  test('BG-040 a queue that landed, and only that one, tells the watch the pane was typed into', async () => {
    const f = await running();
    const told: string[] = [];
    f.ports.delivered = ferret => void told.push(ferret);

    expect((await f.seam.queue('queued words')).ok).toBe(true);
    f.runner.fail = { kind: 'composer_occupied', draft: 'mine' };
    expect((await f.seam.queue('refused words')).ok).toBe(false);

    expect(told).toEqual([f.id]);
  });
});

describe('send path: the seam reaches the pane look and the composer acts through the runner', () => {
  test('send path observe reads the pane once through the runner and writes nothing', async () => {
    const f = await running();
    f.runner.pane = { alive: true, dead: false, promptReady: false, activeWork: false, draft: 'half' };
    expect(await f.seam.observe!()).toEqual({ ok: true, value: f.runner.pane });
    expect(f.runner.pressed).toEqual([]);
    expect(f.runner.deliveries).toEqual([]);
  });

  test('send path observe says no_pane for a pane the runner cannot read, and plugin_unavailable for a runner that cannot observe', async () => {
    const gone = await running();
    gone.runner.reboot();
    expect(await gone.seam.observe!()).toEqual({ ok: false, error: { refused: 'no_pane' } });
    const bare = await running();
    (bare.runner as { observe?: unknown }).observe = undefined;
    expect(await bare.seam.observe!()).toEqual({ ok: false, error: { refused: 'plugin_unavailable' } });
  });

  test('send path heldAt answers where the pane holds a message, and REJECTS (never "not held") when it cannot read', async () => {
    const f = await running();
    f.runner.held = 'queue';
    expect(await f.seam.heldAt!('x')).toEqual({ ok: true, value: 'queue' });
    f.runner.held = 'throw';
    await expect(f.seam.heldAt!('x')).rejects.toThrow();
    (f.runner as { heldAt?: unknown }).heldAt = undefined;
    expect(await f.seam.heldAt!('x')).toEqual({ ok: false, error: { refused: 'plugin_unavailable' } });
  });

  test('send path clearComposer and submitComposer answer the runner’s outcome, and its closed failures as refusals typed nothing', async () => {
    const f = await running();
    f.runner.clearOutcome = 'foreign';
    expect(await f.seam.clearComposer!('x')).toEqual({ ok: true, value: 'foreign' });
    expect(await f.seam.submitComposer!('x', true)).toEqual({ ok: true, value: 'submitted' });
    expect(f.runner.submitted).toEqual([{ handle: f.handle, text: 'x', strict: true }]);
    f.runner.fail = { kind: 'held', code: 'input_pending' };
    expect(await f.seam.submitComposer!('x')).toEqual({ ok: false, error: { refused: 'input_pending' } });
    f.runner.fail = { kind: 'not_ready', why: 'exited' };
    expect(await f.seam.clearComposer!('x')).toEqual({ ok: false, error: { refused: 'not_ready', why: 'exited' } });
    (f.runner as { clearComposer?: unknown }).clearComposer = undefined;
    (f.runner as { submitComposer?: unknown }).submitComposer = undefined;
    expect(await f.seam.clearComposer!('x')).toEqual({ ok: false, error: { refused: 'plugin_unavailable' } });
    expect(await f.seam.submitComposer!('x')).toEqual({ ok: false, error: { refused: 'plugin_unavailable' } });
  });

  test('send path stopActive presses only the harness’s stop under shouldPressStopKey and answers the pane read', async () => {
    const working = await running();
    working.runner.working = true;
    expect((await working.seam.stopActive!()).ok).toBe(true);
    expect(working.runner.stoppedActive).toEqual([
      { handle: working.handle, stop: { key: 'Escape', whenIdle: false } },
    ]);
    expect(working.runner.pressed).toEqual([{ handle: working.handle, key: 'Escape' }]);
    expect(working.runner.signals).toEqual([]);
  });

  test('send path stopActive NEVER presses an idle pane, interactive Claude (whose key is harmless idle) included', async () => {
    // The interrupt may press an idle interactive Claude pane (the person's own Stop); a send-now's stop may not: an
    // idle pane may be parked on a permission prompt or a question, and Escape would answer it.
    const claude = await running({}, 'interactive');
    claude.harness.turnStop = { key: 'Escape', safeWhenIdle: true };
    claude.runner.working = false;
    expect((await claude.seam.stopActive!()).ok).toBe(true);
    expect(claude.runner.stoppedActive[0]?.stop).toEqual({ key: 'Escape', whenIdle: false });
    expect(claude.runner.pressed).toEqual([]);
    const codex = await running({}, 'interactive');
    codex.harness.turnStop = { key: 'Escape', safeWhenIdle: false };
    codex.runner.working = false;
    await codex.seam.stopActive!();
    expect(codex.runner.stoppedActive[0]?.stop).toEqual({ key: 'Escape', whenIdle: false });
    expect(codex.runner.pressed).toEqual([]);
  });

  test('send path stopActive refuses without a harness stop or a runner stop, and answers a hold or a gone pane as refusals', async () => {
    const none = await running();
    none.harness.turnStop = undefined;
    expect(await none.seam.stopActive!()).toEqual({ ok: false, error: { refused: 'plugin_unavailable' } });
    const held = await running();
    held.runner.fail = { kind: 'held', code: 'quarantined' };
    expect(await held.seam.stopActive!()).toEqual({ ok: false, error: { refused: 'quarantined' } });
    const gone = await running();
    gone.runner.fail = { kind: 'not_ready', why: 'exited' };
    expect(await gone.seam.stopActive!()).toEqual({ ok: false, error: { refused: 'no_pane' } });
    const odd = await running();
    odd.runner.fail = { kind: 'not_ready', why: 'busy' };
    await expect(odd.seam.stopActive!()).rejects.toThrow();
  });
});

describe('structured questions: the form seam and the asked-question file', () => {
  test('form.capture answers the runner’s masked capture, no_pane for a pane it cannot read, plugin_unavailable for a runner without it', async () => {
    const f = await running();
    f.runner.form = {
      alive: true,
      dead: false,
      promptReady: false,
      activeWork: false,
      visible: 'Pick one',
      history: '',
    };
    expect(await f.seam.form!.capture()).toEqual({ ok: true, value: f.runner.form });
    f.runner.form = undefined;
    expect(await f.seam.form!.capture()).toEqual({ ok: false, error: { refused: 'no_pane' } });
    (f.runner as { formCapture?: unknown }).formCapture = undefined;
    expect(await f.seam.form!.capture()).toEqual({ ok: false, error: { refused: 'plugin_unavailable' } });
  });

  test('form.key and form.paste reach the runner’s own guarded writes, and answer its closed failures as refusals typed nothing', async () => {
    const f = await running();
    expect(await f.seam.form!.key('Down')).toEqual({ ok: true, value: undefined });
    expect(await f.seam.form!.paste('free text')).toEqual({ ok: true, value: undefined });
    expect(f.runner.formKeys).toEqual([{ handle: f.handle, key: 'Down' }]);
    expect(f.runner.formPastes).toEqual([{ handle: f.handle, text: 'free text' }]);
    f.runner.fail = { kind: 'held', code: 'input_pending' };
    expect(await f.seam.form!.key('Enter')).toEqual({ ok: false, error: { refused: 'input_pending' } });
    f.runner.fail = { kind: 'held', code: 'input_pending' };
    expect(await f.seam.form!.paste('x')).toEqual({ ok: false, error: { refused: 'input_pending' } });
    expect(f.runner.formKeys).toHaveLength(1);
    f.runner.fail = { kind: 'not_ready', why: 'exited' };
    expect(await f.seam.form!.key('Enter')).toEqual({ ok: false, error: { refused: 'not_ready', why: 'exited' } });
    (f.runner as { formKey?: unknown }).formKey = undefined;
    (f.runner as { formPaste?: unknown }).formPaste = undefined;
    expect(await f.seam.form!.key('Enter')).toEqual({ ok: false, error: { refused: 'plugin_unavailable' } });
    expect(await f.seam.form!.paste('x')).toEqual({ ok: false, error: { refused: 'plugin_unavailable' } });
  });

  test('a ferret that stopped since has no pane for the form', async () => {
    const f = await running();
    await f.service.stop(f.id, 'now');
    expect(await f.seam.form!.key('Enter')).toEqual({ ok: false, error: { refused: 'no_pane' } });
    expect(await f.seam.form!.paste('x')).toEqual({ ok: false, error: { refused: 'no_pane' } });
    expect(await f.seam.form!.capture()).toEqual({ ok: false, error: { refused: 'no_pane' } });
    expect(f.runner.formKeys).toEqual([]);
  });

  test('askedQuestion reads the session file with the harness’s proved transcript, and nothing when either is missing', async () => {
    const written = '2026-11-11T05:00:00.000Z' as never;
    const f = await running({
      session: {
        prepare: async () => {},
        stamp: async () => {},
        carry: async () => {},
        askedQuestion: async () => ({ payload: '{"hook_event_name":"PreToolUse"}', writtenAt: written }),
      },
    });
    f.harness.transcripts.set(f.id, { stamp: { file: '/t/fern.jsonl', size: 1, mtimeMs: 2 }, records: [] });
    expect(await f.seam.askedQuestion!()).toEqual({
      payload: '{"hook_event_name":"PreToolUse"}',
      writtenAt: written,
      transcript: '/t/fern.jsonl',
    });
    f.harness.transcripts.delete(f.id);
    expect(await f.seam.askedQuestion!()).toEqual({ payload: '{"hook_event_name":"PreToolUse"}', writtenAt: written });
    const bare = await running();
    expect(await bare.seam.askedQuestion!()).toBeUndefined();
  });
});
