/** The worker job lane, at parity with today's BackgroundLane. */
import { describe, expect, test } from 'bun:test';
import { milliseconds } from '@ferretry/std';
import { DEFAULT_BACKGROUND_DELAY_MS, JobRunner, parseBackgroundDelay } from '../../../host/jobs.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { silentLog } from './fixtures.ts';

const flush = async (): Promise<void> => {
  for (let round = 0; round < 20; round += 1) await new Promise(resolve => setImmediate(resolve));
};

describe('the worker lane: housekeeping waits, then runs one job at a time', () => {
  test('nothing runs before the lane opens; then one at a time, the loop handed back between jobs', async () => {
    const clock = fixedClock();
    const yields: string[] = [];
    const order: string[] = [];
    let release: () => void = () => {};
    const runner = new JobRunner(clock, silentLog, {
      backgroundDelayMs: 120_000,
      yieldToLoop: async () => {
        yields.push(order.at(-1) ?? '');
      },
    });
    const port = runner.portFor('usage');
    port.add({
      id: 'ingest',
      lane: 'worker',
      schedule: { every: milliseconds(60_000) },
      run: async () => {
        order.push('ingest:start');
        await new Promise<void>(resolve => {
          release = resolve;
        });
        order.push('ingest:end');
      },
    });
    port.add({
      id: 'reap',
      lane: 'worker',
      schedule: { onceAfterStart: true },
      run: async () => {
        order.push('reap');
      },
    });
    runner.start();
    await flush();
    expect(order).toEqual([]);
    expect(runner.laneWaiting()).toEqual(['usage/ingest']);
    await clock.advance(119_000);
    expect(order).toEqual([]);
    expect(runner.laneWaiting()).toEqual(['usage/ingest', 'usage/reap']);
    await clock.advance(1_000);
    await flush();
    expect(order).toEqual(['ingest:start']); // reap waits its turn
    release();
    await flush();
    // the interval fired while ingest ran, so it goes again, behind reap
    expect(order.slice(0, 3)).toEqual(['ingest:start', 'ingest:end', 'reap']);
    expect(yields.length).toBeGreaterThanOrEqual(2);
    release();
    await runner.stop();
  });

  test('a fire while the job already waits queues no second copy', async () => {
    const clock = fixedClock();
    let runs = 0;
    const runner = new JobRunner(clock, silentLog, { backgroundDelayMs: 120_000 });
    const port = runner.portFor('fleet');
    port.add({
      id: 'refresh',
      lane: 'worker',
      schedule: { every: milliseconds(25_000) },
      run: async () => {
        runs += 1;
      },
    });
    runner.start();
    port.kick('refresh');
    port.kick('refresh');
    await clock.advance(50_000);
    expect(runner.laneWaiting()).toEqual(['fleet/refresh']);
    await clock.advance(70_000);
    await flush();
    expect(runs).toBe(1);
    await runner.stop();
  });

  test('FYD_BACKGROUND_DELAY_SECONDS: unset is two minutes, 0 opens at once, anything else throws', () => {
    expect(parseBackgroundDelay(undefined)).toBe(DEFAULT_BACKGROUND_DELAY_MS);
    expect(DEFAULT_BACKGROUND_DELAY_MS).toBe(120_000);
    expect(parseBackgroundDelay(' ')).toBe(120_000);
    expect(parseBackgroundDelay('0')).toBe(0);
    expect(parseBackgroundDelay('30')).toBe(30_000);
    expect(() => parseBackgroundDelay('2m')).toThrow(
      'FYD_BACKGROUND_DELAY_SECONDS must be a whole number of seconds: 2m',
    );
  });
});
