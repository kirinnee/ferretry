import { describe, expect, it } from 'bun:test';
import type { UsageFeedView } from '../../../contract/index.ts';
import { DaemonUsageStore, daemonUsagePort } from '../../../app/lib/usage-store.ts';
import { FerretUsageInfoPanel } from '../../../app/shell/info-usage.tsx';
import { SpendTodayPanel, spendDollars } from '../../../app/shell/spend-today.tsx';
import { mount } from '@ferretry/app/testing';
import { rawResponse, rawRow } from './support/analytics-rows.ts';
import { fakeClient, refusingClient } from './support/client.ts';

const NOW = 1_700_000_000_000;
const feedOf = (extra: Partial<UsageFeedView['accounts'][number]> = {}): UsageFeedView => ({
  at: '2026-08-01T09:00:00.000Z',
  stale: false,
  accounts: [
    {
      agent: 'Marin',
      fiveHourPercent: 42,
      weeklyPercent: 10,
      fiveHourResetAt: NOW + 47 * 60_000,
      atLimit: false,
      authOk: true,
      ...extra,
    },
  ],
});

const panel = async (
  rows: Parameters<typeof rawResponse>[0],
  feed: UsageFeedView | null,
  subject: string | null = 'f1',
) => {
  const client = fakeClient({ 'GET /v1/usage/insights': () => rawResponse(rows), 'GET /v1/usage': feed ?? {} });
  const store = new DaemonUsageStore(daemonUsagePort(client), { pollMs: 60_000, isHidden: () => true });
  return await mount(
    <FerretUsageInfoPanel client={client} store={store} now={() => NOW} {...(subject === null ? {} : { subject })} />,
  );
};
const text = (container: HTMLElement): string => container.textContent ?? '';

describe('usage#0 Info › Usage panel (ferret.side)', () => {
  it('draws context, turns, tokens, cost and the login quota windows', async () => {
    const view = await panel(
      [
        rawRow({
          id: 'f1',
          contextEndPercent: 62,
          turns: 41,
          inputTokens: 1_000,
          outputTokens: 200,
          cachedInputTokens: 160,
          equivalentApiCostUsdMicros: 43_510_000,
        }),
      ],
      feedOf(),
    );
    try {
      const shown = text(view.container);
      expect(shown).toContain('Context');
      expect(shown).toContain('62%');
      expect(shown).toContain('41');
      expect(shown).toContain('in 1K');
      expect(shown).toContain('$43.51');
      expect(shown).toContain('Login quota · Marin');
      expect(shown).toContain('5 hours');
      expect(shown).toContain('42%');
      expect(shown).toContain('resets in 47m');
      expect(shown).toContain('Week');
    } finally {
      await view.unmount();
    }
  });

  it('says unknown rather than zero: no price, no tokens, no context, no turns, no quota reading', async () => {
    const view = await panel(
      [
        rawRow({
          id: 'f1',
          contextEndPercent: null,
          turns: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          equivalentApiCostUsdMicros: null,
          agent: 'Other',
        }),
      ],
      feedOf(),
    );
    try {
      const shown = text(view.container);
      expect(shown).toContain('Not reported yet');
      expect(shown).toContain('unknown');
      expect(shown).toContain('usage unknown — no pricing for this model');
      expect(shown).toContain('Login quota · Other');
      expect(shown).toContain('usage unknown');
    } finally {
      await view.unmount();
    }
  });

  it('usage#0 says the daemon’s own reason a cost is unknown, not always “no pricing for this model”', async () => {
    const view = await panel(
      [rawRow({ id: 'f1', equivalentApiCostUsdMicros: null, costGap: 'transcript_unresolved' })],
      feedOf(),
    );
    try {
      expect(text(view.container)).toContain('usage unknown — transcript not found');
      expect(text(view.container)).not.toContain('no pricing for this model');
    } finally {
      await view.unmount();
    }
  });

  it('usage#0 says a priced cost is this ferret’s, and links to its insights', async () => {
    const view = await panel([rawRow({ id: 'f1', equivalentApiCostUsdMicros: 2_000_000 })], feedOf());
    try {
      expect(text(view.container)).toContain('$2.00this ferret');
      const link = view.container.querySelector('[data-info-open-insights]');
      expect(link?.textContent).toBe('Open this ferret’s insights');
      expect(link?.getAttribute('href') ?? '').toContain('insights');
    } finally {
      await view.unmount();
    }
  });

  it('shows a credit login’s money line, and an at-limit state', async () => {
    const view = await panel(
      [rawRow({ id: 'f1' })],
      feedOf({ fiveHourPercent: undefined, weeklyPercent: undefined, spendUsd: 3.2, atLimit: true }),
    );
    try {
      expect(text(view.container)).toContain('$3.20 this month');
      expect(text(view.container)).toContain('At its limit');
    } finally {
      await view.unmount();
    }
  });

  it('names a row with no login, and a window without a reset time', async () => {
    const view = await panel([rawRow({ id: 'f1', agent: null })], feedOf({ fiveHourResetAt: undefined }));
    try {
      expect(text(view.container)).toContain('Login quota · unknown login');
      expect(text(view.container)).toContain('usage unknown');
    } finally {
      await view.unmount();
    }
  });

  it('says so when the ferret has no recorded turns yet', async () => {
    const view = await panel([], feedOf());
    try {
      expect(text(view.container)).toContain('No turns recorded yet');
    } finally {
      await view.unmount();
    }
  });

  it('says why a read failed and draws nothing without a subject', async () => {
    const client = refusingClient(503, 'daemon_unreachable', 'offline');
    const store = new DaemonUsageStore(daemonUsagePort(client), { pollMs: 60_000, isHidden: () => true });
    const failed = await mount(<FerretUsageInfoPanel client={client} store={store} subject="f1" />);
    try {
      expect(text(failed.container)).toContain('Couldn’t read: offline');
    } finally {
      await failed.unmount();
    }
    const none = await panel([], null, null);
    try {
      expect(text(none.container)).toBe('');
    } finally {
      await none.unmount();
    }
  });
});

describe('usage#1 Spend today tile (daemon.status)', () => {
  const NOW_DAY = (): Date => new Date('2026-10-16T12:00:00.000Z');

  it('shows today’s priced spend in dollars, linking to Insights', async () => {
    const client = fakeClient({
      'GET /v1/usage/insights': () =>
        rawResponse([rawRow({ id: 'a', day: '2026-10-16', equivalentApiCostUsdMicros: 3_750_000 })]),
    });
    const view = await mount(<SpendTodayPanel client={client} now={NOW_DAY} />);
    try {
      expect(text(view.container)).toContain('Spend today');
      expect(text(view.container)).toContain('$3.75');
      expect(text(view.container)).toContain('this machine');
    } finally {
      await view.unmount();
    }
  });

  it('draws a dash and “not available” when the machine does not answer', async () => {
    const view = await mount(
      <SpendTodayPanel client={refusingClient(503, 'daemon_unreachable', 'offline')} now={NOW_DAY} />,
    );
    try {
      expect(text(view.container)).toContain('—');
      expect(text(view.container)).toContain('not available');
    } finally {
      await view.unmount();
    }
  });

  it('says a zero day and a hundred-dollar day the way the tile always did', () => {
    expect(spendDollars(0)).toBe('$0');
    expect(spendDollars(12.5)).toBe('$12.50');
    expect(spendDollars(250.4)).toBe('$250');
  });
});
