/**
 * Info › Usage: context, turns, tokens, cost and the login's quota windows — every number traced to
 * its own source, and an unpriced or unknown total said in words, never a guess.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { AnalyticsMeasure, AnalyticsResponse } from '@ferretry/protocol';
import { type InfoAnalyticsRead, InfoUsage } from '../../../../src/features/session-info/info-usage.tsx';
import type { ResolvedQuota } from '../../../../src/lib/usage.ts';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { sessionView } from '../../../support/sessions.ts';

const NOW = Date.parse('2026-10-16T10:00:00.000Z');

const measure = (value: number | null, known = 1, total = 1): AnalyticsMeasure => ({ value, known, total });

const row = (overrides: Partial<Record<string, AnalyticsMeasure>> = {}) => ({
  labels: {},
  sessions: 1,
  rates: { stall: 0, failure: 0, completion: 1 },
  tokens: measure(1000),
  inputTokens: measure(600),
  outputTokens: measure(400),
  cachedInputTokens: measure(null),
  cacheWriteInputTokens: measure(null),
  cacheWrite5mInputTokens: measure(null),
  cacheWrite1hInputTokens: measure(null),
  reasoningTokens: measure(null),
  equivalentApiCostUsdMicros: measure(420_000),
  turns: measure(1),
  durationMs: measure(1000),
  timeToFirstOutputMs: measure(100),
  contextEndPercent: measure(10),
  ...overrides,
});

const aggregateResponse = (results: readonly ReturnType<typeof row>[]): AnalyticsResponse =>
  ({ kind: 'aggregate', aggregation: 'sum', query: 'sum', results }) as unknown as AnalyticsResponse;

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const show = async (
  overrides: {
    readonly analytics?: InfoAnalyticsRead;
    readonly quota?: ResolvedQuota | null;
    readonly onOpenAnalytics?: () => void;
  } = {},
) => {
  mounted = await mount(
    <InfoUsage
      analytics={overrides.analytics ?? { kind: 'loading' }}
      now={NOW}
      quota={overrides.quota ?? null}
      view={sessionView('session-a', { state: { contextPercent: undefined, turn: 3 } })}
      {...(overrides.onOpenAnalytics === undefined ? {} : { onOpenAnalytics: overrides.onOpenAnalytics })}
    />,
  );
  return mounted.container;
};

describe('InfoUsage — context and turns', () => {
  it('says Context is not reported yet, and shows the turn count', async () => {
    const root = await show();
    expect(root.textContent).toContain('Not reported yet');
    expect(must(root.querySelector('[data-info-row="Turns"]'), 'turns').textContent).toContain('3');
  });

  it('draws a meter once the CLI has reported a context percentage', async () => {
    mounted = await mount(
      <InfoUsage
        analytics={{ kind: 'loading' }}
        now={NOW}
        quota={null}
        view={sessionView('session-a', { state: { contextPercent: 42 } })}
      />,
    );
    expect(mounted.container.querySelector('[role="meter"]')).not.toBeNull();
  });

  it('says how many tokens of the window the daemon measured', async () => {
    const view = {
      ...sessionView('session-a'),
      context: { usedTokens: 118_000, windowTokens: 1_000_000, percent: 11.8, at: '2026-10-30T08:00:00.000Z' },
    };
    mounted = await mount(<InfoUsage analytics={{ kind: 'loading' }} now={NOW} quota={null} view={view} />);
    expect(mounted.container.textContent).toContain('118k of 1M tokens (12%)');
    expect(mounted.container.querySelector('[role="meter"]')).not.toBeNull();
  });
});

describe('InfoUsage — Tokens', () => {
  it('says it is reading, and reports a failed read', async () => {
    const reading = await show({ analytics: { kind: 'loading' } });
    expect(reading.textContent).toContain('Reading…');

    await mounted?.unmount();
    mounted = undefined;
    const failed = await show({ analytics: { kind: 'failed', reason: 'no index yet' } });
    expect(failed.textContent).toContain('Couldn’t read: no index yet');
  });

  it('says no turns were recorded when the aggregate has no rows', async () => {
    const root = await show({ analytics: { kind: 'ready', response: aggregateResponse([]) } });
    expect(root.textContent).toContain('No turns recorded yet');
  });

  it('says unknown when every token measure is null', async () => {
    const blank = row({ inputTokens: measure(null), outputTokens: measure(null), cachedInputTokens: measure(null) });
    const root = await show({ analytics: { kind: 'ready', response: aggregateResponse([blank]) } });
    const tokens = must(root.querySelector('[data-info-row="Tokens"]'), 'tokens row');
    expect(tokens.textContent).toContain('unknown');
  });

  it('joins in/out/cache tokens the way a person reads them', async () => {
    const full = row({
      inputTokens: measure(12_400),
      outputTokens: measure(800),
      cachedInputTokens: measure(3_100_000),
    });
    const root = await show({ analytics: { kind: 'ready', response: aggregateResponse([full]) } });
    const tokens = must(root.querySelector('[data-info-row="Tokens"]'), 'tokens row');
    expect(tokens.textContent).toContain('in 12.4K · out 800 · cache 3.1M');
  });
});

describe('InfoUsage — Cost', () => {
  it('shows an em dash while the analytics have failed, not a number', async () => {
    const root = await show({ analytics: { kind: 'failed', reason: 'gone' } });
    expect(must(root.querySelector('[data-info-row="Cost (equiv.)"]'), 'cost').textContent).toContain('—');
  });

  it('says usage is unknown — no pricing for this model when there is no row, or no priced value', async () => {
    const noRow = await show({ analytics: { kind: 'ready', response: aggregateResponse([]) } });
    expect(noRow.textContent).toContain('usage unknown — no pricing for this model');

    await mounted?.unmount();
    mounted = undefined;
    const unpriced = row({ equivalentApiCostUsdMicros: measure(null) });
    const root = await show({ analytics: { kind: 'ready', response: aggregateResponse([unpriced]) } });
    expect(root.textContent).toContain('usage unknown — no pricing for this model');
  });

  it('shows the dollar total for this ferret, flagging turns the index could not price', async () => {
    const exact = row({ equivalentApiCostUsdMicros: measure(420_000, 1, 1) });
    const full = await show({ analytics: { kind: 'ready', response: aggregateResponse([exact]) } });
    const costRow = must(full.querySelector('[data-info-row="Cost (equiv.)"]'), 'cost');
    expect(costRow.textContent).toContain('$0.42');
    expect(costRow.textContent).not.toContain('unpriced');

    await mounted?.unmount();
    mounted = undefined;
    const partial = row({ equivalentApiCostUsdMicros: measure(420_000, 2, 5) });
    const root = await show({ analytics: { kind: 'ready', response: aggregateResponse([partial]) } });
    expect(must(root.querySelector('[data-info-row="Cost (equiv.)"]'), 'cost').textContent).toContain(
      '3 turns unpriced',
    );
  });
});

describe('InfoUsage — Analytics link', () => {
  it('offers no link without a host, and opens this ferret’s analytics when given one', async () => {
    const without = await show();
    expect(without.querySelector('[data-info-open-analytics]')).toBeNull();

    await mounted?.unmount();
    mounted = undefined;
    const opened: boolean[] = [];
    const root = await show({ onOpenAnalytics: () => opened.push(true) });
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-open-analytics]'), 'link').click());
    expect(opened).toEqual([true]);
  });
});

describe('InfoUsage — quota windows', () => {
  it('says usage is unknown for a login with no quota reading', async () => {
    const root = await show({ quota: null });
    expect(root.textContent).toContain('usage unknown');
  });

  it('says the money a credit-billed login has left instead of "usage unknown"', async () => {
    const root = await show({ quota: { balance: { amount: 5.8, currency: 'USD' } } });
    expect(root.textContent).toContain('$5.80 left');
    expect(root.textContent).not.toContain('usage unknown');
  });

  it('shows the 5-hour and weekly windows, each with when it resets', async () => {
    const root = await show({
      quota: {
        fiveHourPercent: 40,
        fiveHourResetAt: NOW + 47 * 60_000,
        weeklyPercent: 70,
        weeklyResetAt: NOW + 3 * 3_600_000,
      },
    });
    expect(root.textContent).toContain('resets in 47m');
    expect(root.textContent).toContain('resets in 3h');
    expect(root.querySelectorAll('[role="meter"]').length).toBe(2);
  });

  it('shows a window with no reset time plainly, with no "resets in" clause', async () => {
    const root = await show({ quota: { fiveHourPercent: 10 } });
    expect(root.textContent).not.toContain('resets in');
  });

  it('flags a login at its limit', async () => {
    const root = await show({ quota: { fiveHourPercent: 100, atLimit: true } });
    expect(root.textContent).toContain('At its limit');
  });
});
