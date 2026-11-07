import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineHook } from '../../../contract/define.ts';
import { type Deadline, HookEngine } from '../../../host/hooks.ts';
import type { Manifest } from '../../../manifest/types.ts';
import { silentLog } from './fixtures.ts';

const Decide = defineHook('t.decide', { mode: 'decide', timeoutMs: 50 });
const SecurityDecide = defineHook('t.security', { mode: 'decide', securityPath: true });
const Transform = defineHook('t.transform', { mode: 'transform', value: z.string() });
const Provide = defineHook('t.provide', { mode: 'provide', key: z.enum(['a', 'b']), takers: ['p1', 'p2'] });
const Contribute = defineHook('t.contribute', { mode: 'contribute' });
const Observe = defineHook('t.observe', { mode: 'observe' });

const plugin = (id: string, hooks: Manifest['hooks'], extra: Partial<Manifest> = {}): Manifest => ({
  id,
  title: id,
  version: '1.0.0',
  api: 5,
  core: id === 'gate',
  kinds: [],
  hooks,
  ...extra,
});

/** A deadline the test fires by hand. */
const manualDeadline = (): Deadline & { fire(): void } => {
  const pending: (() => void)[] = [];
  const deadline = ((_ms: number) => {
    let resolve = (_value: 'timeout'): void => {};
    const promise = new Promise<'timeout'>(r => {
      resolve = r;
    });
    pending.push(() => resolve('timeout'));
    return { promise, cancel: () => {} };
  }) as Deadline & { fire(): void };
  deadline.fire = () => {
    for (const fire of pending.splice(0)) fire();
  };
  return deadline;
};

const offerer = plugin('gate', {
  offers: [
    { hook: Decide },
    { hook: SecurityDecide },
    { hook: Transform },
    { hook: Provide },
    { hook: Contribute },
    { hook: Observe },
  ],
});

