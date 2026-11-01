import { describe, expect, it } from 'bun:test';
import type { SessionView, WardenJevBefore, WardenStatusView } from '@ferretry/protocol';

import type { WardenReportTarget } from '../../../src/features/warden/warden-overview-model.ts';
import { RecentTriggers } from '../../../src/features/warden/warden-trigger-rows.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';
import { wardenAction, wardenInvestigation, wardenStatus } from '../../support/warden.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const connection = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'tok' });

const known: readonly SessionView[] = [
  sessionView('sess-a', { config: { teammate: 'maryah' } }),
  sessionView('sess-b', { config: { teammate: 'marin' } }),
  sessionView('sess-c', { config: { teammate: 'kamila' } }),
];

const render = async (status: WardenStatusView, sessions: readonly SessionView[] = known) => {
  const reports: WardenReportTarget[] = [];
  const navigations: string[] = [];
  const view = await mount(
    <RecentTriggers
      connection={connection}
      status={status}
      sessions={new Map(sessions.map(session => [session.config.id, session]))}
      now={NOW}
      onNavigate={to => navigations.push(to)}
      onOpenReport={target => reports.push(target)}
    />,
  );
  return { ...view, reports, navigations };
};

const rows = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-warden-trigger]'),
];
const row = (container: HTMLElement, index: number): HTMLElement => must(rows(container)[index], `row ${index}`);
const toggle = (item: HTMLElement): HTMLButtonElement =>
  must(item.querySelector<HTMLButtonElement>('button[aria-expanded]'), 'the toggle');

const jev: WardenJevBefore = { verdict: 'handed_on', why: 'unsure', at: at(60), confidence: 0.2, costUsd: 0.0041 };

const mixed = (): WardenStatusView =>
  wardenStatus({
    actions: [
      wardenAction({
        sessionId: 'sess-a',
        at: at(10),
        action: 'failover',
        by: 'warden',
        actor: 'auto',
        agent: 'claude-b',
        fromAgent: 'claude-a',
        anomalyKind: 'dead_monitor',
        detail: 'Moved it.',
      }),
      wardenAction({
        sessionId: 'sess-b',
        at: at(50),
        action: 'stop',
        by: 'warden',
        actor: 'llm',
        investigator: 'warden-00002a',
        reportPath: 'reports/stop.md',
        anomalyKind: 'sus_thinking',
        detail: 'Stopped it after a long loop.',
        jev,
      }),
      wardenAction({ sessionId: 'sess-c', at: at(30), action: 'nudge', detail: 'Asked it to report.' }),
      wardenAction({ sessionId: 'sess-c', at: at(20), action: 'nudge', detail: 'Asked it to report.' }),
      wardenAction({ sessionId: 'sess-c', at: at(40), action: 'nudge', detail: 'Asked it to report.' }),
    ],
    investigations: [
      wardenInvestigation({
        id: 'inv-1',
        state: 'done',
        targetSession: 'sess-b',
        startedAt: at(58),
        finishedAt: at(52),
        reportPath: 'reports/stop.md',
        wardenName: 'warden-00002a',
        agent: 'claude-default',
        model: 'sonnet',
        anomalyKind: 'sus_thinking',
        verdict: 'killed',
        jev,
      }),
    ],
  });

