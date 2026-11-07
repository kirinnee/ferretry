/**
 * App-half parity (rebuild-parity.tsv, S rows of the Warden page and its Settings tab). Each name starts with the row
 * it covers. Where today's row lives in the app shell (a host route, the page-slot map, the machine-panel grouping,
 * the clone and settings-search catalogs) the name says so and the test claims only what the plugin declares for the
 * shell to read. Where a row's new owner is another plugin (the usage, browsers and conversation triggers) the test
 * claims only the Warden form's own catalog entry for it.
 */

import { describe, expect, test } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { WARDEN_AUTO_MOVE_TRIGGERS, WARDEN_CONFIG } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import app from '../../../app/index.ts';
import { WardenCombinedTotals } from '../../../app/features/warden/warden-combined-totals.tsx';
import { WardenConfigSurface } from '../../../app/features/warden/warden-config-card.tsx';
import { WardenOverviewSurface } from '../../../app/features/warden/warden-overview-surface.tsx';
import { WardenReportDialog } from '../../../app/features/warden/warden-report-dialog.tsx';
import { WardenSettingsForm } from '../../../app/features/warden/warden-settings-form.tsx';
import { wardenFormErrors } from '../../../app/features/warden/warden-settings-model.ts';
import { WardenStatsPanel } from '../../../app/features/warden/warden-stats.tsx';
import { combinedTodayTotals } from '../../../app/features/warden/warden-stats-model.ts';
import { WardenTotalsSurface } from '../../../app/features/warden/warden-totals-surface.tsx';
import { WardenPage, type WardenSurfaceProps } from '../../../app/lib/warden-page.tsx';
import { daemonConnection } from '../../../app/shell.ts';
import { fakeWardenClient } from '../../support/app/clients.ts';
import { wardenConfig, wardenFlag, wardenStatus } from '../../support/app/warden.ts';
import '../../support/app/shell-parts.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const POLL = { isHidden: () => false, pollMs: 3_600_000 } as const;
const connection = (id: string) =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceId: `token-${id}` });

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1)
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
};

const stubClient: PluginClient = { call: async () => undefined as never, subscribe: () => () => undefined };
const half = must(app.build, 'the app half builds')({ manifest, client: stubClient });

/** The Settings form with the move-to-another-login switch on, so every catalog entry is drawn. */
const formText = async (): Promise<string> => {
  const value = wardenConfig({
    layers: { jev: true, llm: true },
    autoMove: { ...wardenConfig().autoMove, enabled: true },
  });
  const view = await mount(
    <WardenSettingsForm
      value={value}
      onChange={() => undefined}
      jevKey={{ state: 'set' }}
      errors={wardenFormErrors(value)}
    />,
  );
  const text = view.container.textContent ?? '';
  await view.unmount();
  return text;
};

const screenDecl = manifest.ui.screens.find(screen => screen.id === 'warden');
const tabDecl = manifest.ui.settings.find(tab => tab.id === 'warden');

