import { describe, expect, it } from 'bun:test';

import { CostSplit, MetricSplit, UnpricedChip } from '../../../src/features/analytics/analytics-cost-rows.tsx';
import {
  AnalyticsMetricChart,
  chartLabelKeys,
  type MetricChartPoint,
} from '../../../src/features/analytics/analytics-metric-chart.tsx';
import { durationAxisTicks, formatAxisUsd, formatDollars } from '../../../src/features/analytics/analytics-overview.ts';
import { render, run } from '../../support/react.ts';

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

const COST = {
  title: 'Equivalent API cost per day',
  series: [{ key: 'cost', label: 'Equivalent API cost', tone: 'accent' as const }],
  format: formatDollars,
  formatAxis: formatAxisUsd,
  flagNote: 'has unpriced sessions',
};

const text = (renderer: ReturnType<typeof render>): string => JSON.stringify(renderer.toJSON());

describe('AnalyticsMetricChart', () => {
  it('labels its axis, draws a known zero as a hairline and flags a lower bound', () => {
    const renderer = render(<AnalyticsMetricChart {...COST} points={POINTS} />);
    const output = text(renderer);
    for (const tick of ['$0', '$50', '$100', '$150']) expect(output).toContain(tick);
    expect(renderer.root.findByProps({ 'data-chart-flag-note': '' })).toBeDefined();
    expect(renderer.root.findByProps({ 'data-chart-point': '2026-10-11' }).props['data-chart-zero']).toBe('');
    expect(renderer.root.findByProps({ 'data-chart-point': '2026-10-12' }).props.title).toBe(
      '12 Oct · $62.80 · 1 unpriced',
    );
    expect(renderer.root.findByProps({ role: 'img' }).props['aria-label']).toBe(
      'Equivalent API cost per day, 10-11 to 10-14: $192.20 in total, highest $109.40 at 10-13.',
    );
    // One series draws no legend.
    expect(renderer.root.findAll(node => node.props['data-chart-legend'] !== undefined)).toHaveLength(0);
  });

  it('reads out the peak until a bar is hovered', () => {
    const renderer = render(<AnalyticsMetricChart {...COST} points={POINTS} />);
    const readout = () => renderer.root.findByProps({ 'data-chart-readout': '' }).children.join('');
    expect(readout()).toBe('10-13 · $109.40');
    const bar = renderer.root.findByProps({ 'data-chart-point': '2026-10-11' });
    run(() => bar.props.onPointerEnter());
    expect(readout()).toBe('10-11 · $0.00');
    run(() => bar.props.onPointerLeave());
    expect(readout()).toBe('10-13 · $109.40');
  });

  it('rests on the newest bar with none dimmed when asked, and takes its own plot height', () => {
    const renderer = render(<AnalyticsMetricChart {...COST} points={POINTS} resting="last" plotClassName="h-28" />);
    const readout = () => renderer.root.findByProps({ 'data-chart-readout': '' }).children.join('');
    const dimmed = () => renderer.root.findAll(node => String(node.props.className ?? '').includes('opacity-75'));
    expect(readout()).toBe('10-14 · $20.00');
    expect(dimmed()).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-chart-axis': '' }).props.className).toContain('h-28');
    expect(renderer.root.findByProps({ 'data-chart-axis': '' }).props.className).not.toContain('h-40');
    run(() => renderer.root.findByProps({ 'data-chart-point': '2026-10-13' }).props.onPointerEnter());
    expect(readout()).toBe('10-13 · $109.40');
    expect(dimmed().length).toBeGreaterThan(0);
  });

  it('stacks several series with a legend, on caller ticks', () => {
    const renderer = render(
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
        axisTicks={durationAxisTicks}
      />,
    );
    expect(renderer.root.findAll(node => node.props['data-chart-legend'] !== undefined)).toHaveLength(4);
    expect(text(renderer)).toContain('6000s');
    const stack = renderer.root.findByProps({ 'data-chart-point': '2026-10-11' }).findByProps({
      className: 'flex w-full flex-col-reverse overflow-hidden rounded-t-xs ',
    });
    expect(stack.props.style.height).toBe('90%');
  });

  it('says so when nothing happened, without a warning legend', () => {
    const renderer = render(<AnalyticsMetricChart {...COST} points={[point('2026-10-11', [0])]} emptyText="None." />);
    expect(text(renderer)).toContain('None.');
    expect(renderer.root.findAll(node => node.props['data-chart-flag-note'] !== undefined)).toHaveLength(0);
    const empty = render(<AnalyticsMetricChart {...COST} points={[]} />);
    expect(empty.root.findByProps({ role: 'img' }).props['aria-label']).toContain('$0.00 in total.');
    expect(text(empty)).toContain('Nothing in this period.');
  });

  it('prints every nth label counted back from the last', () => {
    expect([...chartLabelKeys(POINTS, 2)]).toEqual(['2026-10-12', '2026-10-14']);
  });
});

