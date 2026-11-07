import { describe, expect, test } from 'bun:test';
import { milliseconds } from '@ferretry/std';
import { JobRunner } from '../../../host/jobs.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { silentLog } from './fixtures.ts';

describe('job ownership across build and serving transitions', () => {
  test('discarded failed-build jobs and unavailable owners never start, including dependency waits and kicks', async () => {
    const clock = fixedClock();
    const healthy = new Set(['healthy']);
    const jobs = new JobRunner(clock, silentLog, plugin => healthy.has(plugin));
    const ran: string[] = [];
    for (const plugin of ['failed', 'damaged', 'dependent', 'healthy'])
      jobs.portFor(plugin).add({
        id: 'work',
        schedule: { onceAfterStart: true },
        ...(plugin === 'dependent' ? { after: ['failed/work'] } : {}),
        run: async () => {
          ran.push(plugin);
        },
      });
    await jobs.discard('failed');
    jobs.start();
    jobs.portFor('damaged').kick('work');
    await Promise.resolve();
    await clock.advance(0);
    await jobs.settle();
    expect(ran).toEqual(['healthy']);
    expect(jobs.reports().some(job => job.plugin === 'failed')).toBe(false);
    await jobs.stop();
    expect(clock.pending()).toBe(0);
  });

  test('damage aborts a running job and cancels its timers; repair starts it with a fresh signal', async () => {
    const clock = fixedClock();
    let serving = true;
    const jobs = new JobRunner(clock, silentLog, () => serving);
    const signals: AbortSignal[] = [];
    jobs.portFor('owner').add({
      id: 'work',
      schedule: { every: milliseconds(10) },
      run: signal => {
        signals.push(signal);
        return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    });
    jobs.start();
    await clock.advance(0);
    expect(signals).toHaveLength(1);
    serving = false;
    jobs.pause('owner');
    await jobs.settle();
    await clock.advance(100);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals).toHaveLength(1);
    expect(clock.pending()).toBe(0);
    serving = true;
    jobs.resume('owner');
    await clock.advance(0);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
    await jobs.stop();
    expect(signals[1]?.aborted).toBe(true);
    expect(clock.pending()).toBe(0);
  });

  test('repeated damage and repair during one slow run arms the job once, and stop cancels it', async () => {
    const clock = fixedClock();
    const jobs = new JobRunner(clock, silentLog);
    let ran = 0;
    let finishFirst: () => void = () => undefined;
    jobs.portFor('owner').add({
      id: 'work',
      schedule: { every: milliseconds(10) },
      run: async () => {
        ran++;
        // The first run ignores its abort signal, so both repairs below wait on it.
        if (ran === 1) await new Promise<void>(resolve => (finishFirst = resolve));
      },
    });
    jobs.start();
    await clock.advance(0);
    expect(ran).toBe(1);
    jobs.pause('owner');
    jobs.resume('owner');
    jobs.pause('owner');
    jobs.resume('owner');
    finishFirst();
    await jobs.settle();
    await clock.advance(0);
    expect(clock.pending()).toBe(1);
    const before = ran;
    await clock.advance(10);
    await jobs.settle();
    expect(ran - before).toBe(1);
    await jobs.stop();
    expect(clock.pending()).toBe(0);
  });

  test('damage cancels a failed job backoff as well as its interval', async () => {
    const clock = fixedClock();
    const jobs = new JobRunner(clock, silentLog);
    let ran = 0;
    jobs.portFor('owner').add({
      id: 'work',
      schedule: { every: milliseconds(10) },
      run: async () => {
        ran++;
        throw new Error('fixture');
      },
    });
    jobs.start();
    await clock.advance(0);
    await jobs.settle();
    jobs.pause('owner');
    await clock.advance(10000);
    expect(ran).toBe(1);
    expect(clock.pending()).toBe(0);
    await jobs.stop();
  });
});
