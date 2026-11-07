import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { FerretChangedPayload } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { HookInvoker } from '@ferretry/kernel/manifest';
import type { WorkerHandle } from '@ferretry/kernel/contract';
import { fixedClock, testHost } from '@ferretry/kernel/testing';
import { CONVERSATION_STATE, type ConversationApi, ConversationPort } from '../../../contract/index.ts';
import { memoryStatePort } from '../../support/state.ts';
import daemon from '../../../daemon/index.ts';
import { followFerretChanges, followFerretStopping } from '../../../daemon/ferret-changes.ts';

const F1 = ferretId('f1');
const change = (state: FerretChangedPayload['state'], what: FerretChangedPayload['change']): FerretChangedPayload => ({
  ferret: F1,
  state,
  change: what,
});

describe('followFerretChanges', () => {
  const record = (failRelease = false) => {
    const calls: string[] = [];
    const follow = followFerretChanges({
      release: ferret => {
        calls.push(`release ${ferret}`);
        if (failRelease) throw new Error('release failed');
      },
      look: (ferret, phase) => calls.push(`look ${ferret} ${phase}`),
      forget: ferret => calls.push(`forget ${ferret}`),
      withdrawQuestion: ferret => calls.push(`withdraw ${ferret}`),
      warn: message => calls.push(`warn ${message}`),
    });
    return { calls, follow };
  };

  test('a ferret that stopped has its attachments released first, its question withdrawn, then the stop is a turn look', () => {
    const { calls, follow } = record();
    follow(change('stopped', 'stopped'));
    expect(calls).toEqual(['release f1', 'withdraw f1', 'look f1 stopped']);
  });

  test('a removed ferret is released and forgotten; any change that lands in stopped is released too', () => {
    const { calls, follow } = record();
    follow(change('stopped', 'removed'));
    follow(change('stopped', 'state'));
    expect(calls).toEqual(['release f1', 'withdraw f1', 'forget f1', 'release f1', 'withdraw f1', 'look f1 stopped']);
  });

  test('a change of phase while running releases nothing and is one look', () => {
    const { calls, follow } = record();
    follow(change('working', 'state'));
    follow(change('idle', 'state'));
    expect(calls).toEqual(['look f1 working', 'look f1 idle']);
  });

  test('a release that throws still lets the turn be followed, and the failure is not swallowed', () => {
    const { calls, follow } = record(true);
    expect(() => follow(change('stopped', 'stopped'))).toThrow('release failed');
    expect(calls).toEqual(['release f1', 'withdraw f1', 'look f1 stopped']);
  });
});

/** A PDF worker that unlocks any password and hands back this plaintext. */
const PLAINTEXT = new TextEncoder().encode('%PDF-1.7\nthe unlocked words\n');
const unlockingWorker = (): WorkerHandle => {
  let listener: ((message: unknown) => void) | undefined;
  return {
    post: () => {
      const output = PLAINTEXT.slice().buffer;
      queueMicrotask(() => listener?.({ ok: true, output }));
    },
    onMessage: next => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    onExit: () => () => undefined,
    terminate: async () => undefined,
  };
};

/** The real daemon half on the test host, its PDF worker faked and its `ferret.changed` taker in the test's hand. */
async function conversation() {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: F1, state: 'working' });
  const observed: { hook: string; payload: unknown }[] = [];
  const built: { half?: ReturnType<NonNullable<typeof daemon.build>> } = {};
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const hooks: HookInvoker = {
        ...ctx.hooks,
        observe: (hook, payload) => void observed.push({ hook: hook.name, payload }),
      };
      const kernel = { ...ctx.kernel, state: memoryStatePort(CONVERSATION_STATE), workers: { start: unlockingWorker } };
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      built.half = build({ ...ctx, kernel, hooks });
      return built.half;
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [implementation],
    fakes: { ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-11-07T09:00:00Z'),
  });
  const changed = (payload: FerretChangedPayload) => built.half?.hooks['ferret.changed'](payload);
  const stopping = (ferret: typeof F1) => built.half?.hooks['ferret.stopping']({ ferret });
  return { host, changed, stopping, observed };
}

