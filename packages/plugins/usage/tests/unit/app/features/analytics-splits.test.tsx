import { describe, expect, it } from 'bun:test';

import { CostSplit, MetricSplit, UnpricedChip } from '../../../../app/features/analytics/analytics-cost-rows.tsx';
import { formatDollars } from '../../../../app/features/analytics/analytics-overview.ts';
import { render } from '@ferretry/app/testing';

const text = (renderer: ReturnType<typeof render>): string => JSON.stringify(renderer.toJSON());

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
