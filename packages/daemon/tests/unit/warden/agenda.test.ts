import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildWardenAgendaView,
  WARDEN_AGENDA_VERDICT_LIMIT,
  type AgendaBoardInput,
  type AgendaItem,
  type FleetSessionLike,
  type WardenAgendaInput,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const session = (
  id: string,
  overrides: Partial<FleetSessionLike['config']> = {},
  status = 'running',
): FleetSessionLike => ({
  config: { id, ...overrides },
  state: { status: status as NonNullable<FleetSessionLike['state']['status']> },
});

/** A Warden card, as the board holds it. */
const card = (overrides: Partial<AgendaItem> = {}): AgendaItem => ({
  id: 'A1',
  source: 'agent-raised',
  subject: 'What should the Warden do about :atlas? Session may be stuck thinking.',
  why: 'Jev looked and was not sure what to do (42% sure).',
  context: '- No investigation follows.',
  waitingSince: at(-30),
  howToResolve: 'Pick what the Warden should do.',
  raisedBy: 'daemon',
  sourceRef: 'warden:ask:sus_thinking',
  ...overrides,
});

const board = (sessionId: string, items: readonly AgendaItem[], parseErrors = 0): AgendaBoardInput => ({
  sessionId,
  parseErrors,
  items,
});

const view = (overrides: Partial<WardenAgendaInput> = {}) =>
  buildWardenAgendaView({
    now: NOW,
    sessions: [session('s1', { teammate: 'atlas', label: 'batch-7' })],
    boards: [],
    lastSweepAt: at(-1),
    ...overrides,
  });

describe('the Warden page reads the Warden’s own cards', () => {
  it('should list a Warden card with its ferret, as raised by the Warden', () => {
    // Act
    const actual = view({ boards: [board('s1', [card()])] });

    // Assert
    should(actual.outcome).equal('items');
    should(actual.items).deepEqual([
      {
        sessionId: 's1',
        teammate: 'atlas',
        label: 'batch-7',
        sessionStatus: 'running',
        id: 'A1',
        source: 'agent-raised',
        subject: 'What should the Warden do about :atlas? Session may be stuck thinking.',
        why: 'Jev looked and was not sure what to do (42% sure).',
        context: '- No investigation follows.',
        waitingSince: at(-30),
        howToResolve: 'Pick what the Warden should do.',
        raisedBy: 'daemon',
        raisedByName: 'Warden',
        anomalyKind: 'sus_thinking',
      },
    ]);
  });

  it('should name the class of a fleet card too', () => {
    // Act
    const actual = view({
      boards: [board('s1', [card({ sourceRef: 'warden:ask:fleet:dead_monitor:daemon:no-monitor-subsystem' })])],
    });

    // Assert
    should(actual.items[0]?.anomalyKind).equal('dead_monitor');
  });

  it.each([
    ['a ferret’s own ask', card({ raisedBy: 'agent', sourceRef: undefined })],
    ['a person’s note', card({ raisedBy: 'human', sourceRef: undefined })],
    ['another daemon item', card({ sourceRef: 'harness-prompt:1' })],
    ['a daemon question row', card({ source: 'question' })],
    ['an item naming one report block', card({ sourceRef: 'warden:/r.md#sus_thinking' })],
    ['an old escalation item', card({ sourceRef: 'warden:sus_thinking' })],
  ])('should never list %s', (_label, item) => {
    // Act / Assert
    should(view({ boards: [board('s1', [item])] }).items).deepEqual([]);
  });

  it('should leave out a card on a ferret that has finished', () => {
    // Act
    const actual = view({ sessions: [session('s1', {}, 'completed')], boards: [board('s1', [card()])] });

    // Assert
    should(actual.items).deepEqual([]);
  });

  it('should list a card whose session it does not know, with what the board says', () => {
    // Act
    const actual = view({ sessions: [], boards: [board('s9', [card()])] });

    // Assert
    should(actual.items).match([{ sessionId: 's9', id: 'A1' }]);
    should(actual.items[0]).not.have.property('teammate');
  });

  it('should leave out an empty context rather than invent one', () => {
    // Arrange
    const { context: _context, ...bare } = card();

    // Act / Assert
    should(view({ boards: [board('s1', [bare])] }).items[0]).not.have.property('context');
  });

  it('should list the oldest wait first, then by ferret and id', () => {
    // Act
    const actual = view({
      sessions: [session('s1'), session('s2')],
      boards: [
        board('s2', [card({ id: 'A2', waitingSince: at(-10) }), card({ id: 'A1', waitingSince: at(-10) })]),
        board('s1', [card({ id: 'A5', waitingSince: at(-10) }), card({ id: 'A3', waitingSince: at(-50) })]),
      ],
    });

    // Assert
    should(actual.items.map(item => `${item.sessionId}/${item.id}`)).deepEqual(['s1/A3', 's1/A5', 's2/A1', 's2/A2']);
  });

  it('should report a verdict window that is never truncated, since it joins no verdicts', () => {
    // Act / Assert
    should(view().verdictCoverage).deepEqual({ limit: WARDEN_AGENDA_VERDICT_LIMIT, truncated: false });
  });
});

describe('what “nothing waits” means', () => {
  it('should say a clean sweep when a sweep ran and nothing waits', () => {
    // Act
    const actual = view();

    // Assert
    should(actual.outcome).equal('clean-sweep');
    should(actual.lastSweepAt).equal(at(-1));
    should(actual).not.have.property('wardenDegraded');
  });

  it('should say no sweep when nothing ever ran', () => {
    // Act
    const actual = view({ lastSweepAt: undefined });

    // Assert
    should(actual.outcome).equal('no-sweep');
    should(actual).not.have.property('lastSweepAt');
  });

  it('should say degraded, never clear, when a board could not be read', () => {
    // Act
    const unread = view({ unreadBoards: 1 });
    const broken = view({ boards: [board('s1', [], 2)] });

    // Assert
    should(unread.outcome).equal('degraded');
    should(unread.wardenDegraded?.reason).match(/may be hidden/u);
    should(broken.outcome).equal('degraded');
    should(broken.boardsWithParseErrors).deepEqual([{ sessionId: 's1', parseErrors: 2 }]);
  });

  it('should say degraded when the reports could not be read', () => {
    // Act / Assert
    should(view({ reportsUnreadable: true }).wardenDegraded?.reason).match(/reports could not be read/u);
  });

  it('should say degraded when the sweep is overdue, dated by the last sweep', () => {
    // Act
    const actual = view({ lastSweepAt: at(-16) });
    const custom = view({ lastSweepAt: at(-16), sweepIntervalMinutes: 10 });

    // Assert
    should(actual.wardenDegraded).deepEqual({
      since: at(-16),
      reason: 'Warden sweeps are overdue — what is listed may be out of date.',
    });
    should(custom.outcome).equal('clean-sweep');
  });

  it('should put the exhausted banner first, dated when exhaustion began', () => {
    // Act
    const actual = view({ exhaustedSince: at(-5), lastSweepAt: at(-60), reportsUnreadable: true });

    // Assert
    should(actual.wardenDegraded).deepEqual({
      since: at(-5),
      reason: 'All warden accounts are exhausted — new investigations are paused.',
    });
  });

  it('should list the cards it has while degraded, as items', () => {
    // Act / Assert
    should(view({ boards: [board('s1', [card()])], unreadBoards: 3 }).outcome).equal('items');
  });
});