/** An encrypted PDF on F1, unlocked: its plaintext is held in memory. */
async function unlockedPdf(api: ConversationApi) {
  const encrypted = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >>\n');
  const added = await api.addAttachment(F1, {
    filename: 'locked.pdf',
    mime: 'application/pdf',
    base64: Buffer.from(encrypted).toString('base64'),
  });
  if (!added.ok) throw new Error(added.error.message);
  const unlocked = await api.unlockAttachment(F1, added.value.id, 'pw');
  if (!unlocked.ok) throw new Error(unlocked.error.message);
  expect(unlocked.value.encrypted?.locked).toBe(false);
  return added.value.id;
}

describe('Conversation takes ferret.stopping', () => {
  test('followFerretStopping releases at once and does not swallow a failing release', () => {
    const calls: string[] = [];
    followFerretStopping({ release: ferret => calls.push(`release ${ferret}`) })({ ferret: F1 });
    expect(calls).toEqual(['release f1']);
    expect(() =>
      followFerretStopping({
        release: () => {
          throw new Error('release failed');
        },
      })({ ferret: F1 }),
    ).toThrow('release failed');
  });

  test('a stop that is attempted zeroes the unlocked PDF plaintext even when the stop then fails', async () => {
    const { host, stopping } = await conversation();
    const api = host.provided(ConversationPort);
    const id = await unlockedPdf(api);

    // Ferrets says ferret.stopping before the harness stop; this stop then fails, so no ferret.changed follows.
    stopping(F1);

    const after = await api.attachment(F1, id);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.attachment.encrypted?.locked).toBe(true);
    expect(Buffer.from(after.value.base64, 'base64').equals(Buffer.from(PLAINTEXT))).toBe(false);
    await host.stop();
  });
});

describe('Conversation takes ferret.changed', () => {
  test('a ferret that stops has its unlocked PDF plaintext zeroed: the attachment is locked again', async () => {
    const { host, changed } = await conversation();
    const api = host.provided(ConversationPort);
    const encrypted = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >>\n');
    const added = await api.addAttachment(F1, {
      filename: 'locked.pdf',
      mime: 'application/pdf',
      base64: Buffer.from(encrypted).toString('base64'),
    });
    if (!added.ok) throw new Error(added.error.message);
    expect(added.value.encrypted?.locked).toBe(true);
    const unlocked = await api.unlockAttachment(F1, added.value.id, 'pw');
    if (!unlocked.ok) throw new Error(unlocked.error.message);
    expect(unlocked.value.encrypted?.locked).toBe(false);

    changed({ ferret: F1, state: 'stopped', previous: 'working', change: 'stopped' });

    const after = await api.attachment(F1, added.value.id);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.attachment.encrypted?.locked).toBe(true);
    expect(Buffer.from(after.value.base64, 'base64').equals(Buffer.from(PLAINTEXT))).toBe(false);
    await host.stop();
  });

  test('turn.ended follows every state change, so a round shorter than any poll still ends once', async () => {
    const { host, changed, observed } = await conversation();
    changed({ ferret: F1, state: 'working', previous: 'idle', change: 'state' });
    changed({ ferret: F1, state: 'idle', previous: 'working', change: 'state' });
    changed({ ferret: F1, state: 'idle', change: 'renamed' });
    const ended = observed.filter(entry => entry.hook === 'turn.ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload).toMatchObject({ ferret: 'f1', outcome: 'completed', turn: '2026-11-07T09:00:00.000Z' });
    changed({ ferret: F1, state: 'working', previous: 'idle', change: 'state' });
    changed({ ferret: F1, state: 'stopped', previous: 'working', change: 'stopped' });
    expect(observed.filter(entry => entry.hook === 'turn.ended').at(-1)?.payload).toMatchObject({ outcome: 'failed' });
    await host.stop();
  });
});