describe('MetricSplit', () => {
  const rows = [
    { key: 'opus', value: 412.6, unknown: 0, sessions: 3 },
    { key: 'sonnet', value: 98.2, unknown: 1, sessions: 2 },
    { key: 'astra', value: 0, unknown: 1, sessions: 1 },
    { key: 'sol', value: 11.8, unknown: 0, sessions: 1 },
    { key: 'haiku', value: 4.1, unknown: 0, sessions: 1 },
  ];

  it('shows a gap once, where it is: a word for none, a lower bound for some, nothing for all', () => {
    const renderer = render(
      <MetricSplit label="split" rows={rows.slice(0, 3)} format={formatDollars} unknownWord="unpriced" />,
    );
    const amounts = renderer.root
      .findAll(node => node.props['data-split-amount'] !== undefined && node.type === 'span')
      .map(node => node.children.join(''));
    expect(amounts).toEqual(['$412.60', '≥ $98.20', 'unpriced']);
    expect(renderer.root.findByProps({ 'data-split-row': 'opus' }).props.title).toBeUndefined();
    expect(renderer.root.findByProps({ 'data-split-row': 'sonnet' }).props.title).toBe(
      '1 of 2 sessions unpriced, so this is a lower bound',
    );
    expect(renderer.root.findByProps({ 'data-split-row': 'astra' }).props.title).toBe('1 of 1 session unpriced');
  });

  it('folds the tail into "other N" and says when there is nothing', () => {
    const renderer = render(
      <MetricSplit label="s" rows={rows} format={formatDollars} unknownWord="unpriced" limit={3} />,
    );
    expect(
      renderer.root
        .findAll(node => node.props['data-split-row'] !== undefined && node.type === 'li')
        .map(node => node.props['data-split-row']),
    ).toEqual(['opus', 'sonnet', 'other 3']);
    expect(text(renderer)).toContain('≥ $15.90');
    const zero = render(
      <MetricSplit
        label="s"
        rows={[{ key: 'x', value: 0, unknown: 0, sessions: 1 }]}
        format={formatDollars}
        unknownWord="u"
        limit={3}
      />,
    );
    expect(text(zero)).toContain('$0.00');
    expect(text(render(<MetricSplit label="s" rows={[]} format={formatDollars} unknownWord="u" />))).toContain(
      'No sessions in this period.',
    );
  });
});

describe('cost rows', () => {
  it('folds the tail into "other", keeps the amount and adds the unpriced row', () => {
    const renderer = render(
      <CostSplit
        label="split"
        unpriced={1}
        limit={3}
        shares={[
          { model: 'opus', costMicros: 412_600_000, sessions: 3 },
          { model: 'sonnet', costMicros: 98_200_000, sessions: 2 },
          { model: 'sol', costMicros: 11_800_000, sessions: 1 },
          { model: 'haiku', costMicros: 4_100_000, sessions: 1 },
        ]}
      />,
    );
    const rows = renderer.root.findAll(node => node.props['data-cost-row'] !== undefined && node.type === 'li');
    expect(rows.map(row => row.props['data-cost-row'])).toEqual(['opus', 'sonnet', 'other 2', 'unpriced']);
    expect(text(renderer)).toContain('$15.90');
    expect(text(renderer)).toContain('1 session');
    const many = render(<CostSplit label="s" unpriced={5} shares={[]} />);
    expect(text(many)).toContain('5 sess.');
  });

  it('says nothing was priced rather than drawing an empty list', () => {
    expect(text(render(<CostSplit label="s" shares={[]} />))).toContain('Nothing was priced');
  });

  it('names the unpriced count, and renders nothing for zero', () => {
    expect(render(<UnpricedChip count={0} />).toJSON()).toBeNull();
    const one = render(<UnpricedChip count={1} />).root.findByProps({ 'data-unpriced': 1 });
    expect(one.props.title).toContain('leaves it out');
    const many = render(<UnpricedChip count={14} />).root.findByProps({ 'data-unpriced': 14 });
    expect(many.props.title).toContain('14 sessions could not be priced, so the amount leaves them out');
  });
});
