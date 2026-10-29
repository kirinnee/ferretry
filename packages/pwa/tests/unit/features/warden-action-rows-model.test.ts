import { describe, expect, it } from 'bun:test';
import {
  ACTIONS_PAGE,
  actionRows,
  actionTotal,
  filterActionRows,
  NO_FILTERS,
  pageActionRows,
} from '../../../src/features/warden/warden-action-rows-model.ts';
import { wardenAction, wardenStatus } from '../../support/warden.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const rowsOf = (...actions: ReturnType<typeof wardenAction>[]) => actionRows(wardenStatus({ actions }), NOW);

describe('actionRows grouping', () => {
  it('should fold consecutive identical actions into one ×N row, newest time first', () => {
    // Arrange
    const status = wardenStatus({
      actions: [
        wardenAction({ at: at(30), by: 'jev' }),
        wardenAction({ at: at(10), by: 'jev' }),
        wardenAction({ at: at(20), by: 'jev' }),
      ],
    });

    // Act
    const rows = actionRows(status, NOW);

    // Assert
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
    expect(rows[0]?.times.map(time => time.compact)).toEqual(['10m', '20m', '30m']);
    expect(rows[0]?.times[0]?.full).toBeTruthy();
  });

  it('should keep the same action returning after something else as a new row', () => {
    // Arrange
    const actions = [
      wardenAction({ at: at(40), by: 'jev', action: 'nudge' }),
      wardenAction({ at: at(30), by: 'jev', action: 'stop', detail: 'Stopped it.' }),
      wardenAction({ at: at(20), by: 'jev', action: 'nudge' }),
    ];

    // Act
    const rows = rowsOf(...actions);

    // Assert
    expect(rows.map(row => row.count)).toEqual([1, 1, 1]);
  });

  it('should break a group when the reason differs', () => {
    // Arrange
    const actions = [
      wardenAction({ at: at(30), detail: 'Asked it to report its blocker.' }),
      wardenAction({ at: at(20), detail: 'Asked it to continue.' }),
      wardenAction({ at: at(10), detail: 'Asked it to continue.' }),
    ];

    // Act
    const rows = rowsOf(...actions);

    // Assert
    expect(rows.map(row => [row.reason, row.count])).toEqual([
      ['Asked it to continue.', 2],
      ['Asked it to report its blocker.', 1],
    ]);
  });

  it('should not fold the same action on different ferrets or by different actors', () => {
    // Arrange
    const actions = [
      wardenAction({ at: at(30), sessionId: 'a' }),
      wardenAction({ at: at(20), sessionId: 'b' }),
      wardenAction({ at: at(10), sessionId: 'b', by: 'jev' }),
    ];

    // Act / Assert
    expect(rowsOf(...actions)).toHaveLength(3);
  });

  it('should sort newest first whatever order the daemon sent', () => {
    // Arrange
    const actions = [wardenAction({ at: at(5), sessionId: 'new' }), wardenAction({ at: at(50), sessionId: 'old' })];

    // Act / Assert
    expect(rowsOf(...actions.reverse()).map(row => row.sessionId)).toEqual(['new', 'old']);
  });

  it('should count repeats in the total', () => {
    // Arrange
    const rows = rowsOf(
      wardenAction({ at: at(3) }),
      wardenAction({ at: at(2) }),
      wardenAction({ at: at(1), sessionId: 'x' }),
    );

    // Act / Assert
    expect(rows).toHaveLength(2);
    expect(actionTotal(rows)).toBe(3);
  });
});

