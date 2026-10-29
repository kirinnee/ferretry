import { describe, expect, it } from 'bun:test';
import type { WardenActorCounts, WardenDayStats, WardenStatusView } from '@ferretry/protocol';

import {
  WardenChipBadge,
  WardenOverview,
  type WardenOverviewProps,
} from '../../../src/features/warden/warden-overview.tsx';
import type { WardenReportTarget } from '../../../src/features/warden/warden-overview-model.ts';
import type { WardenReadState } from '../../../src/hooks/use-warden-poll.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';
import {
  attentionItem,
  wardenAction,
  wardenAnomaly,
  wardenAttention,
  wardenConfig,
  wardenFailover,
  wardenInvestigation,
  wardenStatus,
} from '../../support/warden.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const connection = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'tok' });

const ready = <T,>(view: T): WardenReadState<T> => ({ status: 'ready', view });

interface Calls {
  readonly sweeps: number[];
  readonly leaves: string[];
  readonly reports: WardenReportTarget[];
  readonly navigations: string[];
}

const props = (overrides: Partial<WardenOverviewProps> = {}): { props: WardenOverviewProps; calls: Calls } => {
  const calls: Calls = { sweeps: [], leaves: [], reports: [], navigations: [] };
  return {
    calls,
    props: {
      connection,
      status: ready(wardenStatus({ lastSweepAt: '2026-07-31T11:59:00.000Z' })),
      attention: ready(wardenAttention()),
      now: NOW,
      settingsHref: '/d/daemon-a/settings#warden',
      onNavigate: to => calls.navigations.push(to),
      onSweep: () => calls.sweeps.push(1),
      onOpenReport: target => calls.reports.push(target),
      ...overrides,
    },
  };
};

const render = async (overrides: Partial<WardenOverviewProps> = {}) => {
  const built = props(overrides);
  const view = await mount(<WardenOverview {...built.props} />);
  return { ...view, calls: built.calls };
};

const button = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.includes(text)),
    `the ${text} button`,
  );

const counts = (auto = 0, jev = 0, llm = 0, owner?: number): WardenActorCounts => ({
  auto,
  jev,
  llm,
  ...(owner === undefined ? {} : { owner }),
});

const day = (date: string, overrides: Partial<WardenDayStats> = {}): WardenDayStats => ({
  day: date,
  flags: 0,
  jevDecisions: 0,
  investigations: 0,
  jevUsd: 0,
  investigationUsd: 0,
  moved: counts(),
  cleared: counts(),
  stopped: counts(),
  asked: counts(),
  ...overrides,
});

/** Today (Fri 31 Jul) and 6 days back, with 28 Jul missing. */
const history = (): WardenDayStats[] => [
  day('2026-07-25', {
    flags: 10,
    jevDecisions: 8,
    investigations: 2,
    moved: counts(1, 3, 0),
    cleared: counts(0, 4, 1),
  }),
  day('2026-07-26', { flags: 1, moved: counts(1, 0, 0) }),
  day('2026-07-27'),
  day('2026-07-29', { flags: 6, jevDecisions: 5, investigations: 1, cleared: counts(0, 5, 1) }),
  day('2026-07-30', { flags: 4, jevDecisions: 4, moved: counts(2, 2, 0) }),
  day('2026-07-31', {
    flags: 7,
    jevDecisions: 6,
    investigations: 2,
    moved: counts(3, 5, 1),
    cleared: counts(0, 2, 0),
    stopped: counts(0, 0, 1),
    asked: counts(0, 1, 0, 1),
  }),
];

const tileText = (container: HTMLElement, key: string): string =>
  must(container.querySelector(`[data-stat="${key}"]`), `the ${key} tile`).textContent ?? '';

const rows = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-warden-action]'),
];

const known = [
  sessionView('sess-a', { config: { teammate: 'maryah' } }),
  sessionView('sess-b', { config: { teammate: 'marin' } }),
  sessionView('sess-c', { config: { teammate: 'kamila' } }),
];

