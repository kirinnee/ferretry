import { describe, expect, it } from 'bun:test';
import type { WardenAttentionView, WardenStatusView } from '@ferretry/protocol';

import {
  WardenChipBadge,
  WardenOverview,
  type WardenOverviewProps,
} from '../../../src/features/warden/warden-overview.tsx';
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
  readonly investigations: string[];
  readonly reports: string[];
  readonly navigations: string[];
}

const props = (overrides: Partial<WardenOverviewProps> = {}): { props: WardenOverviewProps; calls: Calls } => {
  const calls: Calls = { sweeps: [], investigations: [], reports: [], navigations: [] };
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
      onInvestigate: sessionId => calls.investigations.push(sessionId),
      onOpenReport: row => calls.reports.push(row.reportPath),
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

describe('WardenOverview', () => {
  it('should say it is reading while the status and the feed are loading', async () => {
    // Arrange
    const view = await render({ status: { status: 'loading' }, attention: { status: 'loading' } });
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(text).toContain('Reading the Warden’s status…');
      expect(text).toContain('Checking who needs you…');
      expect(text).not.toContain('Watching');
    } finally {
      await view.unmount();
    }
  });

  it('should call a failed status and a failed feed unknown rather than all clear', async () => {
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
      expect(text).toContain('Can’t say who needs you');
      expect(text).toContain('feed refused. Treat this as unknown, not as all clear.');
    } finally {
      await view.unmount();
    }
  });

  it('should keep a stale status and a stale feed on screen and say so', async () => {
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
      expect(text).toContain('Can’t refresh who needs you (offline).');
      expect(text).toContain('that check is stale. Not an all-clear.');
    } finally {
      await view.unmount();
    }
  });

  it('should show the status line, savings line and how-it-works when ready', async () => {
    // Arrange
    const view = await render();
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(text).toContain('Rules only');
      expect(text).toContain('Today: 0 flags shown to you · no AI · $0.00');
      expect(text).toContain('How it works:');
      expect(text).toContain('Nothing is waiting on you right now.');
      expect(text).toContain('Nothing is being watched right now.');
      expect(text).toContain('No investigations yet today.');
      expect(text).toContain('The Warden has not acted or blessed anything yet.');
      expect(text).toContain('none reported');
      expect(button(view.container, 'Sweep now').disabled).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it('should disable Sweep while off, drop the savings line and show no warning chip', async () => {
    // Arrange
    const off = wardenStatus({ config: wardenConfig({ enabled: false }) });
    const view = await render({ status: ready(off) });
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(text).toContain('The Warden is off.');
      expect(text).not.toContain('Today:');
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

  it('should say every empty outcome honestly and list the feed caveats', async () => {
    // Arrange
    const degraded: WardenAttentionView = wardenAttention({
      outcome: 'degraded',
      wardenDegraded: { reason: 'boards unreadable' },
      boardsWithParseErrors: [{ sessionId: 's1', parseErrors: 1 }],
      verdictCoverage: { limit: 20, truncated: true },
    });
    const twoBoards = wardenAttention({
      outcome: 'no-sweep',
      boardsWithParseErrors: [
        { sessionId: 's1', parseErrors: 1 },
        { sessionId: 's2', parseErrors: 3 },
      ],
    });
    const one = await render({ attention: ready(degraded) });
    const two = await render({ attention: ready(twoBoards) });
    try {
      // Act
      const oneText = one.container.textContent ?? '';
      const twoText = two.container.textContent ?? '';

      // Assert
      expect(oneText).toContain('Warden degraded: boards unreadable');
      expect(oneText).toContain('1 attention board could not be read, so items on it are missing here.');
      expect(oneText).toContain('Only the recent 20 verdicts were read');
      expect(oneText).toContain('The check is incomplete, so this is not an all-clear.');
      expect(twoText).toContain('2 attention boards could not be read, so items on them are missing here.');
      expect(twoText).toContain('No sweep has run yet, so nobody has been checked.');
    } finally {
      await one.unmount();
      await two.unmount();
    }
  });

  it('should render rows with names, places, chips and actions, and route their buttons', async () => {
    // Arrange
    const known = sessionView('sess-known', {
      config: { teammate: 'maryah', label: 'Diene work', cwd: '/work/home-manager' },
    });
    const attention = wardenAttention({
      outcome: 'items',
      items: [
        attentionItem({ sessionId: 'sess-known', id: 'q', source: 'question' }),
        attentionItem({
          sessionId: 'sess-flag',
          id: 'f',
          source: 'warden-anomaly',
          anomalyKind: 'dead_monitor',
          teammate: 'kofi',
        }),
        attentionItem({
          sessionId: 'sess-busy',
          id: 'b',
          source: 'warden-anomaly',
          anomalyKind: 'sus_thinking',
          label: 'Busy label',
        }),
        attentionItem({
          sessionId: 'a-very-long-session-id',
          id: 'r',
          source: 'warden-action',
          judgement: { state: 'judged', verdict: 'killed', reason: 'loop', reportPath: 'reports/r.md' },
        }),
      ],
    });
    const status = wardenStatus({
      lastSweepAt: '2026-07-31T11:59:00.000Z',
      anomalies: [wardenAnomaly({ sessionId: 'sess-watch', teammate: 'marin', since: '2026-07-31T11:40:00.000Z' })],
      investigations: [
        wardenInvestigation({
          id: 'done-1',
          state: 'done',
          targetSession: 'sess-done',
          verdict: 'cleared',
          reportPath: 'reports/done.md',
          finishedAt: '2026-07-31T11:30:00.000Z',
        }),
      ],
      actions: [wardenAction({ sessionId: 'sess-act', reportPath: 'reports/act.md' })],
      failover: wardenFailover({
        accounts: [
          { agent: 'claude-default', eligible: true },
          { agent: 'codex-default', eligible: false, reason: 'at limit' },
        ],
        lastSelection: { agent: 'claude-default', policy: 'fallback', at: '2026-07-31T11:00:00.000Z', reason: 'x' },
      }),
    });
    const view = await render({
      status: ready(status),
      attention: ready(attention),
      sessions: [known],
      investigating: new Set(['sess-busy']),
    });
    try {
      const text = view.container.textContent ?? '';
      const knownRow = must(view.container.querySelector('[data-warden-row="needs:sess-known"]'), 'known row');

      // Act
      const investigates = [...view.container.querySelectorAll('button')].filter(node =>
        node.textContent?.includes('Investigate'),
      );
      await interact(() =>
        must(
          investigates.find(node => !node.disabled),
          'an idle Investigate',
        ).click(),
      );
      const reports = [...view.container.querySelectorAll('button')].filter(node => node.textContent === 'Report');
      for (const report of reports) await interact(() => report.click());
      await interact(() => must(knownRow.querySelector('a'), 'the row link').click());
      await interact(() => button(view.container, 'Sweep now').click());

      // Assert
      expect(knownRow.querySelector('[role="img"]')).not.toBeNull();
      expect(knownRow.textContent).toContain('Maryah');
      expect(knownRow.textContent).toContain('home-manager · Diene work');
      expect(text).toContain('Kofi');
      expect(text).toContain('Busy label');
      expect(text).toContain('a-very-l…');
      expect(text).toContain('Marin');
      expect(text).toContain('pane lost');
      expect(text).toContain('claude-default · in use');
      expect(text).toContain('codex-default · at limit');
      expect(investigates).toHaveLength(2);
      expect(investigates.filter(node => node.disabled)).toHaveLength(1);
      expect(view.calls.investigations).toEqual(['sess-flag']);
      expect(view.calls.reports).toEqual(['reports/r.md', 'reports/done.md', 'reports/act.md']);
      expect(view.calls.navigations).toEqual(['/d/daemon-a/session/sess-known']);
      expect(view.calls.sweeps).toEqual([1]);
    } finally {
      await view.unmount();
    }
  });

  it('should leave the place line out for a known session without folder or label, and work without a navigator', async () => {
    // Arrange
    const bare = sessionView('sess-bare', { config: { cwd: '/' } });
    const status: WardenStatusView = wardenStatus({
      anomalies: [wardenAnomaly({ sessionId: 'sess-bare' })],
    });
    const view = await render({ status: ready(status), sessions: [bare], onNavigate: undefined });
    try {
      const row = must(view.container.querySelector('[data-warden-row="watch:sess-bare"]'), 'bare row');

      // Act
      await interact(() => must(row.querySelector('a'), 'the row link').click());

      // Assert
      expect(row.querySelectorAll('.text-faint')).toHaveLength(0);
      expect(row.textContent).toContain('Session sess-bare');
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
});