describe('row chips and labels', () => {
  it('should chip each outcome in sentence case with its tone', () => {
    // Arrange
    const actions = [
      wardenAction({ at: at(5), action: 'nudge' }),
      wardenAction({ at: at(4), action: 'bless', sessionId: 'b' }),
      wardenAction({ at: at(3), action: 'stop', sessionId: 'c' }),
      wardenAction({ at: at(2), action: 'nudge', outcome: 'held', sessionId: 'd' }),
    ];

    // Act
    const chips = rowsOf(...actions).map(row => [row.chip.label, row.chip.tone, row.outcome]);

    // Assert
    expect(chips).toEqual([
      ['Asked', 'warn', 'asked'],
      ['Stopped', 'err', 'stopped'],
      ['Cleared', 'pend', 'cleared'],
      ['Moved', 'ok', 'moved'],
    ]);
  });

  it('should show a failed attempt as Failed and a leftover browser as Closed, neither with an outcome', () => {
    // Arrange
    const actions = [
      wardenAction({ at: at(2), action: 'restart', outcome: 'failed', sessionId: 'a' }),
      wardenAction({ at: at(1), action: 'close_leftover', sessionId: 'b' }),
    ];

    // Act
    const [closed, failed] = rowsOf(...actions);

    // Assert
    expect(failed).toMatchObject({
      chip: { label: 'Failed', tone: 'err' },
      failed: true,
      outcome: undefined,
      verb: 'Restarted',
    });
    expect(closed).toMatchObject({ chip: { label: 'Closed', tone: 'pend' }, failed: false, outcome: undefined });
    expect(closed?.verb).toBe('Closed a leftover browser');
  });

  it('should word each actor, with Jev’s confidence only on Jev', () => {
    // Arrange
    const actions = [
      wardenAction({ at: at(5), by: 'jev', confidence: 0.96, sessionId: 'a' }),
      wardenAction({ at: at(4), by: 'jev', sessionId: 'b' }),
      wardenAction({ at: at(3), by: 'owner', sessionId: 'c' }),
      wardenAction({ at: at(2), by: 'warden', sessionId: 'd' }),
      wardenAction({ at: at(1), by: 'warden', reportPath: 'reports/x.md', confidence: 0.5, sessionId: 'e' }),
    ];

    // Act
    const labels = rowsOf(...actions).map(row => [row.actor, row.actorLabel]);

    // Assert
    expect(labels).toEqual([
      ['llm', 'LLM'],
      ['auto', 'Auto'],
      ['owner', 'You'],
      ['jev', 'Jev'],
      ['jev', 'Jev 96%'],
    ]);
  });

  it('should name the investigator in its display form and put it in the actor title', () => {
    // Arrange
    const action = wardenAction({ at: at(1), actor: 'llm', investigator: 'warden-00002a', reportPath: 'reports/x.md' });

    // Act
    const [row] = rowsOf(action);

    // Assert
    expect(row).toMatchObject({
      actor: 'llm',
      actorLabel: 'LLM',
      investigator: 'warden-00002A',
      actorTitle: 'LLM · warden-00002A',
      reportPath: 'reports/x.md',
    });
  });

  it('should leave the investigator off when nobody investigated', () => {
    // Arrange / Act
    const [row] = rowsOf(wardenAction({ at: at(1), by: 'jev', confidence: 0.9 }));

    // Assert
    expect(row?.investigator).toBeUndefined();
    expect(row?.actorTitle).toBe('Jev 90%');
  });

  it('should prefer the explicit actor over the old by field', () => {
    // Arrange / Act
    const [row] = rowsOf(wardenAction({ at: at(1), by: 'warden', actor: 'jev' }));

    // Assert
    expect(row?.actor).toBe('jev');
  });

  it('should carry Jev’s own reason only when it adds to the line', () => {
    // Arrange
    const actions = [
      wardenAction({ at: at(2), by: 'jev', detail: 'Same words.', reason: 'Same words.', sessionId: 'a' }),
      wardenAction({ at: at(1), by: 'jev', detail: 'Short.', reason: 'The longer thinking.', sessionId: 'b' }),
    ];

    // Act
    const [added, same] = rowsOf(...actions);

    // Assert
    expect(added?.jevReason).toBe('The longer thinking.');
    expect(same?.jevReason).toBeUndefined();
  });

  it('should carry the failover target, the anomaly and the verb', () => {
    // Arrange
    const action = wardenAction({ at: at(1), action: 'failover', agent: 'claude-b', anomalyKind: 'agent_frozen' });

    // Act
    const [row] = rowsOf(action);

    // Assert
    expect(row).toMatchObject({
      verb: 'Moved to another account',
      failoverTo: 'claude-b',
      anomalyKind: 'agent_frozen',
    });
    expect(row?.anomaly).toEqual({ label: 'frozen', tone: 'err' });
  });
});

