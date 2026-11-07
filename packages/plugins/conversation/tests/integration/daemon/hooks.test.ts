import { describe, expect, test } from 'bun:test';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import type { HookInvoker } from '@ferretry/kernel/manifest';
import daemon from '../../../daemon/index.ts';
import { StateDraftRepository } from '../../../daemon/drafts/adapters/index.ts';
import { KeyedSerialExecutor } from '../../../daemon/seams/keyed-serial-executor.ts';
import { buildConversationA } from '../../../daemon/host.ts';
import { TurnBoundaries } from '../../../daemon/turns/lib/index.ts';

const summary = (state: string) => ({ id: 'f1', state });

/** The same half, with the hooks it invokes replaced by recorders. */
function recording(options: { rewrite?: (text: string) => string; refuse?: string } = {}) {
  const seen: { hook: string; value: unknown }[] = [];
  const hooks = {
    observe: (hook: { name: string }, value: unknown) => void seen.push({ hook: hook.name, value }),
    transform: async (hook: { name: string }, value: { text: string }) => {
      seen.push({ hook: hook.name, value });
      if (options.refuse !== undefined) return { ok: false as const, error: options.refuse };
      return { ok: true as const, value: { ...value, text: options.rewrite?.(value.text) ?? value.text } };
    },
  } as unknown as HookInvoker;
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => daemon.build!({ ...ctx, hooks }),
  } as typeof daemon;
  return { seen, implementation };
}

const send = (host: Awaited<ReturnType<typeof testHost>>) =>
  host.request('POST', '/v1/ferrets/f1/send', {
    as: owner(),
    headers: { 'x-fy-request-id': 'req-1' },
    body: { message: 'hello' },
  });

describe('message.before-send', () => {
  test('runs on the text of every send before the terminal is asked to type it', async () => {
    const { seen, implementation } = recording({ rewrite: text => `${text}!` });
    const host = await testHost({
      plugins: [implementation],
      fakes: {
        ferrets: { get: async () => summary('idle'), list: async () => [] },
        asks: { get: async () => undefined },
      },
      clock: fixedClock('2026-11-06T09:00:00Z'),
    });
    const response = await send(host);
    expect(seen.find(entry => entry.hook === 'message.before-send')?.value).toEqual({ ferret: 'f1', text: 'hello' });
    expect(response.status).toBe(503);
  });

  test('a taker that refuses stops the send with its own sentence', async () => {
    const { implementation } = recording({ refuse: 'too long for the harness' });
    const host = await testHost({
      plugins: [implementation],
      fakes: {
        ferrets: { get: async () => summary('idle'), list: async () => [] },
        asks: { get: async () => undefined },
      },
      clock: fixedClock('2026-11-06T09:00:00Z'),
    });
    const response = await send(host);
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.json())).toContain('too long for the harness');
  });
});