describe('the hooks engine (§3.5)', () => {
  test('decide: priority high first, the first no wins with its reason', async () => {
    const low = plugin('p1', { takes: [{ hook: Decide, priority: 10 }] });
    const high = plugin('p2', { takes: [{ hook: Decide, priority: 90 }] });
    const { engine, refusals } = HookEngine.plan([offerer, low, high], silentLog, manualDeadline());
    expect(refusals).toEqual([]);
    const order: string[] = [];
    engine.attach('p1', { 't.decide': () => (order.push('p1'), { allow: false, reason: 'p1 says no' }) }, 'live');
    engine.attach('p2', { 't.decide': () => (order.push('p2'), { allow: true }) }, 'live');
    expect(await engine.invokerFor('gate').decide(Decide, undefined)).toEqual({ allow: false, reason: 'p1 says no' });
    expect(order).toEqual(['p2', 'p1']);
  });

  test('decide: a throw is a no, a timeout is a no, a failed taker is a no', async () => {
    const deadline = manualDeadline();
    const taker = plugin('p1', { takes: [{ hook: Decide }] });
    const { engine } = HookEngine.plan([offerer, taker], silentLog, deadline);
    engine.attach(
      'p1',
      {
        't.decide': () => {
          throw new Error('x');
        },
      },
      'live',
    );
    expect((await engine.decide(Decide, undefined)).allow).toBe(false);
    engine.attach('p1', { 't.decide': () => new Promise(() => {}) }, 'live');
    const waiting = engine.decide(Decide, undefined);
    await Promise.resolve();
    deadline.fire();
    expect(await waiting).toEqual({ allow: false, reason: 'p1 did not answer in time.' });
    engine.markFailed('p1');
    expect((await engine.decide(Decide, undefined)).allow).toBe(false);
  });

  test('decide: a skeleton taker is a no-op', async () => {
    const taker = plugin('p1', { takes: [{ hook: Decide }] });
    const { engine } = HookEngine.plan([offerer, taker], silentLog, manualDeadline());
    engine.attach('p1', undefined, 'skeleton');
    expect(await engine.decide(Decide, undefined)).toEqual({ allow: true });
  });

  test('only core offers or takes a security-path decide hook', () => {
    const rogue = plugin('p1', { takes: [{ hook: SecurityDecide }] });
    const { refusals } = HookEngine.plan([offerer, rogue], silentLog, manualDeadline());
    expect(refusals.map(refusal => refusal.plugins)).toEqual([['p1']]);
  });

  test('transform: each sees the previous output; a failing taker refuses the whole operation', async () => {
    const a = plugin('p1', { takes: [{ hook: Transform, priority: 90 }] });
    const b = plugin('p2', { takes: [{ hook: Transform, priority: 10 }] });
    const { engine } = HookEngine.plan([offerer, a, b], silentLog, manualDeadline());
    engine.attach('p1', { 't.transform': (value: string) => `${value}+a` }, 'live');
    engine.attach('p2', { 't.transform': (value: string) => `${value}+b` }, 'live');
    expect(await engine.transform(Transform, 'x')).toEqual({ ok: true, value: 'x+a+b' });
    engine.attach('p2', { 't.transform': () => 42 }, 'live');
    expect((await engine.transform(Transform, 'x')).ok).toBe(false);
  });

  test('provide: two takers of one key refuse the build naming both', () => {
    const a = plugin('p1', { takes: [{ hook: Provide, key: 'a' }] });
    const b = plugin('p2', { takes: [{ hook: Provide, key: 'a' }] });
    const { refusals } = HookEngine.plan([offerer, a, b], silentLog, manualDeadline());
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.plugins).toEqual(['p1', 'p2']);
  });

  test('provide: a security-path hook refuses a taker not on its list', () => {
    const rogue = plugin('p3', { takes: [{ hook: Provide, key: 'b' }] });
    const { refusals } = HookEngine.plan([offerer, rogue], silentLog, manualDeadline());
    expect(refusals[0]?.sentence).toContain('only p1, p2 may');
  });

  test('provide: a skeleton or failed taker makes its key unavailable', () => {
    const a = plugin('p1', { takes: [{ hook: Provide, key: 'a' }] });
    const { engine } = HookEngine.plan([offerer, a], silentLog, manualDeadline());
    engine.attach('p1', undefined, 'skeleton');
    expect(engine.provider(Provide, 'a')).toBe('unavailable');
    engine.attach('p1', { 't.provide:a': { value: 1 } }, 'live');
    expect(engine.provider(Provide, 'a')).toEqual({ value: 1 });
    const cached = engine.provider(Provide, 'a');
    engine.markFailed('p1');
    expect(engine.provider(Provide, 'a')).toBe('unavailable');
    if (cached === 'unavailable') throw new Error('fixture provider');
    expect(() => (cached as { value: number }).value).toThrow('not running');
  });

  test('contribute: by order then id; a duplicate id and a failing taker are left out and noted', () => {
    const a = plugin('p1', { takes: [{ hook: Contribute }] });
    const b = plugin('p2', { takes: [{ hook: Contribute }] });
    const c = plugin('p3', { takes: [{ hook: Contribute }] });
    const { engine } = HookEngine.plan([offerer, a, b, c], silentLog, manualDeadline());
    engine.attach(
      'p1',
      {
        't.contribute': () => [
          { id: 'z', order: 1, item: 1 },
          { id: 'a', order: 2, item: 2 },
        ],
      },
      'live',
    );
    engine.attach('p2', { 't.contribute': () => [{ id: 'z', order: 0, item: 3 }] }, 'live');
    engine.attach(
      'p3',
      {
        't.contribute': () => {
          throw new Error('x');
        },
      },
      'live',
    );
    expect(engine.contributions(Contribute).map(item => item.id)).toEqual(['z', 'a']);
    expect(engine.notes).toHaveLength(2);
  });

  test('a plugin may invoke only hooks it offers', () => {
    const { engine } = HookEngine.plan([offerer, plugin('p1', {})], silentLog, manualDeadline());
    expect(() => engine.invokerFor('p1').observe(Observe, undefined)).toThrow('did not declare');
  });

  test('observe: a failing taker does not reach the offerer', async () => {
    const a = plugin('p1', { takes: [{ hook: Observe }] });
    const { engine } = HookEngine.plan([offerer, a], silentLog, manualDeadline());
    let heard = 0;
    engine.attach(
      'p1',
      {
        't.observe': () => {
          heard += 1;
          throw new Error('x');
        },
      },
      'live',
    );
    expect(() => engine.observe(Observe, undefined)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(heard).toBe(1);
  });
});
