import { describe, expect, test } from 'bun:test';
import type { AnalyticsResponse } from '../../../contract/index.ts';
import { compactNumber, DASH, duration, measure, percent, renderTable, usdMicros } from '../../../cli/lib/format.ts';
import { renderAnalytics } from '../../../cli/lib/render.ts';
import { aggregateResponse, group, measure as cell } from '../app/support/analytics-query-fixtures.ts';
import { rawResponse, rawRow } from '../app/support/analytics-rows.ts';

describe('number formats', () => {
  test('compactNumber keeps integers below a thousand exact and shortens the rest', () => {
    expect(compactNumber(7)).toBe('7');
    expect(compactNumber(7.25)).toBe('7.3');
    expect(compactNumber(1_500)).toBe('1.5k');
    expect(compactNumber(-2_500_000)).toBe('-2.5m');
    expect(compactNumber(3_200_000_000)).toBe('3.2b');
  });

  test('duration picks the largest unit that keeps the number small', () => {
    expect(duration(250.4)).toBe('250ms');
    expect(duration(45_000)).toBe('45s');
    expect(duration(125_000)).toBe('2m05s');
    expect(duration(3_725_000)).toBe('1h02m');
  });

  test('percent has more precision where the number is small', () => {
    expect(percent(5)).toBe('5.00%');
    expect(percent(12.34)).toBe('12.3%');
    expect(percent(-12.34)).toBe('-12.3%');
  });

  test('usdMicros keeps enough decimals that a cheap run is not rounded to nothing', () => {
    expect(usdMicros(12_340_000)).toBe('$12.34');
    expect(usdMicros(1_234_000)).toBe('$1.234');
    expect(usdMicros(12_340)).toBe('$0.0123');
  });
});

describe('measure', () => {
  test('a complete measure prints bare, a partial one carries [known/total], an unknown one a dash', () => {
    expect(measure({ value: 5, known: 3, total: 3 }, String)).toBe('5');
    expect(measure({ value: 5, known: 3, total: 40 }, String)).toBe('5[3/40]');
    expect(measure({ value: null, known: 0, total: 4 }, String)).toBe(`${DASH}[0/4]`);
    expect(measure({ value: null, known: 2, total: 2 }, String)).toBe(DASH);
  });
});

describe('renderTable', () => {
  test('pads every column but the last, rules under the header, and tolerates a short row', () => {
    const text = renderTable(['NAME', 'N'], [['alpha', '1'], ['b']]);
    expect(text.split('\n')).toEqual(['NAME   N', '─────  ─', 'alpha  1', 'b']);
  });
});

describe('renderAnalytics', () => {
  test('an aggregate prints the costliest group first, unknown cost last, ties by sessions then label', () => {
    const response = aggregateResponse('sum by (model)', [
      group({ model: 'unknown-cost' }, { equivalentApiCostUsdMicros: cell(null, 0, 5) }),
      group({ model: 'b-cheap' }, { equivalentApiCostUsdMicros: cell(1_000_000, 5, 5) }),
      group({ model: 'a-cheap' }, { equivalentApiCostUsdMicros: cell(1_000_000, 5, 5) }),
      group({ model: 'z-few' }, { sessions: 2, equivalentApiCostUsdMicros: cell(1_000_000, 5, 5) }),
      group({ model: 'dear' }, { equivalentApiCostUsdMicros: cell(9_000_000, 5, 5) }),
      group({ model: null }, { equivalentApiCostUsdMicros: cell(null, 0, 5) }),
    ]);
    const lines = renderAnalytics(response).split('\n');
    const order = lines.filter(line => /^model=/u.test(line)).map(line => line.split(/\s{2,}/u)[0]);
    expect(order).toEqual([
      'model=dear',
      'model=a-cheap',
      'model=b-cheap',
      'model=z-few',
      `model=${DASH}`,
      'model=unknown-cost',
    ]);
    expect(lines[0]).toBe('All sessions: 20 indexed, 27 matched');
    expect(lines[1]).toBe('Query: sum by (model)');
    expect(lines.join('\n')).toContain('EQUIV API COST');
    expect(lines.at(-1)).toContain('a comparison, not a bill');
  });

  test('a count prints sessions and rates only, in the order the engine gave', () => {
    const response = aggregateResponse('count', [group({}, { sessions: 3 }), group({ day: 'd' })], {}, 'count');
    const text = renderAnalytics(response);
    expect(text).toContain('GROUP  SESSIONS  STALL  FAIL   DONE');
    expect(text).toContain('all');
    expect(text).not.toContain('EQUIV API COST');
  });

  test('an aggregate with no groups, and a raw answer with no rows, say nothing matched', () => {
    expect(renderAnalytics(aggregateResponse('sum', []))).toContain('No sessions match the query.');
    expect(renderAnalytics(rawResponse([]))).toContain('No sessions match the query.');
  });

  test('a raw answer lists each session, dashes what is unknown, and says when it was cut short', () => {
    const response = rawResponse(
      [
        rawRow({ id: 's1' }),
        rawRow({
          id: 's2',
          status: null,
          agent: null,
          model: null,
          harness: null,
          label: null,
          tokens: null,
          equivalentApiCostUsdMicros: null,
          turns: null,
          durationMs: null,
          activeDurationMs: null,
        }),
      ],
      '',
      true,
    );
    const text = renderAnalytics(response);
    expect(text).toContain('Query: (none)');
    expect(text).toContain('s1');
    expect(text).toContain('Flaky test fix');
    expect(text).toMatch(/s2 +— +— +— +— +— +— +— +— +— +—/u);
    expect(text).toContain('Showing 100 of 2 rows; add a filter.');
  });

  test('the footer says how complete the index is, with pending sources, errors and a running backfill', () => {
    const base = rawResponse([rawRow({ id: 's1' })]);
    const plain = renderAnalytics(base);
    expect(plain).toContain('Token index: 10/10 sessions known; 10/10 transcript sources indexed.');
    expect(plain).not.toContain('Token backfill');
    const troubled: AnalyticsResponse = {
      ...base,
      index: { ...base.index, pendingTranscriptSources: 3, sourceErrors: 2, refreshing: true },
    };
    const text = renderAnalytics(troubled);
    expect(text).toContain('transcript sources indexed (3 pending), 2 errors.');
    expect(text).toContain('Token backfill is running in the daemon.');
  });
});