const actionsStatus = (): WardenStatusView =>
  wardenStatus({
    lastSweepAt: '2026-07-31T11:59:00.000Z',
    history: history(),
    actions: [
      wardenAction({
        sessionId: 'sess-a',
        action: 'restart',
        at: '2026-07-31T11:50:00.000Z',
        by: 'jev',
        confidence: 0.96,
        detail: 'Restarted its process; its terminal had closed.',
        reason: 'The terminal pane had closed.',
        anomalyKind: 'dead_monitor',
      }),
      wardenAction({
        sessionId: 'sess-b',
        action: 'stop',
        at: '2026-07-31T11:40:00.000Z',
        by: 'warden',
        actor: 'llm',
        investigator: 'warden-00002a',
        reportPath: 'reports/stop.md',
        detail: 'Stopped it after a long loop.',
      }),
      wardenAction({
        sessionId: 'sess-c',
        action: 'nudge',
        at: '2026-07-31T11:30:00.000Z',
        detail: 'Asked it to report.',
      }),
      wardenAction({
        sessionId: 'sess-c',
        action: 'nudge',
        at: '2026-07-31T11:20:00.000Z',
        detail: 'Asked it to report.',
      }),
      wardenAction({
        sessionId: 'sess-c',
        action: 'nudge',
        at: '2026-07-31T11:10:00.000Z',
        detail: 'Asked it to report.',
      }),
      wardenAction({
        sessionId: 'sess-a',
        action: 'bless',
        at: '2026-07-31T10:00:00.000Z',
        by: 'jev',
        confidence: 0.9,
        detail: 'Left alone for 1 h.',
      }),
    ],
  });

