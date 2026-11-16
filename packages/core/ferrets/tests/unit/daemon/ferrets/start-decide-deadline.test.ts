import { describe, expect, test } from 'bun:test';
import type { Log } from '@ferretry/kernel/contract';
import { HookEngine } from '@ferretry/kernel/host';
import { definePlugin } from '@ferretry/kernel/manifest';
import { AutoResumeDecide, StartDecide, type StartDecideInput } from '../../../../contract/index.ts';
import { DECIDE_ASK_TIMEOUT_MS } from '../../../../contract/hooks/decide-timeout.ts';
import manifest from '../../../../manifest.ts';

/**
 * A healthy Runtimes answer that is merely SLOW (a busy machine: the published manifest is read from disk under the
 * publication lock) must still be a yes. The kernel's decide default (200 ms) refused it with
 * `409 {"error":"runtimes did not answer in time."}` (full-ci Integration, PR 1685). Time here is virtual: the kernel's
 * deadline and the taker's own work run on one hand-wound clock, so no real wait and no flake.
 */

const silent: Log = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

/** One virtual clock: `after(ms)` timers fire in order as `advance` winds it, microtasks flushed between each. */
function virtualClock() {
  let now = 0;
  const timers: { at: number; fire: () => void; live: boolean }[] = [];
  const after = (ms: number, fire: () => void) => {
    const timer = { at: now + ms, fire, live: true };
    timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  return {
    after,
    deadline: (ms: number) => {
      let cancel = () => {};
      const promise = new Promise<'timeout'>(resolve => {
        cancel = after(ms, () => resolve('timeout'));
      });
      return { promise, cancel };
    },
    /** Wind the clock by `ms`, firing every due live timer in time order. */
    advance: async (ms: number) => {
      const target = now + ms;
      await flush();
      for (;;) {
        const due = timers.filter(timer => timer.live && timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.live = false;
        now = due.at;
        due.fire();
        await flush();
      }
      now = target;
    },
  };
}

const runtimes = definePlugin({
  id: 'runtimes',
  title: 'Runtimes',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  hooks: { takes: [{ hook: StartDecide }, { hook: AutoResumeDecide }] },
});

const start: StartDecideInput = {
  ferret: 'f1' as StartDecideInput['ferret'],
  name: 'worker',
  role: 'lead',
  harness: 'claude-code' as StartDecideInput['harness'],
  runtime: 'work',
  folder: '/work',
  by: 'owner',
};

/** An engine with the REAL Ferrets manifest as the offerer and a Runtimes taker whose answer takes `delayMs` of virtual time. */
function world(delayMs: number | 'never') {
  const clock = virtualClock();
  const { engine, refusals } = HookEngine.plan([manifest, runtimes], silent, clock.deadline);
  expect(refusals).toEqual([]);
  const slow = <T>(answer: T) =>
    delayMs === 'never'
      ? new Promise<T>(() => {})
      : new Promise<T>(resolve => {
          clock.after(delayMs, () => resolve(answer));
        });
  engine.attach(
    'runtimes',
    { 'start.decide': () => slow({ allow: true }), 'auto-resume.decide': () => slow({ allow: true }) },
    'live',
  );
  return { engine, clock };
}

describe('start.decide and auto-resume.decide wait for a slow taker', () => {
  test('a Runtimes answer that takes 1 s (5x the old 200 ms default) is still a yes', async () => {
    const { engine, clock } = world(1_000);
    const asked = engine.decide(StartDecide, start);
    await clock.advance(1_000);
    expect(await asked).toEqual({ allow: true });
  });

  test('the same slow answer is a yes for an automatic resume (a miss there skips the resume)', async () => {
    const { engine, clock } = world(1_000);
    const asked = engine.decide(AutoResumeDecide, { ask: 'switch' });
    await clock.advance(1_000);
    expect(await asked).toEqual({ allow: true });
  });

  test('a taker that never answers is still refused, by name, once the bound passes', async () => {
    const { engine, clock } = world('never');
    const asked = engine.decide(StartDecide, start);
    await clock.advance(DECIDE_ASK_TIMEOUT_MS - 1);
    let settled = false;
    void asked.then(() => {
      settled = true;
    });
    await clock.advance(0);
    expect(settled).toBe(false);
    await clock.advance(1);
    expect(await asked).toEqual({ allow: false, reason: 'runtimes did not answer in time.' });
  });

  test('the bound is generous for a file read and finite', () => {
    expect(DECIDE_ASK_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(DECIDE_ASK_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(StartDecide.timeoutMs).toBe(DECIDE_ASK_TIMEOUT_MS);
    expect(AutoResumeDecide.timeoutMs).toBe(DECIDE_ASK_TIMEOUT_MS);
  });
});