describe('app half: components the plugin owns', () => {
  test('S-0282 WardenConfigSurface reads the settings through the plugin client and draws the Warden switch', async () => {
    const view = await mount(
      <WardenConfigSurface
        connection={connection('a')}
        createClient={async () => fakeWardenClient()}
        deps={{
          speedups: async () => ({ vault: 'ok', providers: [] }),
          catalog: async () => ({ accounts: [] }),
          useConfigChange: () => undefined,
        }}
      />,
    );
    await settle();
    expect(view.container.querySelector('[aria-label="Warden on"]')).not.toBeNull();
    await view.unmount();
  });

  test('S-0284 WardenOverviewSurface polls the status route and draws the flagged ferret', async () => {
    const calls: string[] = [];
    const view = await mount(
      <WardenOverviewSurface
        connection={connection('a')}
        pollOptions={POLL}
        createClient={async () =>
          fakeWardenClient({
            status: async () => {
              calls.push('status');
              return wardenStatus({ flags: [wardenFlag({ ferret: 'only-a' })] });
            },
          })
        }
      />,
    );
    await settle();
    expect(calls).toContain('status');
    expect(view.container.textContent).toContain('only-a');
    await view.unmount();
  });

  test('S-0285 WardenPage is one labelled scroll region that hands the daemon connection to its Overview slot', async () => {
    const seen: string[] = [];
    const Overview = ({ connection: actual }: WardenSurfaceProps) => {
      seen.push(actual.daemonId);
      return <div data-surface="overview" />;
    };
    const view = await mount(<WardenPage connection={connection('a')} slots={{ Overview }} />);
    expect(view.container.querySelector('main[aria-label="Warden"]')).not.toBeNull();
    expect(seen).toEqual(['a']);
    await view.unmount();
  });

  test('S-0287 WardenReportDialog opens the report of a verdict through the report route reader', async () => {
    const asked: string[] = [];
    const view = await mount(
      <WardenReportDialog
        request={{
          connection: connection('a'),
          verdict: {
            at: '2026-07-31T11:58:00.000Z',
            target: 'ferret-a',
            verdict: 'needs_human',
            reportPath: 'reports/a.md',
          },
        }}
        read={async (_target, path) => {
          asked.push(path);
          return '# Evidence';
        }}
        onClose={() => undefined}
      />,
    );
    await settle();
    expect(asked).toEqual(['reports/a.md']);
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
    await view.unmount();
  });

  test('S-0289 WardenStatsPanel draws the stats tiles and the period switch from the status', async () => {
    const view = await mount(<WardenStatsPanel status={wardenStatus()} now={NOW} />);
    expect(view.container.querySelector('[aria-label="Warden stats"]')).not.toBeNull();
    expect(view.container.querySelector('[data-warden-tiles]')).not.toBeNull();
    expect(view.container.querySelector('[role="toolbar"][aria-label="Stats period"]')).not.toBeNull();
    await view.unmount();
  });

  test('S-0290 WardenTotalsSurface adds each paired daemon status into one combined line', async () => {
    const asked: string[] = [];
    const machines = [
      { connection: connection('ec2'), name: 'EC2' },
      { connection: connection('mbp'), name: 'MBP' },
    ];
    const view = await mount(
      <WardenTotalsSurface
        machines={machines}
        now={() => NOW}
        pollOptions={POLL}
        createClient={async target =>
          fakeWardenClient({
            status: async () => {
              asked.push(target.daemonId);
              return wardenStatus();
            },
          })
        }
      />,
    );
    await settle();
    expect(asked.sort()).toEqual(['ec2', 'mbp']);
    await view.unmount();
    expect(combinedTodayTotals([undefined], NOW)).toBeDefined();
    const none = await mount(<WardenCombinedTotals totals={combinedTodayTotals([undefined], NOW)} />);
    expect(none.container.querySelector('[data-warden-combined]')).toBeNull();
    await none.unmount();
  });

  test('S-0585 S-0586 WARDEN_SLOTS Overview and Totals are the two slots the page composes, the combined totals only with machines', async () => {
    const Overview = () => <div data-slot="overview" />;
    const Totals = () => <div data-slot="totals" />;
    const machines = [
      { connection: connection('ec2'), name: 'EC2' },
      { connection: connection('mbp'), name: 'MBP' },
    ];
    const view = await mount(
      <WardenPage
        connection={connection('ec2')}
        slots={{ Overview, Totals }}
        machines={machines}
        remembered={null}
        onRemember={() => undefined}
      />,
    );
    expect(view.container.querySelector('[data-slot="overview"]')).not.toBeNull();
    expect(view.container.querySelector('[data-slot="totals"]')).not.toBeNull();
    await view.unmount();
  });
});

