import { describe, it } from 'bun:test';
import type { WardenAction } from '@ferretry/protocol';
import should from 'should';
import {
  emptyWardenDay,
  EMPTY_WARDEN_STATE,
  foldWardenDaily,
  parseWardenRuntimeState,
  recordWardenAsk,
  recordWardenOutcome,
  wardenAskActor,
  WARDEN_DAILY_KEEP_DAYS,
  wardenHistory,
  withDailyRollup,
  type WardenRuntimeState,
} from '../../../src/lib/warden/index.ts';

const NOON = Date.parse('2026-07-31T12:00:00.000Z');
const DAY_MS = 86_400_000;

const action = (overrides: Partial<WardenAction> = {}): WardenAction => ({
  at: '2026-07-31T12:00:00.000Z',
  sessionId: 's1',
  action: 'nudge',
  outcome: 'done',
  by: 'warden',
  detail: 'nudged it',
  ...overrides,
});

const today = (state: WardenRuntimeState) => state.daily?.find(entry => entry.day === '2026-07-31');

describe('counting an outcome by who acted', () => {
  it('should count a nudge as moved under the actor that did it', () => {
    // Arrange
    const state = EMPTY_WARDEN_STATE;

    // Act
    const actual = recordWardenOutcome(state, action({ actor: 'auto' }));

    // Assert
    should(today(actual)?.moved).deepEqual({ auto: 1, jev: 0, llm: 0 });
  });

  it('should count each actor and each outcome apart', () => {
    // Arrange
    const actions: WardenAction[] = [
      action({ action: 'bless', actor: 'jev', by: 'jev' }),
      action({ action: 'stop', actor: 'llm', reportPath: '/r.md' }),
      action({ action: 'restart', actor: 'auto' }),
      action({ action: 'bless', actor: 'owner', by: 'owner' }),
    ];

    // Act
    const actual = actions.reduce(recordWardenOutcome, EMPTY_WARDEN_STATE);

    // Assert
    should(today(actual)?.cleared).deepEqual({ auto: 0, jev: 1, llm: 0, owner: 1 });
    should(today(actual)?.stopped).deepEqual({ auto: 0, jev: 0, llm: 1 });
    should(today(actual)?.moved).deepEqual({ auto: 1, jev: 0, llm: 0 });
  });

  it('should count what was held for the owner as asked, whatever it was going to be', () => {
    // Arrange
    const held = action({ action: 'stop', outcome: 'held', actor: 'llm', reportPath: '/r.md' });

    // Act
    const actual = recordWardenOutcome(EMPTY_WARDEN_STATE, held);

    // Assert
    should(today(actual)?.asked).deepEqual({ auto: 0, jev: 0, llm: 1 });
    should(today(actual)?.stopped).deepEqual({ auto: 0, jev: 0, llm: 0 });
  });

  it('should count neither a failed attempt nor a closed leftover browser as what became of a flag', () => {
    // Arrange
    const state = EMPTY_WARDEN_STATE;

    // Act
    const failed = recordWardenOutcome(state, action({ outcome: 'failed' }));
    const closed = recordWardenOutcome(state, action({ action: 'close_leftover' }));

    // Assert
    for (const actual of [failed, closed]) {
      should(today(actual)?.moved).deepEqual({ auto: 0, jev: 0, llm: 0 });
      should(today(actual)?.cleared).deepEqual({ auto: 0, jev: 0, llm: 0 });
      should(today(actual)?.stopped).deepEqual({ auto: 0, jev: 0, llm: 0 });
      should(today(actual)?.asked).deepEqual({ auto: 0, jev: 0, llm: 0 });
    }
  });

  it('should read the actor from what the action says when it carries none', () => {
    // Arrange
    const rule = action({ by: 'warden' });
    const investigation = action({ by: 'warden', reportPath: '/r.md' });

    // Act
    const actual = recordWardenOutcome(recordWardenOutcome(EMPTY_WARDEN_STATE, rule), investigation);

    // Assert
    should(today(actual)?.moved).deepEqual({ auto: 1, jev: 0, llm: 1 });
  });

  it('should put an action on the day it happened, keeping yesterday', () => {
    // Arrange
    const yesterday = action({ at: '2026-07-30T23:59:00.000Z', actor: 'auto' });
    const now = action({ actor: 'auto' });

    // Act
    const actual = recordWardenOutcome(recordWardenOutcome(EMPTY_WARDEN_STATE, yesterday), now);

    // Assert
    should(actual.daily?.map(entry => entry.day)).deepEqual(['2026-07-30', '2026-07-31']);
    should(actual.daily?.map(entry => entry.moved.auto)).deepEqual([1, 1]);
  });
});

