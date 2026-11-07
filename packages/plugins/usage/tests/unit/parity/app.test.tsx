/**
 * The usage-owned S rows of docs/design/rebuild-parity.tsv, one test per row, each named by its id. Every test drives the
 * real thing — the page, the settings tab, the screen the app half builds — through a scripted daemon client, and asserts
 * what a person sees. Nothing here ticks the tsv.
 */
import { describe, expect, it } from 'bun:test';
import { ANALYTICS_PRICING_RATE_APPLICABILITY, type AnalyticsResponse } from '../../../contract/index.ts';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ReactElement } from 'react';
import app from '../../../app/index.ts';
import { AnalyticsOverviewPage } from '../../../app/features/analytics/analytics-overview-page.tsx';
import { AnalyticsQueryPage } from '../../../app/features/analytics/analytics-query-page.tsx';
import { AnalyticsResponseView } from '../../../app/features/analytics/analytics-response-view.tsx';
import { GlobalAnalyticsPage } from '../../../app/features/analytics/global-analytics-page.tsx';
import { PerformanceSettings } from '../../../app/features/settings/performance-settings.tsx';
import { MOVE_TRIGGERS } from '../../../app/lib/move-triggers.ts';
import { daemonInsightsPath, daemonInsightsQueryPath } from '../../../app/shell.ts';
import manifest from '../../../manifest.ts';
import { fullReport, minimalReport } from '../contract/performance-report-fixtures.ts';
import { fakeClient, type RecordedCall } from '../app/support/client.ts';
import { interact, mount, must } from '@ferretry/app/testing';
import { aggregateResponse, group } from '../app/support/analytics-query-fixtures.ts';
import { rawResponse, rawRow } from '../app/support/analytics-rows.ts';
import { daemonConnection } from '../app/support/shell.ts';

const INSIGHTS = 'GET /v1/usage/insights';
const daemonA = daemonConnection({ daemonId: 'daemon-a' });
const NOW = (): Date => new Date('2026-10-16T12:00:00Z');

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1)
    await interact(async () => {
      for (let inner = 0; inner < 10; inner += 1) await Promise.resolve();
    });
};

const submit = async (container: HTMLElement): Promise<void> => {
  const form = must(container.querySelector('form'), 'the query form');
  await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await settle();
};

/** The half the shell builds for one daemon, over a scripted client. */
const halfOver = (routes: Parameters<typeof fakeClient>[0]) => {
  const client = fakeClient(routes);
  const half = must(app.build, 'the app half builder')({ manifest, client: client as never });
  return { client, half };
};

const costed = (query: string): AnalyticsResponse =>
  aggregateResponse(query, [group({ model: 'claude-opus-5-5' }), group({ model: 'gpt-6-astra' }, { sessions: 2 })], {
    groupBy: ['model'],
    metric: 'cost_usd',
  });

const PRICING_VIEW = {
  catalog: [],
  catalogFingerprint: 'catalog-current',
  sources: [],
  sourcesFingerprint: 'sources-current',
  rateApplicability: ANALYTICS_PRICING_RATE_APPLICABILITY,
  modelCatalogRates: [],
};

const ROOT = rawRow({ id: 'root', tree: 'root', equivalentApiCostUsdMicros: 43_510_000, tokens: 10_800_000 });
const CHILD = rawRow({ id: 'kid', tree: 'root', parent: 'root', equivalentApiCostUsdMicros: 5_000_000 });

const asElement = (value: unknown): ReactElement => value as ReactElement;

