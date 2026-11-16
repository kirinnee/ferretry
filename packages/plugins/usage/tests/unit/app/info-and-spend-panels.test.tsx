import { describe, expect, it } from 'bun:test';
import type { UsageFeedView } from '../../../contract/index.ts';
import { DaemonUsageStore, daemonUsagePort } from '../../../app/lib/usage-store.ts';
import { FerretUsageInfoPanel } from '../../../app/shell/info-usage.tsx';
import { SpendTodayPanel, spendDollars } from '../../../app/shell/spend-today.tsx';
import { FerretWorkspaceActionsProvider } from '@ferretry/app';
import { interact, mount } from '@ferretry/app/testing';
import { rawResponse, rawRow } from './support/analytics-rows.ts';
import { DaemonCallError } from '../../../app/shell.ts';
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
  live?: unknown,
) => {
  const client = fakeClient({
    'GET /v1/usage/insights': () => rawResponse(rows),
    'GET /v1/usage': feed ?? {},
    ...(live === undefined ? {} : { 'GET /v1/ferrets/:ferretId/live': live }),
  });
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

  describe('live turns and context (GET /v1/ferrets/:ferretId/live)', () => {
    const shownFor = async (live: unknown) => {
      const view = await panel([rawRow({ id: 'f1', contextEndPercent: 20, turns: 3 })], feedOf(), 'f1', live);
      try {
        await interact(async () => await new Promise(done => setTimeout(done, 20)));
        return text(view.container);
      } finally {
        await view.unmount();
      }
    };

    /** The value drawn beside a row's label. */
    const cellOf = (container: HTMLElement, label: string): string | undefined =>
      container.querySelector(`[data-info-row="${label}"] span:last-child`)?.textContent ?? undefined;
    const rowsFor = async (rows: Parameters<typeof rawResponse>[0], live: unknown) => {
      const view = await panel(rows, feedOf(), 'f1', live);
      try {
        await interact(async () => await new Promise(done => setTimeout(done, 20)));
        return {
          text: text(view.container),
          context: cellOf(view.container, 'Context'),
          turns: cellOf(view.container, 'Turns'),
          tokens: cellOf(view.container, 'Tokens'),
          link: view.container.querySelector('[data-info-open-insights]') !== null,
        };
      } finally {
        await view.unmount();
      }
    };

    it('usage#0 draws the live context and turns, with the window, not the previous turn’s end-of-turn row', async () => {
      // The stale row says 3 turns and 800 input tokens: the live 8 must be the Turns row itself, not "in 800".
      const shown = await rowsFor([rawRow({ id: 'f1', contextEndPercent: 20, turns: 3 })], {
        turns: 8,
        contextPercent: 74,
        contextWindow: 200_000,
      });
      expect(shown.turns).toBe('8');
      expect(shown.context).toContain('74%');
      expect(shown.context).toContain('of 200K tokens');
      expect(shown.text).not.toContain('20%');
      expect(shown.tokens).toContain('in 800');
    });

    it('usage#0 says unknown for a fact a SUCCESSFUL live read does not state, never the analytics row’s', async () => {
      const shown = await rowsFor([rawRow({ id: 'f1', contextEndPercent: 20, turns: 3 })], {
        turns: null,
        contextPercent: null,
        contextWindow: null,
      });
      expect(shown.turns).toBe('unknown');
      expect(shown.context).toBe('Not reported yet');
      expect(shown.text).not.toContain('20%');
    });

    it('usage#0 falls back to the analytics row only when the live route is unavailable: not there, refused, or unreadable', async () => {
      for (const live of [
        undefined,
        () => {
          throw new DaemonCallError(501, 'not_implemented', 'no live route');
        },
        () => {
          throw new DaemonCallError(500, 'internal', 'broke');
        },
        { turns: 'many' },
      ]) {
        const shown = await rowsFor([rawRow({ id: 'f1', contextEndPercent: 20, turns: 3 })], live);
        expect(shown.context).toContain('20%');
        expect(shown.context).not.toContain('tokens');
        expect(shown.turns).toBe('3');
      }
    });

    it('usage#0 draws the live context, turns and the Open Insights action for a ferret with no indexed analytics row', async () => {
      const shown = await rowsFor([], { turns: 8, contextPercent: 74, contextWindow: 200_000 });
      expect(shown.turns).toBe('8');
      expect(shown.context).toContain('74%');
      expect(shown.link).toBe(true);
      // The row alone holds the totals and the quota: they are not drawn, and no "no turns" contradicts the live 8.
      expect(shown.tokens).toBeUndefined();
      expect(shown.text).not.toContain('Login quota');
      expect(shown.text).not.toContain('No turns recorded yet');
    });

    it('usage#0 says there are no turns when neither the row nor the live read has any', async () => {
      const shown = await rowsFor([], { turns: 0, contextPercent: null, contextWindow: null });
      expect(shown.text).toContain('No turns recorded yet');
      expect(shown.turns).toBe('0');
    });

    it('usage#0 says Reading… for context and turns until the live route answers', async () => {
      let release: ((answer: unknown) => void) | undefined;
      const view = await panel(
        [rawRow({ id: 'f1', contextEndPercent: 20, turns: 3 })],
        feedOf(),
        'f1',
        () =>
          new Promise(resolve => {
            release = resolve;
          }),
      );
      try {
        await interact(async () => await new Promise(done => setTimeout(done, 20)));
        expect(cellOf(view.container, 'Turns')).toBe('Reading…');
        expect(cellOf(view.container, 'Context')).toBe('Reading…');
        expect(text(view.container)).not.toContain('20%');
        await interact(() => release?.({ turns: 8, contextPercent: 74, contextWindow: null }));
        expect(cellOf(view.container, 'Turns')).toBe('8');
      } finally {
        await view.unmount();
      }
    });

    it('usage#0 leaves the window out when the document states a percent but no window', async () => {
      const shown = await shownFor({ turns: 4, contextPercent: 55, contextWindow: null });
      expect(shown).toContain('55%');
      expect(shown).not.toContain('of ');
    });
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

  it('usage#0 says a priced cost is this ferret’s, and links to the machine’s Insights', async () => {
    const view = await panel([rawRow({ id: 'f1', equivalentApiCostUsdMicros: 2_000_000 })], feedOf());
    try {
      expect(text(view.container)).toContain('$2.00this ferret');
      const link = view.container.querySelector('[data-info-open-insights]');
      expect(link?.textContent).toBe('Open Insights');
      expect(link?.getAttribute('href') ?? '').toContain('insights');
    } finally {
      await view.unmount();
    }
  });

  describe('Open Insights inside the ferret’s own workspace', () => {
    const open = async (workspace: { ferret: string; daemon: string; shows: boolean }, shown: string[]) => {
      const client = fakeClient({
        'GET /v1/usage/insights': () => rawResponse([rawRow({ id: 'f1' })]),
        'GET /v1/usage': feedOf(),
      });
      const store = new DaemonUsageStore(daemonUsagePort(client), { pollMs: 60_000, isHidden: () => true });
      return await mount(
        <FerretWorkspaceActionsProvider
          canControl
          daemon={workspace.daemon}
          ferret={workspace.ferret}
          showPanel={id => shown.push(id)}
          shows={() => workspace.shows}
        >
          <FerretUsageInfoPanel client={client} store={store} now={() => NOW} subject="f1" />
        </FerretWorkspaceActionsProvider>,
      );
    };
    const press = async (view: { container: HTMLElement }) => {
      const link = view.container.querySelector<HTMLAnchorElement>('[data-info-open-insights]');
      await interact(() => link?.click());
      return link;
    };

    it('usage#0 brings THIS ferret’s Insights panel on screen instead of leaving for the machine’s page', async () => {
      const shown: string[] = [];
      const view = await open({ ferret: 'f1', daemon: 'this-daemon', shows: true }, shown);
      try {
        expect((await press(view))?.title).toBe('Show this ferret’s Insights panel');
        expect(shown).toEqual(['insights']);
      } finally {
        await view.unmount();
      }
    });

    it('usage#0 keeps the machine’s Insights link when the workspace is another ferret’s, another machine’s, or has no such panel', async () => {
      for (const workspace of [
        { ferret: 'f2', daemon: 'this-daemon', shows: true },
        { ferret: 'f1', daemon: 'other-daemon', shows: true },
        { ferret: 'f1', daemon: 'this-daemon', shows: false },
      ]) {
        const shown: string[] = [];
        const view = await open(workspace, shown);
        try {
          expect((await press(view))?.title).toBe('Open the machine’s Insights');
          expect(shown).toEqual([]);
        } finally {
          await view.unmount();
        }
      }
    });
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