describe('filterActionRows', () => {
  const rows = rowsOf(
    wardenAction({ at: at(7), by: 'jev', action: 'nudge', sessionId: 'a' }),
    wardenAction({ at: at(6), by: 'jev', action: 'bless', sessionId: 'b' }),
    wardenAction({ at: at(5), by: 'warden', action: 'stop', sessionId: 'c' }),
    wardenAction({ at: at(4), by: 'warden', action: 'nudge', sessionId: 'd', reportPath: 'r.md' }),
    wardenAction({ at: at(3), by: 'warden', action: 'restart', outcome: 'failed', sessionId: 'e' }),
    wardenAction({ at: at(2), by: 'warden', action: 'close_leftover', sessionId: 'f' }),
  );

  it('should show everything with no filters', () => {
    // Arrange / Act / Assert
    expect(filterActionRows(rows, NO_FILTERS)).toHaveLength(6);
  });

  it('should filter by actor', () => {
    // Arrange / Act / Assert
    expect(filterActionRows(rows, { actor: 'jev', outcome: 'all' }).map(row => row.sessionId)).toEqual(['b', 'a']);
    expect(filterActionRows(rows, { actor: 'llm', outcome: 'all' }).map(row => row.sessionId)).toEqual(['d']);
    expect(filterActionRows(rows, { actor: 'auto', outcome: 'all' })).toHaveLength(3);
  });

  it('should filter by outcome, leaving failed and closed rows to All', () => {
    // Arrange / Act / Assert
    expect(filterActionRows(rows, { actor: 'all', outcome: 'moved' }).map(row => row.sessionId)).toEqual(['d', 'a']);
    expect(filterActionRows(rows, { actor: 'all', outcome: 'stopped' }).map(row => row.sessionId)).toEqual(['c']);
    expect(filterActionRows(rows, { actor: 'all', outcome: 'asked' })).toEqual([]);
  });

  it('should require both filters to match', () => {
    // Arrange / Act / Assert
    expect(filterActionRows(rows, { actor: 'jev', outcome: 'cleared' }).map(row => row.sessionId)).toEqual(['b']);
    expect(filterActionRows(rows, { actor: 'llm', outcome: 'cleared' })).toEqual([]);
  });

  it('should filter after grouping, so a ×N row stays whole', () => {
    // Arrange
    const grouped = rowsOf(wardenAction({ at: at(3), by: 'jev' }), wardenAction({ at: at(2), by: 'jev' }));

    // Act
    const filtered = filterActionRows(grouped, { actor: 'jev', outcome: 'moved' });

    // Assert
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.count).toBe(2);
  });
});

describe('pageActionRows', () => {
  const many = Array.from({ length: 45 }, (_, index) => wardenAction({ at: at(index + 1), sessionId: `s-${index}` }));
  const rows = rowsOf(...many);

  it('should show one page and say how many more there are', () => {
    // Arrange / Act
    const page = pageActionRows(rows, 1);

    // Assert
    expect(ACTIONS_PAGE).toBe(20);
    expect(page.rows).toHaveLength(20);
    expect(page.hidden).toBe(25);
  });

  it('should reveal another page per step and finish at none hidden', () => {
    // Arrange / Act / Assert
    expect(pageActionRows(rows, 2)).toMatchObject({ hidden: 5 });
    expect(pageActionRows(rows, 3).rows).toHaveLength(45);
    expect(pageActionRows(rows, 3).hidden).toBe(0);
    expect(pageActionRows(rows, 10).hidden).toBe(0);
  });

  it('should always show at least one page', () => {
    // Arrange / Act / Assert
    expect(pageActionRows(rows, 0).rows).toHaveLength(20);
    expect(pageActionRows([], 1)).toEqual({ rows: [], hidden: 0 });
  });
});