describe('usage parity · the app half', () => {
  it('S-0027 AnalyticsOverviewPage leads with the cost of the period across the machines asked', async () => {
    const view = await mount(
      <AnalyticsOverviewPage
        machines={[{ connection: daemonA, name: 'studio-mac' }]}
        requestAnalytics={async (_daemon, query) =>
          rawResponse([rawRow({ id: 'root', day: '2026-10-14', equivalentApiCostUsdMicros: 12_000_000 })], query)
        }
        now={NOW}
      />,
    );
    await settle();
    expect(view.container.textContent).toContain('Last 14 days');
    expect(view.container.textContent).toContain('$12.00');
    expect(view.container.textContent).toContain('Equivalent API cost per day');
    await view.unmount();
  });

  it('S-0028 AnalyticsQueryPage opens on its default query and asks nothing until Run', async () => {
    const client = fakeClient({ [INSIGHTS]: (call: RecordedCall) => costed(call.query?.q ?? '') });
    const view = await mount(<AnalyticsQueryPage connection={daemonA} client={client} now={NOW} />);
    const box = must(
      view.container.querySelector<HTMLTextAreaElement | HTMLInputElement>('[role="combobox"]'),
      'the box',
    );
    expect(box.value.length).toBeGreaterThan(0);
    expect(view.container.textContent).toContain('Run a query, or start from an example below.');
    expect(client.calls).toEqual([]);
    await view.unmount();
  });

  it('S-0029 AnalyticsResponseView shows a raw session and never turns an unpriced one into $0.00', async () => {
    const response = rawResponse([rawRow({ id: 'session-one', equivalentApiCostUsdMicros: null })]);
    const view = await mount(<AnalyticsResponseView response={response} />);
    expect(view.container.textContent).toContain('session-one');
    expect(view.container.textContent).toContain('Unpriced');
    expect(view.container.textContent).not.toContain('$0.00');
    await view.unmount();
  });

  it('S-0030 AnalyticsRoute: the insights screen puts the overview under the Insights and Warden strip', async () => {
    const { half } = halfOver({ [INSIGHTS]: (call: RecordedCall) => rawResponse([ROOT], call.query?.q) });
    const view = await mount(asElement(half.screens.insights({ params: {} })));
    await settle();
    const frame = must(view.container.querySelector('[data-insights="insights"]'), 'the insights frame');
    expect(Array.from(frame.querySelectorAll('[data-insights-tab]')).map(tab => tab.textContent)).toEqual([
      'Insights',
      'Warden',
    ]);
    expect(frame.querySelector('[aria-label="Global insights"]')).not.toBeNull();
    await view.unmount();
  });

  it('S-0046 BudgetSection: the budgets tab gives every login a spend budget editor', async () => {
    const { half } = halfOver({
      'GET /v1/logins': {
        format: 1,
        machine: 'studio-mac',
        logins: [sampleLogin('claude-personal', { label: 'personal' })],
      },
      'GET /v1/usage/budgets': { budgets: [] },
    });
    const view = await mount(asElement(half.settings.budgets({})));
    await settle();
    const editor = must(view.container.querySelector('[data-budget-editor="claude-personal"]'), 'the editor');
    expect(editor.querySelector('h4')?.textContent).toBe('Spend budget');
    expect(editor.querySelectorAll('[data-budget-input]')).toHaveLength(4);
    await view.unmount();
  });

  it('S-0106 GlobalAnalyticsPage reads this machine through the daemon client and says so', async () => {
    const client = fakeClient({ [INSIGHTS]: (call: RecordedCall) => rawResponse([ROOT], call.query?.q) });
    const view = await mount(
      <GlobalAnalyticsPage connection={daemonA} client={client} onNavigate={() => {}} now={NOW} initialQuery={null} />,
    );
    await settle();
    expect(view.container.querySelector('[aria-label="Global insights"]')).not.toBeNull();
    expect(view.container.textContent).toContain('this machine');
    expect(client.calls.length).toBeGreaterThan(0);
    expect(client.calls.every(call => call.route === INSIGHTS)).toBe(true);
    await view.unmount();
  });
});