describe('counting an ask that records no action', () => {
  it('should count one ask under the actor that decided it', () => {
    // Arrange
    const state = EMPTY_WARDEN_STATE;

    // Act
    const actual = recordWardenAsk(state, '2026-07-31T12:00:00.000Z', 'llm');

    // Assert
    should(today(actual)?.asked).deepEqual({ auto: 0, jev: 0, llm: 1 });
  });

  it('should leave the state alone for an instant it cannot read', () => {
    // Arrange / Act
    const actual = recordWardenAsk(EMPTY_WARDEN_STATE, 'not a time', 'llm');

    // Assert
    should(actual).equal(EMPTY_WARDEN_STATE);
  });
});

describe('folding the snapshot counters in', () => {
  it('should make today exist as a real zero when nothing happened', () => {
    // Arrange / Act
    const actual = foldWardenDaily(EMPTY_WARDEN_STATE, NOON);

    // Assert
    should(actual.daily).deepEqual([emptyWardenDay('2026-07-31')]);
  });

  it("should take today's flags and Jev's work from the triage counters", () => {
    // Arrange
    const state: WardenRuntimeState = {
      triageDay: { day: '2026-07-31', flags: 4, jevDecisions: 3, jevSkips: 1, jevUsd: 0.25 },
    };

    // Act
    const actual = foldWardenDaily(state, NOON);

    // Assert
    should(today(actual)).containEql({ flags: 4, jevDecisions: 3, jevUsd: 0.25 });
  });

  it('should never take a number down when a source falls behind', () => {
    // Arrange
    const high = foldWardenDaily(
      { triageDay: { day: '2026-07-31', flags: 9, jevDecisions: 9, jevSkips: 0, jevUsd: 1 } },
      NOON,
    );
    const behind: WardenRuntimeState = {
      ...high,
      triageDay: { day: '2026-07-31', flags: 2, jevDecisions: 2, jevSkips: 0, jevUsd: 0.1 },
    };

    // Act
    const actual = foldWardenDaily(behind, NOON);

    // Assert
    should(today(actual)).containEql({ flags: 9, jevDecisions: 9, jevUsd: 1 });
  });

  it('should keep yesterday when the day rolls over, folding its last counters where they belong', () => {
    // Arrange
    const state: WardenRuntimeState = {
      triageDay: { day: '2026-07-30', flags: 5, jevDecisions: 2, jevSkips: 0, jevUsd: 0.5 },
    };

    // Act
    const actual = foldWardenDaily(state, NOON);

    // Assert
    should(actual.daily?.map(entry => [entry.day, entry.flags])).deepEqual([
      ['2026-07-30', 5],
      ['2026-07-31', 0],
    ]);
  });

  it('should count an investigation on the day it started, and its cost there even if priced the next day', () => {
    // Arrange
    const started = '2026-07-30T23:50:00.000Z';
    const record = {
      id: 'w1',
      scope: 'session' as const,
      origin: 'jev' as const,
      startedAt: started,
      reportPath: '/r1.md',
    };
    const unpriced = foldWardenDaily({ investigations: [record] }, Date.parse('2026-07-30T23:55:00.000Z'));

    // Act
    const actual = foldWardenDaily({ ...unpriced, investigations: [{ ...record, costUsd: 0.4 }] }, NOON);

    // Assert
    const yesterday = actual.daily?.find(entry => entry.day === '2026-07-30');
    should(yesterday).containEql({ investigations: 1, investigationUsd: 0.4 });
    should(today(actual)).containEql({ investigations: 0, investigationUsd: 0 });
  });

  it('should not lose a count when its investigation record has been pruned', () => {
    // Arrange
    const record = {
      id: 'w1',
      scope: 'fleet' as const,
      origin: 'sweep' as const,
      startedAt: '2026-07-31T01:00:00.000Z',
      reportPath: '/r1.md',
      costUsd: 0.2,
    };
    const folded = foldWardenDaily({ investigations: [record] }, NOON);

    // Act
    const actual = foldWardenDaily({ ...folded, investigations: [] }, NOON);

    // Assert
    should(today(actual)).containEql({ investigations: 1, investigationUsd: 0.2 });
  });

  it('should keep the last thirty days, oldest first', () => {
    // Arrange
    const days = Array.from({ length: 40 }, (_, index) =>
      emptyWardenDay(new Date(NOON - (39 - index) * DAY_MS).toISOString().slice(0, 10)),
    );

    // Act
    const actual = foldWardenDaily({ daily: days }, NOON);

    // Assert
    should(actual.daily).have.length(WARDEN_DAILY_KEEP_DAYS);
    should(actual.daily?.at(-1)?.day).equal('2026-07-31');
    should(actual.daily?.[0]?.day).equal('2026-07-02');
  });
});

