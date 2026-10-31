import { describe, expect, it } from 'bun:test';
import type { WardenDayStats } from '@ferretry/protocol';
import { WardenActionStats } from '../../../src/features/warden/warden-action-stats.tsx';
import { interact, mount, must } from '../../support/dom.ts';
import { wardenStatus } from '../../support/warden.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const NONE = { auto: 0, jev: 0, llm: 0 };

const day = (date: string, extra: Partial<WardenDayStats> = {}): WardenDayStats => ({
  day: date,
  flags: 0,
  jevDecisions: 0,
  investigations: 0,
  jevUsd: 0,
  investigationUsd: 0,
  moved: NONE,
  cleared: NONE,
  stopped: NONE,
  asked: NONE,
  ...extra,
});

const TALLIED = wardenStatus({
  history: [
    day('2026-07-31', {
      acts: [
        { action: 'revive', outcome: 'done', auto: 2, jev: 1, llm: 0 },
        { action: 'nudge', outcome: 'done', auto: 0, jev: 4, llm: 0 },
      ],
      reviveResults: { progressed: { auto: 2, jev: 0, llm: 0 }, stalled: { auto: 0, jev: 1, llm: 0 } },
    }),
  ],
});

describe('WardenActionStats', () => {
  it('should show revives split by who decided them, and the rate they took', async () => {
    // Arrange
    const view = await mount(<WardenActionStats status={TALLIED} now={NOW} />);
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(text).toContain('Auto 2');
      expect(text).toContain('Jev 1');
      expect(text).toContain('Revives that worked:67%');
      expect(text).toContain('2 of 3 got moving within 10 minutes');
    } finally {
      await view.unmount();
    }
  });

  it('should draw nothing when the daemon tallied no day, rather than a block of zeros', async () => {
    // Arrange
    const view = await mount(<WardenActionStats status={wardenStatus({ history: [day('2026-07-31')] })} now={NOW} />);
    try {
      // Assert
      expect(view.container.innerHTML).toBe('');
    } finally {
      await view.unmount();
    }
  });

  it('should switch the chart to another action when its filter is pressed', async () => {
    // Arrange
    const view = await mount(<WardenActionStats status={TALLIED} now={NOW} />);
    try {
      const nudged = must(
        [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Nudged'),
        'Nudged filter',
      );

      // Act
      await interact(() => nudged.click());

      // Assert
      expect(nudged.getAttribute('aria-pressed')).toBe('true');
      expect(view.container.textContent).toContain('Nudged per day');
    } finally {
      await view.unmount();
    }
  });
});