describe('RecentTriggers', () => {
  it('should say nothing was flagged when there is nothing, and show no filters result', async () => {
    // Arrange
    const view = await render(wardenStatus());
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(text).toContain('Recent triggers');
      expect(text).toContain('The Warden has not flagged or acted on any ferret yet.');
      expect(rows(view.container)).toHaveLength(0);
    } finally {
      await view.unmount();
    }
  });

  it('should draw one row per trigger with when, ferret, flag, who, runtime and result', async () => {
    // Arrange
    const view = await render(mixed());
    try {
      // Act
      const list = rows(view.container);
      const moved = row(view.container, 0);
      const llm = row(view.container, 2);

      // Assert
      expect(list).toHaveLength(3);
      expect(moved.textContent).toContain('Maryah');
      expect(moved.textContent).toContain('Moved login claude-a → claude-b');
      expect(moved.querySelector('[data-warden-who="rule"]')).not.toBeNull();
      expect(moved.querySelector('[data-warden-result="moved"]')).not.toBeNull();
      expect(llm.querySelector('[data-warden-who="jev_llm"]')?.textContent).toBe('Jev → LLM');
      expect(llm.textContent).toContain('claude-default · sonnet');
      expect(llm.textContent).toContain('Stopped');
      expect(view.container.querySelector('[data-warden-trigger-head]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('should fold identical repeats into one row with a count', async () => {
    // Arrange
    const view = await render(mixed());
    try {
      // Act
      const folded = row(view.container, 1);

      // Assert
      expect(folded.textContent).toContain('×3');
      expect(folded.getAttribute('data-warden-trigger')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('should show the task title next to the callsign when the session has one', async () => {
    // Arrange
    const titled = sessionView('sess-a', { config: { teammate: 'maryah', name: 'Fix the login bug' } });
    const view = await render(mixed(), [titled]);
    try {
      // Act
      const task = must(row(view.container, 0).querySelector('[data-warden-task]'), 'the task');

      // Assert
      expect(task.textContent).toBe('Fix the login bug');
    } finally {
      await view.unmount();
    }
  });

  it('should expand a row to its own timeline and collapse it again, from the row and from the chevron', async () => {
    // Arrange
    const view = await render(mixed());
    try {
      const llm = row(view.container, 2);
      const chevron = toggle(llm);
      const closed = chevron.getAttribute('aria-expanded');

      // Act
      await interact(() => chevron.click());
      const open = chevron.getAttribute('aria-expanded');
      const kinds = [...llm.querySelectorAll('[data-warden-step]')].map(step => step.getAttribute('data-warden-step'));
      const label = chevron.getAttribute('aria-label');
      await interact(() => chevron.click());
      const afterChevron = chevron.getAttribute('aria-expanded');
      await interact(() => must(llm.querySelector<HTMLElement>('[data-warden-who]'), 'who').click());
      const afterRow = chevron.getAttribute('aria-expanded');

      // Assert
      expect(closed).toBe('false');
      expect(open).toBe('true');
      expect(label).toBe('Hide timeline');
      expect(kinds).toEqual(['flag', 'jev', 'llm', 'act']);
      expect(afterChevron).toBe('false');
      expect(afterRow).toBe('true');
      expect(llm.textContent).toContain('$0.0041');
    } finally {
      await view.unmount();
    }
  });

  it('should not toggle when the ferret link is clicked, and route to the session', async () => {
    // Arrange
    const view = await render(mixed());
    try {
      const moved = row(view.container, 0);

      // Act
      await interact(() => must(moved.querySelector<HTMLElement>('a'), 'link').click());

      // Assert
      expect(view.navigations).toEqual(['/d/daemon-a/session/sess-a']);
      expect(toggle(moved).getAttribute('aria-expanded')).toBe('false');
    } finally {
      await view.unmount();
    }
  });

  it('should open the report from the row button and from the timeline step', async () => {
    // Arrange
    const view = await render(mixed());
    try {
      const llm = row(view.container, 2);

      // Act
      await interact(() => must(llm.querySelector<HTMLElement>('button[aria-label="Open report"]'), 'report').click());
      await interact(() => toggle(llm).click());
      const read = must(
        [...llm.querySelectorAll('button')].find(button => button.textContent === 'Read report'),
        'Read report',
      );
      await interact(() => read.click());

      // Assert
      expect(view.reports).toHaveLength(2);
      expect(view.reports[0]).toMatchObject({ sessionId: 'sess-b', reportPath: 'reports/stop.md' });
      expect(view.reports[1]).toEqual(view.reports[0] as WardenReportTarget);
      expect(view.reports[0]?.jev).toContain('Jev');
      expect(rows(view.container).filter(item => item.querySelector('[aria-label="Open report"]'))).toHaveLength(1);
    } finally {
      await view.unmount();
    }
  });

  it('should send a report target without a Jev line when the trigger has none', async () => {
    // Arrange
    const view = await render(
      wardenStatus({
        investigations: [
          wardenInvestigation({
            id: 'inv-2',
            state: 'done',
            targetSession: 'sess-a',
            finishedAt: at(5),
            reportPath: 'reports/x.md',
            verdict: 'cleared',
          }),
        ],
      }),
    );
    try {
      // Act
      await interact(() =>
        must(view.container.querySelector<HTMLElement>('button[aria-label="Open report"]'), 'report').click(),
      );

      // Assert
      expect(view.reports).toHaveLength(1);
      expect(view.reports[0]?.reportPath).toBe('reports/x.md');
    } finally {
      await view.unmount();
    }
  });

  it('should narrow by who and by result, and say so when nothing matches', async () => {
    // Arrange
    const view = await render(mixed());
    const who = (label: string) =>
      must(
        [...view.container.querySelectorAll<HTMLButtonElement>('[aria-label="Filter by who handled it"] button')].find(
          node => node.textContent === label,
        ),
        `who ${label}`,
      );
    const select = must(view.container.querySelector<HTMLSelectElement>('select'), 'result select');
    try {
      // Act
      await interact(() => who('Rule').click());
      const rule = rows(view.container).length;
      await interact(() => who('All').click());
      await interact(() => {
        select.value = 'stopped';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const stopped = rows(view.container).length;
      await interact(() => who('Rule').click());
      const none = view.container.textContent ?? '';

      // Assert
      expect(rule).toBe(2);
      expect(stopped).toBe(1);
      expect(none).toContain('No triggers match');
      expect(who('Rule').getAttribute('aria-pressed')).toBe('true');
    } finally {
      await view.unmount();
    }
  });

  it('should show a held row with its reason and a busy chip while investigating', async () => {
    // Arrange
    const view = await render(
      wardenStatus({
        actions: [
          wardenAction({ sessionId: 'sess-a', at: at(5), action: 'stop', outcome: 'held', detail: 'Waiting for you.' }),
        ],
        investigations: [
          wardenInvestigation({ id: 'run', state: 'running', targetSession: 'sess-b', startedAt: at(2) }),
        ],
      }),
    );
    try {
      // Act
      const held = must(view.container.querySelector('[data-warden-result="held"]'), 'held');
      const busy = must(view.container.querySelector('[data-warden-result="working"]'), 'working');

      // Assert
      expect(held.textContent).toContain('Waiting for you.');
      expect(busy.textContent).toContain('Investigating');
    } finally {
      await view.unmount();
    }
  });

  it('should show twenty rows, then reveal the rest with Show more', async () => {
    // Arrange
    const many = wardenStatus({
      actions: Array.from({ length: 24 }, (_, index) =>
        wardenAction({ sessionId: `sess-${index}`, at: at(index + 1), detail: `Nudged number ${index}.` }),
      ),
    });
    const view = await render(many, []);
    try {
      // Act
      const before = rows(view.container).length;
      const more = must(
        [...view.container.querySelectorAll('button')].find(item => item.textContent?.includes('Show more (4)')),
        'Show more',
      );
      await interact(() => more.click());

      // Assert
      expect(before).toBe(20);
      expect(rows(view.container)).toHaveLength(24);
      expect(view.container.textContent).not.toContain('Show more');
    } finally {
      await view.unmount();
    }
  });
});
