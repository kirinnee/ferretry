import { describe, expect, it } from 'bun:test';

import { AnalyticsCostChart, chartLabelDays } from '../../../src/features/analytics/analytics-cost-chart.tsx';
import { CostSplit, UnpricedChip } from '../../../src/features/analytics/analytics-cost-rows.tsx';
import type { AnalyticsDayBucket } from '../../../src/features/analytics/analytics-overview.ts';
import { render, run } from '../../support/react.ts';

const bucket = (day: string, costMicros: number, sessions = 1, extra: Partial<AnalyticsDayBucket> = {}) => ({
  day,
  sessions,
  costMicros,
  unpriced: 0,
  partial: false,
  ...extra,
});

const DAYS: readonly AnalyticsDayBucket[] = [
  bucket('2026-10-11', 0, 0),
  bucket('2026-10-12', 62_800_000, 4, { unpriced: 1 }),
  bucket('2026-10-13', 109_400_000, 21),
  bucket('2026-10-14', 20_000_000, 3, { partial: true }),
];

const text = (renderer: ReturnType<typeof render>): string => JSON.stringify(renderer.toJSON());

describe('AnalyticsCostChart', () => {
  it('labels a dollar axis, draws a zero day as zero and flags unpriced and partial days', () => {
    const renderer = render(<AnalyticsCostChart days={DAYS} />);
    const output = text(renderer);
    for (const tick of ['$0', '$50', '$100', '$150']) expect(output).toContain(tick);
    expect(output).toContain('has unpriced sessions');
    const zero = renderer.root.findByProps({ 'data-chart-day': '2026-10-11' });
    expect(zero.props['data-chart-zero']).toBe('');
    expect(renderer.root.findByProps({ 'data-chart-day': '2026-10-12' }).props.title).toContain('1 unpriced');
    expect(renderer.root.findByProps({ 'data-chart-day': '2026-10-14' }).props.title).toContain('only partly listed');
    expect(renderer.root.findByProps({ role: 'img' }).props['aria-label']).toContain('highest $109.40 on 13 Oct');
  });

  it('reads out the peak day until a bar is hovered', () => {
    const renderer = render(<AnalyticsCostChart days={DAYS} />);
    const readout = () => renderer.root.findByProps({ 'data-chart-readout': '' }).children.join('');
    expect(readout()).toBe('13 Oct · $109.40 · 21 sessions');
    const bar = renderer.root.findByProps({ 'data-chart-day': '2026-10-11' });
    run(() => bar.props.onPointerEnter());
    expect(readout()).toBe('11 Oct · $0.00 · 0 sessions');
    run(() => bar.props.onPointerLeave());
    expect(readout()).toBe('13 Oct · $109.40 · 21 sessions');
  });

  it('says so when a period has no cost, without a warning legend', () => {
    const renderer = render(<AnalyticsCostChart days={[bucket('2026-10-11', 0, 1)]} />);
    expect(text(renderer)).toContain('No cost in this period.');
    expect(text(renderer)).not.toContain('has unpriced sessions');
    expect(render(<AnalyticsCostChart days={[]} />).root.findByProps({ role: 'img' }).props['aria-label']).toContain(
      '$0.00 in total',
    );
  });

  it('prints every nth day label counted back from the last', () => {
    expect([...chartLabelDays(DAYS, 2)]).toEqual(['2026-10-12', '2026-10-14']);
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