describe('WardenOverview', () => {
  it('should say it is reading while the status is loading, and count nothing while the feed loads', async () => {
    // Arrange
    const view = await render({ status: { status: 'loading' }, attention: { status: 'loading' } });
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(text).toContain('Reading the Warden’s status…');
      expect(view.container.querySelector('[data-warden-inbox]')).toBeNull();
      expect(text).not.toContain('Watching');
    } finally {
      await view.unmount();
    }
  });

  it('should call a failed status unknown rather than all clear and warn when the notifications cannot be counted', async () => {
    // Arrange
    const view = await render({
      status: { status: 'error', reason: 'status refused' },
      attention: { status: 'error', reason: 'feed refused' },
    });
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(text).toContain('Warden status unavailable');
      expect(text).toContain('status refused. This is unknown, not an all-clear.');
      expect(view.container.querySelector('[data-warden-inbox="warning"]')?.textContent).toBe(
        'Couldn’t count Warden notifications',
      );
      expect(text).not.toContain('No Warden notifications');
    } finally {
      await view.unmount();
    }
  });

  it('should keep a stale status on screen and say so', async () => {
    // Arrange
    const view = await render({
      status: {
        status: 'stale',
        view: wardenStatus({ lastSweepAt: '2026-07-31T11:59:00.000Z' }),
        reason: 'timeout',
      },
      attention: { status: 'stale', view: wardenAttention(), reason: 'offline' },
    });
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(text).toContain('Could not refresh the status (timeout); this is the last good read.');
      expect(view.container.querySelector('[data-warden-inbox="warning"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('should show the header, the status line, empty lists and a how-it-works disclosure when ready', async () => {
    // Arrange
    const view = await render();
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(view.container.querySelector('h2')?.textContent).toBe('Warden');
      expect(text).toContain('Rules only');
      expect(text).toContain('Nothing is being watched right now.');
      expect(text).toContain('No investigations yet today.');
      expect(text).toContain('The Warden has not acted or blessed anything yet.');
      expect(text).toContain('none reported');
      expect(view.container.querySelector('details summary')?.textContent).toBe('How the Warden works');
      expect(button(view.container, 'Sweep now').disabled).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it('should never show a Needs you heading, the old savings box or an Investigate button', async () => {
    // Arrange
    const view = await render({
      status: ready(actionsStatus()),
      attention: ready(
        wardenAttention({ outcome: 'items', items: [attentionItem({ sessionId: 'sess-a', source: 'question' })] }),
      ),
      sessions: known,
    });
    try {
      // Act
      const headings = [...view.container.querySelectorAll('h2, h3')].map(node => node.textContent ?? '');
      const text = view.container.textContent ?? '';

      // Assert
      expect(headings.join('|')).not.toContain('Needs you');
      expect(text).not.toContain('Needs you');
      expect(text).not.toContain('Investigate');
      expect(text).not.toContain('Today: ');
    } finally {
      await view.unmount();
    }
  });

  it('should disable Sweep while off', async () => {
    // Arrange
    const off = wardenStatus({ config: wardenConfig({ enabled: false }) });
    const view = await render({ status: ready(off) });
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(text).toContain('The Warden is off.');
      expect(button(view.container, 'Sweep now').disabled).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it('should show a sweeping button and a cap warning chip', async () => {
    // Arrange
    const capped = wardenStatus({
      config: wardenConfig({ layers: { jev: false, llm: true } }),
      triage: {
        jev: { configured: false, active: false, reason: 'configured' },
        llm: { configured: true, active: false, reason: 'investigation_cap' },
      },
    });
    const view = await render({ status: ready(capped), sweeping: true });
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(text).toContain('LLM cap hit — flags wait for you until midnight UTC');
      expect(button(view.container, 'Sweeping…').disabled).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it('should announce an ok notice as status and an error notice as an alert', async () => {
    // Arrange
    const ok = await render({ notice: { tone: 'ok', text: 'Swept: nothing flagged.' } });
    const err = await render({ notice: { tone: 'err', text: 'The sweep did not run: no' } });
    try {
      // Act
      const okNotice = [...ok.container.querySelectorAll('[role="status"]')].find(node =>
        node.textContent?.includes('Swept'),
      );
      const errNotice = [...err.container.querySelectorAll('[role="alert"]')].find(node =>
        node.textContent?.includes('did not run'),
      );

      // Assert
      expect(okNotice?.className).toContain('text-muted');
      expect(errNotice?.className).toContain('text-err');
    } finally {
      await ok.unmount();
      await err.unmount();
    }
  });

  it('should link to the Inbox with the notification count and route the click', async () => {
    // Arrange
    const attention = wardenAttention({
      outcome: 'items',
      items: [
        attentionItem({ id: 'a', sessionId: 'sess-a', source: 'question' }),
        attentionItem({ id: 'b', sessionId: 'sess-b', source: 'question' }),
      ],
    });
    const one = await render({
      attention: ready(wardenAttention({ outcome: 'items', items: [attentionItem({ sessionId: 'sess-a' })] })),
    });
    const two = await render({ attention: ready(attention) });
    try {
      // Act
      const link = must(two.container.querySelector<HTMLElement>('[data-warden-inbox="link"] a'), 'the inbox link');
      await interact(() => link.click());

      // Assert
      expect(link.textContent).toBe('2 Warden notifications in Inbox ›');
      expect(one.container.querySelector<HTMLElement>('[data-warden-inbox="link"] a')?.textContent).toBe(
        '1 Warden notification in Inbox ›',
      );
      expect(two.calls.navigations).toHaveLength(1);
    } finally {
      await one.unmount();
      await two.unmount();
    }
  });

  it('should say there are no notifications as plain text, not a link', async () => {
    // Arrange
    const view = await render({ attention: ready(wardenAttention({ outcome: 'clean-sweep' })) });
    try {
      // Act
      const line = must(view.container.querySelector('[data-warden-inbox="none"]'), 'the none line');

      // Assert
      expect(line.textContent).toBe('No Warden notifications');
      expect(line.querySelector('a')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('should warn instead of reporting none when the feed is degraded or no sweep has run', async () => {
    // Arrange
    const degraded = await render({
      attention: ready(wardenAttention({ outcome: 'degraded', wardenDegraded: { reason: 'boards unreadable' } })),
    });
    const noSweep = await render({ attention: ready(wardenAttention({ outcome: 'no-sweep' })) });
    try {
      // Act
      const lines = [degraded, noSweep].map(view => view.container.querySelector('[data-warden-inbox]'));

      // Assert
      for (const line of lines) {
        expect(line?.getAttribute('data-warden-inbox')).toBe('warning');
        expect(line?.textContent).toBe('Couldn’t count Warden notifications');
      }
    } finally {
      await degraded.unmount();
      await noSweep.unmount();
    }
  });
});

describe('WardenOverview stats', () => {
  it('should show today’s tiles with the actor split, and switch to the seven-day sums', async () => {
    // Arrange
    const view = await render({ status: ready(actionsStatus()) });
    try {
      // Act
      const today = Object.fromEntries(
        ['flagged', 'moved', 'cleared', 'stopped', 'asked'].map(key => [key, tileText(view.container, key)]),
      );
      await interact(() => button(view.container, '7 days').click());
      const week = Object.fromEntries(
        ['flagged', 'moved', 'cleared', 'stopped', 'asked'].map(key => [key, tileText(view.container, key)]),
      );

      // Assert
      expect(today['flagged']).toContain('7');
      expect(today['flagged']).toContain('Jev decided 6 · LLM investigated 2');
      expect(today['moved']).toContain('9');
      expect(today['moved']).toContain('Auto 3');
      expect(today['moved']).toContain('Jev 5');
      expect(today['moved']).toContain('LLM 1');
      expect(today['stopped']).toContain('LLM 1');
      expect(today['asked']).toContain('You 1');
      expect(week['flagged']).toContain('28');
      expect(week['flagged']).toContain('Jev decided 23 · LLM investigated 5');
      expect(week['moved']).toContain('18');
      expect(button(view.container, '7 days').getAttribute('aria-pressed')).toBe('true');
      expect(button(view.container, 'Today').getAttribute('aria-pressed')).toBe('false');
    } finally {
      await view.unmount();
    }
  });

  it('should say how many days a week covers when one has no record', async () => {
    // Arrange
    const view = await render({ status: ready(actionsStatus()) });
    try {
      // Act
      await interact(() => button(view.container, '7 days').click());

      // Assert
      expect(view.container.textContent).toContain('6 of 7 days recorded');
    } finally {
      await view.unmount();
    }
  });

  it('should show an unknown today as a dash, never a zero', async () => {
    // Arrange
    const noToday = wardenStatus({ history: [day('2026-07-30', { flags: 3 })] });
    const view = await render({ status: ready(noToday) });
    try {
      // Act
      const flagged = must(view.container.querySelector('[data-stat="flagged"]'), 'flagged');

      // Assert
      expect(flagged.textContent).toContain('—');
      expect(flagged.querySelector('[aria-label="Flagged: no record"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('should draw the per-day chart with a note for a day without a record', async () => {
    // Arrange
    const view = await render({ status: ready(actionsStatus()) });
    try {
      // Act
      const chart = must(view.container.querySelector('[data-analytics-chart]'), 'the chart');
      const text = chart.parentElement?.textContent ?? '';

      // Assert
      expect(text).toContain('Actions per day');
      expect(text).toContain('Auto');
      expect(text).toContain('Jev');
      expect(text).toContain('LLM');
      expect(text).toContain('Tue?');
      expect(text).toContain('A day marked ? has no record; it is not a quiet day.');
    } finally {
      await view.unmount();
    }
  });

  it('should fall back to recent figures, with no period switch and no chart, on a daemon without history', async () => {
    // Arrange
    const old = wardenStatus({
      savings: { day: '2026-07-31', flags: 5, jevDecisions: 4, jevSkips: 0, investigations: 1 },
      actions: [wardenAction({ sessionId: 'sess-a', at: '2026-07-31T11:00:00.000Z', detail: 'Asked it.' })],
    });
    const view = await render({ status: ready(old) });
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(view.container.querySelector('[role="toolbar"][aria-label="Stats period"]')).toBeNull();
      expect(text).toContain('Recent activity');
      expect(tileText(view.container, 'flagged')).toContain('5');
      expect(tileText(view.container, 'moved')).toContain('(recent)');
      expect(tileText(view.container, 'moved')).toContain('1');
      expect(view.container.querySelector('[data-analytics-chart]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('should draw a Jev spend bar that turns warn when paced', async () => {
    // Arrange
    const base = actionsStatus();
    const paced = wardenStatus({
      ...base,
      config: wardenConfig({ layers: { jev: true, llm: true } }),
      spend: {
        ...base.spend,
        jevUsd: 0.31,
        jevCapUsd: 0.5,
        capsPaced: ['jev'],
        pacedUntil: '2026-07-31T13:00:00.000Z',
      },
    });
    const view = await render({ status: ready(paced) });
    try {
      // Act
      const jev = must(view.container.querySelector('[data-layer="jev"]'), 'the Jev line');
      const bar = must(jev.querySelector('[role="progressbar"]'), 'the Jev bar');

      // Assert
      expect(jev.textContent).toContain('$0.31 of $0.50');
      expect(bar.getAttribute('aria-valuenow')).toBe('62');
      expect(bar.firstElementChild?.className).toContain('bg-warn');
    } finally {
      await view.unmount();
    }
  });
});

describe('WardenOverview recent actions', () => {
  it('should draw one flat line per action, newest first, with chips, actors and names', async () => {
    // Arrange
    const view = await render({ status: ready(actionsStatus()), sessions: known });
    try {
      // Act
      const list = rows(view.container);
      const first = must(list[0], 'the first row');

      // Assert
      expect(list).toHaveLength(4);
      expect(first.textContent).toContain('Maryah');
      expect(first.textContent).toContain('Moved');
      expect(first.textContent).toContain('Jev 96%');
      expect(first.textContent).toContain('Restarted its process; its terminal had closed.');
      expect(first.querySelector('.kt-panel')).toBeNull();
      expect(first.querySelector('[data-actor="jev"]')).not.toBeNull();
      expect(must(list[1], 'second').querySelector('[data-actor="llm"]')).not.toBeNull();
      expect(must(list[1], 'second').textContent).toContain('Stopped');
      expect(must(list[3], 'last').textContent).toContain('Cleared');
    } finally {
      await view.unmount();
    }
  });

  it('should show the investigator as warden-00002A, in upper-case hex', async () => {
    // Arrange
    const view = await render({ status: ready(actionsStatus()), sessions: known });
    try {
      // Act
      const llm = must(rows(view.container)[1], 'the LLM row');

      // Assert
      expect(llm.textContent).toContain('warden-00002A');
      expect(llm.querySelector('[data-actor="llm"]')?.getAttribute('title')).toBe('LLM · warden-00002A');
    } finally {
      await view.unmount();
    }
  });

  it('should fold consecutive identical repeats into one row with a count and list the times when expanded', async () => {
    // Arrange
    const view = await render({ status: ready(actionsStatus()), sessions: known });
    try {
      const grouped = must(rows(view.container)[2], 'the grouped row');

      // Act
      await interact(() => must(grouped.querySelector<HTMLElement>('button[aria-expanded]'), 'toggle').click());

      // Assert
      expect(grouped.textContent).toContain('×3');
      expect(grouped.textContent).toContain('2026-07-31 11:30 UTC');
      expect(grouped.textContent).toContain('2026-07-31 11:10 UTC');
    } finally {
      await view.unmount();
    }
  });

  it('should expand a row to show the full detail and collapse it again', async () => {
    // Arrange
    const view = await render({ status: ready(actionsStatus()), sessions: known });
    try {
      const row = must(rows(view.container)[0], 'the first row');
      const toggle = must(row.querySelector<HTMLButtonElement>('button[aria-expanded]'), 'toggle');
      const closed = toggle.getAttribute('aria-expanded');

      // Act
      await interact(() => toggle.click());
      const open = toggle.getAttribute('aria-expanded');
      const detail = row.textContent ?? '';
      await interact(() => toggle.click());

      // Assert
      expect(closed).toBe('false');
      expect(open).toBe('true');
      expect(detail).toContain('Jev’s reason: The terminal pane had closed.');
      expect(detail).toContain('Restarted');
      expect(detail).toContain('pane lost');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(row.textContent).not.toContain('Jev’s reason');
    } finally {
      await view.unmount();
    }
  });

  it('should narrow the list by actor and by action, and say so when nothing matches', async () => {
    // Arrange
    const view = await render({ status: ready(actionsStatus()), sessions: known });
    const filter = (group: string, label: string) =>
      must(
        [...view.container.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] button`)].find(
          node => node.textContent === label,
        ),
        `${group} ${label}`,
      );
    try {
      // Act
      await interact(() => filter('Filter by actor', 'Jev').click());
      const jev = rows(view.container).length;
      await interact(() => filter('Filter by action', 'Cleared').click());
      const jevCleared = rows(view.container).length;
      await interact(() => filter('Filter by action', 'Stopped').click());
      const none = view.container.textContent ?? '';
      await interact(() => filter('Filter by actor', 'All').click());
      const stopped = rows(view.container).length;

      // Assert
      expect(jev).toBe(2);
      expect(jevCleared).toBe(1);
      expect(none).toContain('No actions match');
      expect(stopped).toBe(1);
      expect(filter('Filter by action', 'Stopped').getAttribute('aria-pressed')).toBe('true');
    } finally {
      await view.unmount();
    }
  });

  it('should show twenty rows, then reveal the rest with Show more', async () => {
    // Arrange
    const many = wardenStatus({
      actions: Array.from({ length: 24 }, (_, index) =>
        wardenAction({
          sessionId: `sess-${index}`,
          at: new Date(NOW - (index + 1) * 60_000).toISOString(),
          detail: `Nudged number ${index}.`,
        }),
      ),
    });
    const view = await render({ status: ready(many) });
    try {
      // Act
      const before = rows(view.container).length;
      await interact(() => button(view.container, 'Show more (4)').click());

      // Assert
      expect(before).toBe(20);
      expect(rows(view.container)).toHaveLength(24);
      expect(view.container.textContent).not.toContain('Show more');
    } finally {
      await view.unmount();
    }
  });

  it('should open the report from the icon button with the ferret, path and time', async () => {
    // Arrange
    const view = await render({ status: ready(actionsStatus()), sessions: known });
    try {
      const llm = must(rows(view.container)[1], 'the LLM row');

      // Act
      await interact(() => must(llm.querySelector<HTMLElement>('button[aria-label="Open report"]'), 'report').click());

      // Assert
      expect(view.calls.reports).toHaveLength(1);
      expect(view.calls.reports[0]).toMatchObject({ sessionId: 'sess-b', reportPath: 'reports/stop.md' });
      expect(rows(view.container).filter(row => row.querySelector('[aria-label="Open report"]'))).toHaveLength(1);
    } finally {
      await view.unmount();
    }
  });

  it('should link the ferret’s name to its session', async () => {
    // Arrange
    const view = await render({ status: ready(actionsStatus()), sessions: known });
    try {
      // Act
      await interact(() => must(must(rows(view.container)[0], 'row').querySelector<HTMLElement>('a'), 'link').click());

      // Assert
      expect(view.calls.navigations).toEqual(['/d/daemon-a/session/sess-a']);
    } finally {
      await view.unmount();
    }
  });
});

describe('WardenOverview investigations and watching', () => {
  const status = (): WardenStatusView =>
    wardenStatus({
      lastSweepAt: '2026-07-31T11:59:00.000Z',
      anomalies: [wardenAnomaly({ sessionId: 'sess-a', teammate: 'maryah', since: '2026-07-31T11:40:00.000Z' })],
      investigations: [
        wardenInvestigation({
          id: 'done-1',
          state: 'done',
          targetSession: 'sess-b',
          verdict: 'cleared',
          reportPath: 'reports/done.md',
          finishedAt: '2026-07-31T11:30:00.000Z',
          costUsd: 0.31,
          wardenName: 'warden-00002a',
        }),
        wardenInvestigation({
          id: 'run-1',
          state: 'running',
          targetSession: 'sess-a',
          startedAt: '2026-07-31T11:55:00.000Z',
        }),
      ],
      failover: wardenFailover({
        accounts: [
          { agent: 'claude-default', eligible: true },
          { agent: 'codex-default', eligible: false, reason: 'at limit' },
        ],
        lastSelection: { agent: 'claude-default', policy: 'fallback', at: '2026-07-31T11:00:00.000Z', reason: 'x' },
      }),
    });

  it('should name an investigator warden-00002A, fall back for an unnamed one and open its report', async () => {
    // Arrange
    const view = await render({ status: ready(status()), sessions: known });
    try {
      const named = must(view.container.querySelector('[data-warden-investigation="investigation:done-1"]'), 'named');
      const unnamed = must(
        view.container.querySelector('[data-warden-investigation="investigation:run-1"]'),
        'unnamed',
      );

      // Act
      await interact(() =>
        must(named.querySelector<HTMLElement>('button[aria-label="Open report"]'), 'report').click(),
      );

      // Assert
      expect(named.textContent).toContain('warden-00002A');
      expect(named.textContent).toContain('Marin');
      expect(named.textContent).toContain('$0.31');
      expect(unnamed.textContent).toContain('Investigation');
      expect(unnamed.textContent).toContain('investigating');
      expect(view.calls.reports.map(target => target.reportPath)).toEqual(['reports/done.md']);
    } finally {
      await view.unmount();
    }
  });

  it('should list what is being watched, offer Leave it longer only with a handler, and show the accounts', async () => {
    // Arrange
    const withLeave = await render({
      status: ready(status()),
      sessions: known,
      onLeave: (sessionId, duration) => withLeaveCalls.push(`${sessionId}:${duration}`),
    });
    const withoutLeave = await render({ status: ready(status()), sessions: known });
    const withLeaveCalls: string[] = [];
    try {
      // Act
      const row = must(withLeave.container.querySelector('[data-warden-row="watch:sess-a"]'), 'watch row');
      const toggle = must(
        [...row.querySelectorAll('button')].find(item => item.textContent === 'Leave it longer…'),
        'leave toggle',
      );
      const closedBefore = toggle.getAttribute('aria-expanded');
      await interact(() => toggle.click());
      const openAfter = toggle.getAttribute('aria-expanded');
      const choice = must(
        [...withLeave.container.querySelectorAll('fieldset button')].find(item => item.textContent === 'For 4 hours'),
        'choice',
      ) as HTMLButtonElement;
      await interact(() => choice.click());
      const text = withLeave.container.textContent ?? '';

      // Assert
      expect(row.textContent).toContain('Maryah');
      expect(row.textContent).toContain('pane lost');
      expect(closedBefore).toBe('false');
      expect(openAfter).toBe('true');
      expect(withLeaveCalls).toEqual(['sess-a:4h']);
      expect(withLeave.container.querySelector('fieldset')).toBeNull();
      expect(withoutLeave.container.textContent).not.toContain('Leave it longer');
      expect(text).toContain('claude-default · in use');
      expect(text).toContain('codex-default · at limit');
    } finally {
      await withLeave.unmount();
      await withoutLeave.unmount();
    }
  });

  it('should work without a navigator and show an unknown session by its short id', async () => {
    // Arrange
    const unknown = wardenStatus({ anomalies: [wardenAnomaly({ sessionId: 'sess-bare' })] });
    const view = await render({ status: ready(unknown), onNavigate: undefined });
    try {
      const row = must(view.container.querySelector('[data-warden-row="watch:sess-bare"]'), 'row');

      // Act
      await interact(() => must(row.querySelector<HTMLElement>('a'), 'the row link').click());

      // Assert
      expect(row.textContent).toContain('sess-bar');
      expect(view.calls.navigations).toEqual([]);
    } finally {
      await view.unmount();
    }
  });

  it('should show a system callsign as warden-00002A, never title-cased', async () => {
    // Arrange
    const system = sessionView('sess-sys', { config: { teammate: 'warden-00002a' } });
    const view = await render({
      status: ready(wardenStatus({ anomalies: [wardenAnomaly({ sessionId: 'sess-sys', teammate: 'warden-00002a' })] })),
      sessions: [system],
    });
    try {
      // Act
      const row = must(view.container.querySelector('[data-warden-row="watch:sess-sys"]'), 'row');

      // Assert
      expect(row.textContent).toContain('warden-00002A');
      expect(row.textContent).not.toContain('Warden-00002a');
    } finally {
      await view.unmount();
    }
  });
});

describe('WardenChipBadge', () => {
  it('spins beside the label only while the chip is busy', async () => {
    const busy = await mount(<WardenChipBadge chip={{ label: 'investigating', tone: 'accent', busy: true }} />);
    const idle = await mount(<WardenChipBadge chip={{ label: 'flagged', tone: 'accent' }} />);
    try {
      expect(busy.container.textContent).toBe('investigating');
      expect(busy.container.querySelector('svg.animate-spin') === null).toBe(false);
      expect(idle.container.textContent).toBe('flagged');
      expect(idle.container.querySelector('svg')).toBeNull();
    } finally {
      await busy.unmount();
      await idle.unmount();
    }
  });

  it('is sentence case, not upper-case letter-spaced', async () => {
    const view = await mount(<WardenChipBadge chip={{ label: 'Moved', tone: 'ok' }} />);
    try {
      expect(view.container.firstElementChild?.className).toContain('normal-case');
    } finally {
      await view.unmount();
    }
  });
});