describe('app half: the screen and the Settings tab', () => {
  test('S-0283 S-0288 WardenOverviewRoute and WardenRoute are host routes today; the plugin owns only the lazy view behind the warden screen', async () => {
    const screen = half.screens.warden;
    expect(typeof screen).toBe('function');
    let thrown: unknown;
    try {
      screen({} as never);
    } catch (reason) {
      thrown = reason;
    }
    expect(typeof (thrown as PromiseLike<unknown>).then).toBe('function');
    await (thrown as Promise<unknown>);
  });

  test('S-0410 the screen warden is declared at /warden with a nav entry and implemented by the app half', () => {
    expect(screenDecl).toMatchObject({ id: 'warden', path: '/warden', nav: { label: 'Warden' } });
    expect(Object.keys(half.screens)).toEqual(['warden']);
    expect(app.half).toBe('app');
  });

  test('S-0335 the warden feature is one app half that implements exactly the declared screen and settings tab', () => {
    expect(Object.keys(half.screens)).toEqual(manifest.ui.screens.map(screen => screen.id));
    expect(Object.keys(half.settings)).toEqual(manifest.ui.settings.map(tab => tab.id));
  });

  test('the dashboard strip and verdicts are declared in today’s place (daemon.status) and implemented as lazy panels', async () => {
    expect(manifest.ui.panels).toEqual([
      { slot: 'daemon.status', id: 'warden-strip', order: 60 },
      { slot: 'daemon.status', id: 'warden-verdicts', order: 61 },
    ]);
    expect(Object.keys(half.panels)).toEqual(manifest.ui.panels.map(panel => panel.id));
    for (const panel of [half.panels['warden-strip'], half.panels['warden-verdicts']]) {
      let thrown: unknown;
      try {
        panel({});
      } catch (reason) {
        thrown = reason;
      }
      expect(typeof (thrown as PromiseLike<unknown>).then).toBe('function');
      await (thrown as Promise<unknown>);
    }
  });

  test('Ask the Warden is declared as today’s ferret action, calling the investigate route', () => {
    expect(manifest.actions.app).toEqual([
      {
        id: 'ask-warden',
        on: 'ferret',
        label: 'Ask the Warden to investigate now…',
        calls: 'POST /v1/warden/investigate',
      },
    ]);
    expect(manifest.actions.routes.some(route => route.key === 'POST /v1/warden/investigate')).toBe(true);
  });

  test('S-0359 PAGE_SLOTS Warden is the shell page-slot map; the plugin gives it the warden screen and its nav entry', () => {
    expect(screenDecl?.nav).toMatchObject({ label: 'Warden', icon: 'shield' });
    expect(typeof half.screens.warden).toBe('function');
  });

  test('S-0383 route daemonWardenPath is the shell route /d/:daemonId/warden; the plugin declares only the relative path /warden', () => {
    expect(screenDecl?.path).toBe('/warden');
  });

  test('S-0286 S-0578 WardenPanel and LEADING_TABS warden: the Warden Settings tab is declared, ordered and implemented', () => {
    expect(tabDecl).toMatchObject({ id: 'warden', label: 'Warden' });
    expect(typeof half.settings.warden).toBe('function');
  });

  test('S-0431 settings panel warden is grouped under Supervision by the shell machine-panel list; the plugin declares only the tab label', () => {
    expect(tabDecl?.label).toBe('Warden');
  });

  test('S-0577 S-0579 the clone-settings file list and the settings-search catalog are shell catalogs; the plugin declares the warden config document and tab they read', () => {
    expect(manifest.data.config).toEqual([WARDEN_CONFIG]);
    expect(tabDecl).toMatchObject({ id: 'warden', order: 60 });
  });
});

describe('app half: the catalog entries of the Warden settings form', () => {
  test('S-0453 S-0532 budget_exceeded and rate_limited: the form lists both move triggers, which the usage plugin owns', async () => {
    expect(WARDEN_AUTO_MOVE_TRIGGERS).toEqual(expect.arrayContaining(['budget_exceeded', 'rate_limited']));
    const text = await formText();
    expect(text).toContain('Its login passes its hard spend budget');
    expect(text).toContain('It hits a usage limit');
  });

  test('S-0459 closeLeftovers: the form lists Close leftover browsers, which the browsers plugin acts on', async () => {
    expect(await formText()).toContain('Close leftover browsers');
  });

  test('S-0477 failover: the form lists Fail over under what may act alone', async () => {
    expect(await formText()).toContain('Fail over');
  });

  test('S-0517 nudge: the form lists Nudge under what may act alone', async () => {
    expect(await formText()).toContain('Nudge');
  });

  test('S-0524 paneDied: the form lists Pane died among the sweep triggers', async () => {
    expect(await formText()).toContain('Pane died');
  });

  test('S-0530 question: the form lists Question asked among the sweep triggers, an event the conversation plugin raises', async () => {
    expect(await formText()).toContain('Question asked');
  });

  test('S-0536 restart: the form lists Restart under what may act alone', async () => {
    expect(await formText()).toContain('Restart');
  });

  test('S-0537 resume: the form lists Resume or revive under what may act alone', async () => {
    expect(await formText()).toContain('Resume or revive');
  });

  test('S-0560 stop: the form lists Stop a ferret under what may act alone, off by default', async () => {
    const text = await formText();
    expect(text).toContain('Stop a ferret');
    expect(text).toContain('Off by default');
  });

  test('S-0573 turnEnd: the form lists Turn end among the sweep triggers', async () => {
    expect(await formText()).toContain('Turn end');
  });
});
