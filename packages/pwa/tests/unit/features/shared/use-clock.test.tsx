import { describe, expect, it } from 'bun:test';
import { secondTicker, type Ticker, useClock } from '../../../../src/features/shared/use-clock.ts';
import { interact, mount } from '../../../support/dom.ts';

function Probe({ now, ticker, running }: { now: () => Date; ticker: Ticker; running: boolean }) {
  return <output>{useClock(now, ticker, running).toISOString()}</output>;
}

describe('useClock', () => {
  it('reads the time again on each tick while running, and stops when it is not', async () => {
    let at = new Date('2026-10-31T10:00:00.000Z');
    const ticks: (() => void)[] = [];
    let stopped = 0;
    const ticker: Ticker = onTick => {
      ticks.push(onTick);
      return () => {
        stopped += 1;
      };
    };
    const now = () => at;
    const view = await mount(<Probe now={now} ticker={ticker} running />);
    const shown = () => view.container.querySelector('output')?.textContent;
    expect(shown()).toBe('2026-10-31T10:00:00.000Z');

    at = new Date('2026-10-31T10:00:01.000Z');
    await interact(() => ticks[0]?.());
    expect(shown()).toBe('2026-10-31T10:00:01.000Z');

    await view.render(<Probe now={now} ticker={ticker} running={false} />);
    expect(stopped).toBe(1);
    await view.unmount();
  });

  it('does not tick at all when it is not running', async () => {
    const ticks: (() => void)[] = [];
    const view = await mount(
      <Probe
        now={() => new Date('2026-10-31T10:00:00.000Z')}
        ticker={onTick => {
          ticks.push(onTick);
          return () => undefined;
        }}
        running={false}
      />,
    );
    expect(ticks).toHaveLength(0);
    await view.unmount();
  });
});

describe('secondTicker', () => {
  it('calls back every second until stopped', async () => {
    const real = globalThis.setInterval;
    const set: { fn: () => void; ms: number }[] = [];
    const cleared: unknown[] = [];
    const realClear = globalThis.clearInterval;
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      set.push({ fn, ms });
      return 7;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((id: unknown) => {
      cleared.push(id);
    }) as unknown as typeof clearInterval;
    try {
      let count = 0;
      const stop = secondTicker(() => {
        count += 1;
      });
      expect(set[0]?.ms).toBe(1000);
      set[0]?.fn();
      expect(count).toBe(1);
      stop();
      expect(cleared).toEqual([7]);
    } finally {
      globalThis.setInterval = real;
      globalThis.clearInterval = realClear;
    }
  });
});