describe('turn.ended', () => {
  test('is observed once when a working ferret goes idle, named by when its round began', async () => {
    let state = 'working';
    const { seen, implementation } = recording();
    const host = await testHost({
      plugins: [implementation],
      fakes: {
        ferrets: { get: async () => summary(state), list: async () => [summary(state)] },
        asks: { get: async () => undefined },
      },
      clock: fixedClock('2026-11-06T09:00:00Z'),
    });
    await host.clock.advance(2_000);
    await host.settle();
    expect(seen.filter(entry => entry.hook === 'turn.ended')).toHaveLength(0);
    state = 'idle';
    await host.clock.advance(2_000);
    await host.settle();
    const ended = seen.filter(entry => entry.hook === 'turn.ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.value).toMatchObject({ ferret: 'f1', outcome: 'completed' });
    await host.clock.advance(4_000);
    await host.settle();
    expect(seen.filter(entry => entry.hook === 'turn.ended')).toHaveLength(1);
  });
});

describe('an answered ask', () => {
  const snapshot = (slot?: string) => ({
    v: 1,
    ferret: 'f1',
    ...(slot === undefined ? {} : { slot }),
    generation: 'g1',
    epoch: 1,
    rev: 3,
    text: 'half a reply',
    items: [],
    updatedAt: '2026-11-06T09:00:00.000Z',
  });

  /** The kernel as far as part a touches it, with a state port that keeps opaque files as the bytes they are. */
  function world() {
    const files = new Map<string, Uint8Array>();
    const key = (file: { path: string }, name?: string) => file.path.replace('*', name ?? '');
    const state = {
      read: async (file: { path: string }, name?: string) => ({ ok: true, value: files.get(key(file, name)) }),
      write: async (file: { path: string }, value: Uint8Array, name?: string) => void files.set(key(file, name), value),
    };
    const clock = {
      now: () => '2026-11-06T09:00:00.000Z',
      nowMs: () => 0,
      every: () => () => undefined,
      after: () => () => undefined,
    };
    const kernel = { state, clock, events: { publish: async () => undefined }, ids: { mint: () => 'id' } } as never;
    return { state: state as never, kernel };
  }
  const build = (kernel: never, asks: { get(id: string): Promise<unknown> }) =>
    buildConversationA({
      kernel,
      ferrets: { get: async () => summary('idle'), list: async () => [] } as never,
      asks: asks as never,
      hooks: {
        observe: () => undefined,
        transform: async (_hook: unknown, value: unknown) => ({ ok: true, value }),
      } as never,
    });

  test('takes the draft of its item with it, and leaves the chat draft and other items alone', async () => {
    const { state, kernel } = world();
    const repository = new StateDraftRepository(state, new KeyedSerialExecutor());
    for (const slot of [undefined, 'A7', 'A8']) await repository.save(snapshot(slot) as never);
    const half = build(kernel, { get: async (id: string) => ({ id, state: 'answered', ferret: 'f1' }) });
    await half.onAskAnswered('A7');
    expect(await repository.items('f1' as never)).toEqual(['A8']);
    expect(await repository.load('f1')).toBeDefined();
    half.stop();
  });

  test('an ask nobody can place does nothing', async () => {
    const { state, kernel } = world();
    const repository = new StateDraftRepository(state, new KeyedSerialExecutor());
    await repository.save(snapshot('A7') as never);
    const half = build(kernel, { get: async () => undefined });
    await half.onAskAnswered('A7');
    expect(await repository.items('f1' as never)).toEqual(['A7']);
    half.stop();
  });

  test('an open item has a reply box and a closed one has none', async () => {
    const { kernel } = world();
    const open = build(kernel, { get: async (id: string) => ({ id, state: 'open', ferret: 'f1' }) });
    const closed = build(kernel, { get: async (id: string) => ({ id, state: 'closed', ferret: 'f1' }) });
    expect((await open.api.draft('f1' as never, 'A7' as never)).rev).toBe(0);
    await closed.api.draft('f1' as never, 'A7' as never).then(
      () => expect.unreachable('a closed item has no draft'),
      error => expect(String(error)).toBeDefined(),
    );
    open.stop();
    closed.stop();
  });
});

describe('TurnBoundaries', () => {
  const run = () => {
    const ended: unknown[] = [];
    return { ended, bounds: new TurnBoundaries(boundary => ended.push(boundary)) };
  };

  test('a working round that settles idle completed; stopped failed; interrupted says so', () => {
    const { ended, bounds } = run();
    bounds.look('a', 'working', 't1');
    bounds.look('a', 'idle', 't2');
    bounds.look('b', 'working', 't1');
    bounds.look('b', 'stopped', 't3');
    bounds.look('c', 'working', 't1');
    bounds.markInterrupted('c');
    bounds.look('c', 'idle', 't4');
    expect(ended).toEqual([
      { ferret: 'a', turn: 't1', outcome: 'completed', endedAt: 't2' },
      { ferret: 'b', turn: 't1', outcome: 'failed', endedAt: 't3' },
      { ferret: 'c', turn: 't1', outcome: 'interrupted', endedAt: 't4' },
    ]);
  });

  test('looking again at the same round says nothing more, and an interrupt of an idle ferret lapses', () => {
    const { ended, bounds } = run();
    bounds.look('a', 'working', 't1');
    bounds.look('a', 'working', 't2');
    expect(bounds.current('a')).toBe('t1');
    bounds.look('a', 'idle', 't3');
    bounds.look('a', 'idle', 't4');
    bounds.markInterrupted('a');
    bounds.look('a', 'idle', 't5');
    bounds.look('a', 'working', 't6');
    bounds.look('a', 'idle', 't7');
    expect(ended).toHaveLength(2);
    expect(ended[1]).toMatchObject({ outcome: 'completed' });
    expect(bounds.current('a')).toBeUndefined();
  });
});