describe('usage parity · Performance', () => {
  const RUNNING = {
    state: 'running',
    id: 'profile-1',
    startedAt: '2026-10-21T10:00:00.000Z',
    endsAt: '2026-10-21T10:00:30.000Z',
  };
  const noTimer = () => () => undefined;
  const profileClient = (start: unknown) =>
    fakeClient({ 'POST /v1/diagnostics/profile': start, 'GET /v1/diagnostics/profile/:id': start });
  const press = async (container: HTMLElement, selector: string): Promise<void> => {
    const button = must(container.querySelector<HTMLButtonElement>(selector), selector);
    await interact(() => button.click());
    await settle();
  };

  it('S-0176 PerformanceSettings offers a 30 second recording and starts it with POST /v1/diagnostics/profile', async () => {
    const client = profileClient(RUNNING);
    const view = await mount(
      <PerformanceSettings connection={daemonA} client={client} recorder={undefined} now={() => 0} timer={noTimer} />,
    );
    expect(view.container.textContent).toContain('Record 30 s');
    await press(view.container, '[data-performance-record]');
    expect(client.calls[0]).toMatchObject({ route: 'POST /v1/diagnostics/profile', body: { seconds: 30 } });
    await view.unmount();
  });

  it('S-0177 PhaseView swaps the idle button for the report the machine finished', async () => {
    const client = profileClient({ state: 'finished', id: 'profile-1', report: minimalReport() });
    const view = await mount(
      <PerformanceSettings connection={daemonA} client={client} recorder={undefined} now={() => 0} timer={noTimer} />,
    );
    await press(view.container, '[data-performance-record]');
    expect(view.container.querySelector('[data-performance-report]')).not.toBeNull();
    expect(view.container.querySelector('[data-performance-budgets]')?.textContent).toContain('Every budget held (0)');
    expect(view.container.textContent).toContain('Record again');
    await view.unmount();
  });

  it('S-0196 RecordingView counts the window down while the machine records', async () => {
    const client = profileClient(RUNNING);
    const view = await mount(
      <PerformanceSettings connection={daemonA} client={client} recorder={undefined} now={() => 0} timer={noTimer} />,
    );
    await press(view.container, '[data-performance-record]');
    expect(view.container.querySelector('[data-performance-progress]')).not.toBeNull();
    expect(view.container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
    expect(view.container.textContent).toContain('30 s left');
    expect(fullReport().budgets.length).toBeGreaterThan(0);
    await view.unmount();
  });
});

describe('usage parity · Model pricing and the session surface', () => {
  it('S-0179 PricingSettings reads the catalog of this daemon and says honestly when it is empty', async () => {
    const { half, client } = halfOver({ 'GET /v1/usage/pricing': PRICING_VIEW });
    const view = await mount(asElement(half.settings['model-pricing']({})));
    await settle();
    expect(client.calls.map(call => call.route)).toEqual(['GET /v1/usage/pricing']);
    expect(view.container.querySelector('[data-pricing-empty]')).not.toBeNull();
    expect(view.container.querySelector('[data-pricing-ledger]')).toBeNull();
    await view.unmount();
  });

  it('S-0205 ResultView shows when the query ran and what it came to', async () => {
    const client = fakeClient({ [INSIGHTS]: (call: RecordedCall) => costed(call.query?.q ?? '') });
    const view = await mount(
      <AnalyticsQueryPage connection={daemonA} client={client} now={() => new Date('2026-10-16T12:34:00Z')} />,
    );
    await submit(view.container);
    expect(view.container.textContent).toContain('Ran at 12:34 UTC');
    expect(view.container.textContent).toContain('claude-opus-5-5');
    expect(client.calls.map(call => call.route)).toEqual([INSIGHTS]);
    await view.unmount();
  });

  it('the composer quota is a composer.tools panel that shows the account its ferret runs on, and says unknown otherwise', async () => {
    expect(manifest.ui.panels.find(entry => entry.id === 'composer-quota')).toMatchObject({ slot: 'composer.tools' });
    const feedOf = () => ({
      at: '2026-08-01T09:00:00.000Z',
      stale: false,
      accounts: [{ agent: 'claude-auto-work', fiveHourPercent: 42, weeklyPercent: 10, atLimit: false, authOk: true }],
    });
    const { half } = halfOver({ 'GET /v1/usage': feedOf });
    // The subject is the FERRET'S id, as the composer sends it; the account it runs on rides in `account`.
    const named = await mount(
      asElement(
        half.panels['composer-quota']({ subject: 'ferret-7', account: { agent: 'claude-auto-work' } } as never),
      ),
    );
    await settle();
    expect(named.container.textContent).toContain('5h 42%');
    await named.unmount();
    // A ferret whose account the feed does not name is NOT given the account nearest its limit: its usage is unknown.
    const other = await mount(
      asElement(
        half.panels['composer-quota']({ subject: 'ferret-7', account: { agent: 'some-other-login' } } as never),
      ),
    );
    await settle();
    expect(other.container.textContent).toContain('usage unknown');
    expect(other.container.textContent).not.toContain('42%');
    await other.unmount();
    // A ferret id alone (no account handed) is never an account name: usage unknown.
    const bare = await mount(asElement(half.panels['composer-quota']({ subject: 'claude-auto-work' })));
    await settle();
    expect(bare.container.textContent).toContain('usage unknown');
    await bare.unmount();
    // The usage the ferret's own monitor stamped wins, as it did on today's session page.
    const stamped = await mount(
      asElement(
        half.panels['composer-quota']({
          subject: 'ferret-7',
          account: { agent: 'some-other-login', usage: { usage5hPercent: 7, usageWeeklyPercent: 3 } },
        } as never),
      ),
    );
    await settle();
    expect(stamped.container.textContent).toContain('5h 7%');
    await stamped.unmount();
  });

  it('S-0228 SessionAnalyticsSurface prices the ferret beside it, then with its children', async () => {
    const { half, client } = halfOver({
      [INSIGHTS]: (call: RecordedCall) =>
        call.query?.session === undefined
          ? rawResponse([ROOT, CHILD], call.query?.q)
          : rawResponse([ROOT], call.query?.q),
    });
    const view = await mount(asElement(half.panels.insights({ subject: 'root' })));
    await settle();
    expect(view.container.textContent).toContain('This session$43.51');
    expect(view.container.textContent).toContain('With children$48.51');
    expect(client.calls.some(call => call.query?.session === 'root')).toBe(true);
    await view.unmount();
  });
});

describe('usage parity · what the manifest declares and the half implements', () => {
  const screen = (id: string) => manifest.ui.screens.find(entry => entry.id === id);
  const setting = (id: string) => manifest.ui.settings.find(entry => entry.id === id);
  const panelOf = (id: string) => manifest.ui.panels.find(entry => entry.id === id);
  const { half } = halfOver({});

  it('S-0297 the analytics feature is exactly the screens, panels and settings the manifest names', () => {
    expect(Object.keys(half.screens).sort()).toEqual(manifest.ui.screens.map(entry => entry.id).sort());
    expect(Object.keys(half.panels).sort()).toEqual(manifest.ui.panels.map(entry => entry.id).sort());
    expect(Object.keys(half.settings).sort()).toEqual(manifest.ui.settings.map(entry => entry.id).sort());
  });

  it('S-0339 the Analytics page slot is the Insights nav entry of the insights screen', () => {
    expect(screen('insights')).toMatchObject({ path: 'insights', nav: { label: 'Insights' } });
    expect(typeof half.screens.insights).toBe('function');
  });

  it('S-0365 the overview address is /d/<daemon>/insights, the screen path under the daemon', () => {
    expect(daemonInsightsPath('alpha')).toBe(`/d/alpha/${screen('insights')?.path}`);
    expect(daemonInsightsPath('a b')).toBe('/d/a%20b/insights');
  });

  it('S-0366 the query address is /d/<daemon>/insights/query, carrying the trimmed query when there is one', () => {
    expect(daemonInsightsQueryPath('alpha')).toBe(`/d/alpha/${screen('insights-query')?.path}`);
    expect(daemonInsightsQueryPath('alpha', '  ')).toBe('/d/alpha/insights/query');
    expect(daemonInsightsQueryPath('alpha', ' sum by (model) ')).toBe(
      `/d/alpha/insights/query?q=${encodeURIComponent('sum by (model)')}`,
    );
  });

  it('S-0389 the insights-query screen mounts the query page of this daemon', async () => {
    const { half: queryHalf } = halfOver({});
    const view = await mount(asElement(queryHalf.screens['insights-query']({ params: {} })));
    await settle();
    expect(view.container.querySelector('[data-insights="insights"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Run a query, or start from an example below.');
    await view.unmount();
  });

  it('S-0421 Model pricing is a Settings tab of the manifest', () => {
    expect(setting('model-pricing')).toMatchObject({ label: 'Model pricing' });
  });

  it('S-0423 Performance is a Settings tab of the manifest', () => {
    expect(setting('performance')).toMatchObject({ label: 'Performance' });
  });

  it('S-0445 a ferret’s insights is a panel beside its chat', () => {
    expect(panelOf('insights')).toMatchObject({ slot: 'ferret.side' });
    expect(typeof half.panels.insights).toBe('function');
  });

  it('S-0453 the move trigger “its login passes its hard spend budget” is Usage’s', () => {
    expect(MOVE_TRIGGERS.find(trigger => trigger.id === 'budget_exceeded')?.label).toBe(
      'Its login passes its hard spend budget',
    );
  });

  it('S-0510 Model pricing is offered as the tab labelled “Model pricing” and it renders', async () => {
    const { half: pricingHalf } = halfOver({ 'GET /v1/usage/pricing': PRICING_VIEW });
    const view = await mount(asElement(pricingHalf.settings['model-pricing']({})));
    await settle();
    expect(setting('model-pricing')?.label).toBe('Model pricing');
    expect(view.container.textContent).toContain('Model pricing');
    await view.unmount();
  });

  it('S-0526 Performance is offered as the tab labelled “Performance” and it renders its recorder', async () => {
    const view = await mount(asElement(half.settings.performance({})));
    expect(setting('performance')?.label).toBe('Performance');
    expect(view.container.querySelector('[data-performance-record]')).not.toBeNull();
    await view.unmount();
  });

  it('S-0527 the palette finds Performance by the label its Settings tab declares', () => {
    const labels = manifest.ui.settings.map(entry => entry.label.toLowerCase());
    expect(labels.some(label => label.includes('performance'))).toBe(true);
  });

  it('S-0532 the move trigger “it hits a usage limit” is Usage’s', () => {
    expect(MOVE_TRIGGERS.find(trigger => trigger.id === 'rate_limited')?.label).toBe('It hits a usage limit');
  });
});
