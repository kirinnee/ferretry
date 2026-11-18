/**
 * The SPEED half of `../../unit/host/loop-health.test.ts`: the real meter on a real timer hears a loop that is really
 * held. The unit tier proves the lateness, the stall and the labels on a clock moved by hand; here the claim is that
 * a 300 ms block of the real event loop arrives at an observer as a tick at least 250 ms late, and an idle loop is heard.
 */
import { expect, test } from 'bun:test';
import { createLoopMeter } from '../../../host/loop-health.ts';

test('a loop really blocked on a real timer is heard late, and an idle one is heard on time', async () => {
  const meter = createLoopMeter({ nowMs: () => performance.now(), intervalMs: 20, stallMs: 100 });
  const lags: number[] = [];
  meter.observe(lag => lags.push(lag));
  const timer = setInterval(() => meter.tick(), 20);
  try {
    await Bun.sleep(150);
    expect(lags.length).toBeGreaterThan(0);
    lags.length = 0;
    await Bun.sleep(0);
    // Hold the loop for 300 ms: the next tick is that late, however busy the machine.
    const until = performance.now() + 300;
    while (performance.now() < until);
    await Bun.sleep(60);
    expect(Math.max(...lags)).toBeGreaterThanOrEqual(250);
    expect(meter.view().stalls).toBeGreaterThanOrEqual(1);
  } finally {
    clearInterval(timer);
  }
});
