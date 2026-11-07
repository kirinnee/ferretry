import { describe, expect, it } from 'bun:test';
import {
  AnalyticsMetricChart,
  analyticsAxisTicks,
  chartLabelKeys,
  type MetricChartPoint,
} from '../../../src/ui/metric-chart.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const point = (key: string, values: readonly number[], extra: Partial<MetricChartPoint> = {}): MetricChartPoint => ({
  key,
  label: key.slice(5),
  values,
  ...extra,
});

const POINTS: readonly MetricChartPoint[] = [
  point('2026-10-11', [0], { empty: true }),
  point('2026-10-12', [62.8], { flagged: true, readout: '12 Oct · $62.80 · 1 unpriced' }),
  point('2026-10-13', [109.4]),
  point('2026-10-14', [20]),
];

const dollars = (value: number): string => `$${value.toFixed(2)}`;
const COST = {
  title: 'Equivalent API cost per day',
  series: [{ key: 'cost', label: 'Equivalent API cost', tone: 'accent' as const }],
  format: dollars,
  formatAxis: (value: number) => `$${Math.round(value)}`,
  flagNote: 'has unpriced sessions',
};

const readout = (container: HTMLElement): string =>
  must(container.querySelector('[data-chart-readout]'), 'the readout').textContent ?? '';

describe('AnalyticsMetricChart', () => {
  it('labels its axis, draws a known zero as a hairline and flags a lower bound', async () => {
    const view = await mount(<AnalyticsMetricChart {...COST} points={POINTS} />);
    const output = view.container.textContent ?? '';
    for (const tick of ['$0', '$50', '$100', '$150']) expect(output).toContain(tick);
    expect(view.container.querySelector('[data-chart-flag-note]')).not.toBeNull();
    expect(view.container.querySelector('[data-chart-point="2026-10-11"]')?.hasAttribute('data-chart-zero')).toBe(true);
    expect(view.container.querySelector('[data-chart-point="2026-10-12"]')?.getAttribute('title')).toBe(
      '12 Oct · $62.80 · 1 unpriced',
    );
    expect(must(view.container.querySelector('[role="img"]'), 'the figure').getAttribute('aria-label')).toBe(
      'Equivalent API cost per day, 10-11 to 10-14: $192.20 in total, highest $109.40 at 10-13.',
    );
    // One series draws no legend.
    expect(view.container.querySelectorAll('[data-chart-legend]')).toHaveLength(0);
    await view.unmount();
  });

  it('reads out the peak until a bar is hovered', async () => {
    const view = await mount(<AnalyticsMetricChart {...COST} points={POINTS} />);
    expect(readout(view.container)).toBe('10-13 · $109.40');
    const bar = must(view.container.querySelector('[data-chart-point="2026-10-11"]'), 'a bar');
    await interact(() => bar.dispatchEvent(new Event('pointerover', { bubbles: true })));
    expect(readout(view.container)).toBe('10-11 · $0.00');
    await interact(() => bar.dispatchEvent(new Event('pointerout', { bubbles: true })));
    expect(readout(view.container)).toBe('10-13 · $109.40');
    await view.unmount();
  });

  it('rests on the newest bar with none dimmed when asked, and takes its own plot height', async () => {
    const view = await mount(<AnalyticsMetricChart {...COST} points={POINTS} resting="last" plotClassName="h-28" />);
    expect(readout(view.container)).toBe('10-14 · $20.00');
    expect(view.container.querySelectorAll('[class*="opacity-75"]')).toHaveLength(0);
    const axis = must(view.container.querySelector('[data-chart-axis]'), 'the axis');
    expect(axis.className).toContain('h-28');
    expect(axis.className).not.toContain('h-40');
    await view.unmount();
  });

  it('stacks several series with a legend, on caller ticks', async () => {
    const view = await mount(
      <AnalyticsMetricChart
        title="Active time"
        series={[
          { key: 'a', label: 'Input', tone: 'accent' },
          { key: 'b', label: 'Output', tone: 'ok' },
          { key: 'c', label: 'Cache read', tone: 'pend' },
          { key: 'd', label: 'Cache write', tone: 'info' },
        ]}
        points={[point('2026-10-11', [3_600, 1_800]), point('2026-10-12', [600, 0, 0, 0])]}
        format={value => `${value}s`}
        axisTicks={max => [0, max]}
      />,
    );
    expect(view.container.querySelectorAll('[data-chart-legend]')).toHaveLength(4);
    expect(view.container.textContent).toContain('5400s');
    await view.unmount();
  });

  it('says so when nothing happened, without a warning legend', async () => {
    const view = await mount(<AnalyticsMetricChart {...COST} points={[point('2026-10-11', [0])]} emptyText="None." />);
    expect(view.container.textContent).toContain('None.');
    expect(view.container.querySelectorAll('[data-chart-flag-note]')).toHaveLength(0);
    await view.unmount();
    const empty = await mount(<AnalyticsMetricChart {...COST} points={[]} />);
    expect(must(empty.container.querySelector('[role="img"]'), 'the figure').getAttribute('aria-label')).toContain(
      '$0.00 in total.',
    );
    expect(empty.container.textContent).toContain('Nothing in this period.');
    await empty.unmount();
  });

  it('prints every nth label counted back from the last', () => {
    expect([...chartLabelKeys(POINTS, 2)]).toEqual(['2026-10-12', '2026-10-14']);
  });
});

describe('axis and formatting', () => {
  it('picks round ticks from zero past the maximum', () => {
    expect(analyticsAxisTicks(109.4)).toEqual([0, 50, 100, 150]);
    expect(analyticsAxisTicks(3)).toEqual([0, 1, 2, 3]);
    expect(analyticsAxisTicks(0.6)).toEqual([0, 0.2, 0.4, 0.6]);
    expect(analyticsAxisTicks(0.7)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(analyticsAxisTicks(0)).toEqual([0, 1]);
  });
});