describe('the history the status shows', () => {
  it('should be at most thirty days, oldest first and today last, only those the daemon kept', () => {
    // Arrange
    const days = Array.from({ length: 40 }, (_, index) =>
      emptyWardenDay(new Date(NOON - (39 - index) * DAY_MS).toISOString().slice(0, 10)),
    );

    // Act
    const actual = wardenHistory({ daily: days }, NOON);

    // Assert
    should(actual).have.length(30);
    should(actual.map(entry => entry.day)).deepEqual([...actual.map(entry => entry.day)].sort());
    should(actual.at(-1)?.day).equal('2026-07-31');
  });

  it('should be only today when the daemon has just begun to look', () => {
    // Arrange / Act
    const actual = wardenHistory(EMPTY_WARDEN_STATE, NOON);

    // Assert
    should(actual.map(entry => entry.day)).deepEqual(['2026-07-31']);
  });
});

describe('a store whose every write carries the rollup', () => {
  it('should write the folded state and read it back unchanged', async () => {
    // Arrange
    let written: WardenRuntimeState | undefined;
    const store = {
      read: async () => written,
      write: async (state: WardenRuntimeState) => {
        written = state;
      },
    };
    const subject = withDailyRollup(store, () => NOON);

    // Act
    await subject.write({ triageDay: { day: '2026-07-31', flags: 1, jevDecisions: 0, jevSkips: 0, jevUsd: 0 } });
    const actual = await subject.read();

    // Assert
    should((actual as WardenRuntimeState).daily?.at(-1)).containEql({ day: '2026-07-31', flags: 1 });
  });
});

describe('reading the daily history back', () => {
  it('should salvage the good days and the rest of the state when one entry is corrupt', () => {
    // Arrange
    const document = {
      lastSweepAt: '2026-07-31T12:00:00.000Z',
      investigatorSequence: 42,
      daily: [emptyWardenDay('2026-07-30'), { day: 'yesterday', moved: 'lots' }, emptyWardenDay('2026-07-31')],
    };

    // Act
    const actual = parseWardenRuntimeState(document);

    // Assert
    should(actual.daily?.map(entry => entry.day)).deepEqual(['2026-07-30', '2026-07-31']);
    should(actual.lastSweepAt).equal('2026-07-31T12:00:00.000Z');
    should(actual.investigatorSequence).equal(42);
  });

  it('should drop a daily section that is not a list without losing the other state', () => {
    // Arrange
    const document = { lastSweepAt: '2026-07-31T12:00:00.000Z', daily: 'corrupt' };

    // Act
    const actual = parseWardenRuntimeState(document);

    // Assert
    should(actual.daily).be.undefined();
    should(actual.lastSweepAt).equal('2026-07-31T12:00:00.000Z');
  });
});

describe('who asked the owner', () => {
  it('should credit a verdict to the LLM, a hand-on to Jev, the rest to rules, and never count a hold twice', () => {
    // Act + Assert
    should(wardenAskActor('needs_human')).equal('llm');
    should(wardenAskActor('jev')).equal('jev');
    should(wardenAskActor('investigation_failed')).equal('auto');
    should(wardenAskActor('untriaged')).equal('auto');
    should(wardenAskActor('held')).be.undefined();
  });
});
