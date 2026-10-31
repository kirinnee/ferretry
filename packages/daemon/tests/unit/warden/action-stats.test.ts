import { describe, it } from 'bun:test';
import { type WardenAction, WardenStatusViewSchema } from '@ferretry/protocol';
import should from 'should';
import {
  EMPTY_WARDEN_STATE,
  parseWardenRuntimeState,
  REVIVE_PROGRESS_MS,
  recordWardenAsk,
  recordWardenOutcome,
  resolveReviveWatch,
  sumActionTallies,
  sumReviveResults,
  tallyAction,
  WARDEN_DAILY_KEEP_DAYS,
  type WardenRuntimeState,
  type WardenSessionView,
  watchRevive,
} from '../../../src/lib/warden/index.ts';

const NOON = Date.parse('2026-07-31T12:00:00.000Z');
const MINUTE = 60_000;

const action = (overrides: Partial<WardenAction> = {}): WardenAction => ({
  at: '2026-07-31T12:00:00.000Z',
  sessionId: 's1',
  action: 'revive',
  outcome: 'done',
  by: 'warden',
  actor: 'auto',
  detail: 'brought it back',
  ...overrides,
});

const today = (state: WardenRuntimeState) => state.daily?.find(entry => entry.day === '2026-07-31');
const tallyOf = (state: WardenRuntimeState, kind: string, outcome: string) =>
  today(state)?.acts?.find(entry => entry.action === kind && entry.outcome === outcome);

const view = (state: Partial<WardenSessionView['state']> = {}, id = 's1'): WardenSessionView => ({
  config: { id, mode: 'auto' },
  state: { status: 'running', ...state },
  hasLiveMonitor: true,
});

const at = (offsetMs: number): string => new Date(NOON + offsetMs).toISOString();

describe('counting every action by who decided it', () => {
  it('should count a revive under the rule that made it', () => {
    // Act
    const actual = recordWardenOutcome(EMPTY_WARDEN_STATE, action());

    // Assert
    should(tallyOf(actual, 'revive', 'done')).containEql({ auto: 1, jev: 0, llm: 0 });
  });

  it('should keep a revive and a nudge apart though both are moved', () => {
    // Act
    const actual = [action(), action({ action: 'nudge', actor: 'jev', by: 'jev' })].reduce(
      recordWardenOutcome,
      EMPTY_WARDEN_STATE,
    );

    // Assert
    should(today(actual)?.moved).deepEqual({ auto: 1, jev: 1, llm: 0 });
    should(tallyOf(actual, 'revive', 'done')).containEql({ auto: 1, jev: 0 });
    should(tallyOf(actual, 'nudge', 'done')).containEql({ auto: 0, jev: 1 });
  });

  it('should count a failed attempt and a held act as their own outcomes, not as done', () => {
    // Act
    const actual = [
      action({ outcome: 'failed' }),
      action({ action: 'resume', outcome: 'held', actor: 'llm', by: 'warden', reportPath: '/r.md' }),
    ].reduce(recordWardenOutcome, EMPTY_WARDEN_STATE);

    // Assert
    should(tallyOf(actual, 'revive', 'failed')).containEql({ auto: 1 });
    should(tallyOf(actual, 'resume', 'held')).containEql({ llm: 1 });
    should(tallyOf(actual, 'revive', 'done')).be.undefined();
  });

  it('should count a flag handed to the owner as an escalation by who decided it', () => {
    // Act
    const actual = recordWardenAsk(EMPTY_WARDEN_STATE, '2026-07-31T12:00:00.000Z', 'jev');

    // Assert
    should(tallyOf(actual, 'escalate', 'done')).containEql({ jev: 1 });
  });

  it('should add days up into one list per action and outcome', () => {
    // Arrange
    const one = tallyAction(undefined, 'revive', 'done', 'auto');
    const two = tallyAction(tallyAction(undefined, 'revive', 'done', 'llm'), 'stop', 'done', 'jev');

    // Act
    const actual = sumActionTallies([{ acts: one }, { acts: two }, {}]);

    // Assert
    should(actual.find(entry => entry.action === 'revive')).containEql({ auto: 1, llm: 1, jev: 0 });
    should(actual.find(entry => entry.action === 'stop')).containEql({ jev: 1 });
  });

  it('should keep thirty days so a month can be added up', () => {
    should(WARDEN_DAILY_KEEP_DAYS).equal(30);
  });

  it('should survive a round trip through the persisted document', () => {
    // Arrange
    const counted = watchRevive(recordWardenOutcome(EMPTY_WARDEN_STATE, action()), action());

    // Act
    const actual = parseWardenRuntimeState(JSON.parse(JSON.stringify(counted)));

    // Assert
    should(tallyOf(actual, 'revive', 'done')).containEql({ auto: 1 });
    should(actual.reviveWatch).have.length(1);
  });

  it('should accept a status that carries the new totals and one that predates them', () => {
    // Act
    const shape = WardenStatusViewSchema.shape;

    // Assert
    should(shape.actionTotals.isOptional()).be.true();
    should(shape.reviveTotals.isOptional()).be.true();
  });
});

describe('watching whether a revive took', () => {
  const revived = (overrides: Partial<WardenAction> = {}): WardenRuntimeState =>
    watchRevive(EMPTY_WARDEN_STATE, action({ at: at(0), ...overrides }));

  it('should watch a revive and a resume that were done, and nothing else', () => {
    should(revived().reviveWatch).have.length(1);
    should(revived({ action: 'resume' }).reviveWatch).have.length(1);
    should(revived({ outcome: 'failed' }).reviveWatch).be.undefined();
    should(revived({ outcome: 'held' }).reviveWatch).be.undefined();
    should(revived({ action: 'nudge' }).reviveWatch).be.undefined();
  });

  it('should count a ferret that burned tokens after the revive as progressed, under who revived it', () => {
    // Arrange
    const fleet = [view({ lastTokenAdvanceAt: at(2 * MINUTE) })];

    // Act
    const actual = resolveReviveWatch(revived({ actor: 'jev', by: 'jev' }), fleet, NOON + 3 * MINUTE);

    // Assert
    should(today(actual)?.reviveResults).deepEqual({
      progressed: { auto: 0, jev: 1, llm: 0 },
      stalled: { auto: 0, jev: 0, llm: 0 },
    });
    should(actual.reviveWatch).deepEqual([]);
  });

  it('should keep watching a quiet ferret inside its window', () => {
    // Act
    const actual = resolveReviveWatch(revived(), [view()], NOON + 5 * MINUTE);

    // Assert
    should(actual.reviveWatch).have.length(1);
    should(today(actual)?.reviveResults).be.undefined();
  });

  it('should count a ferret still silent when the window ends as stalled', () => {
    // Act
    const actual = resolveReviveWatch(revived(), [view()], NOON + REVIVE_PROGRESS_MS + MINUTE);

    // Assert
    should(today(actual)?.reviveResults?.stalled).deepEqual({ auto: 1, jev: 0, llm: 0 });
    should(today(actual)?.reviveResults?.progressed).deepEqual({ auto: 0, jev: 0, llm: 0 });
  });

  it('should not take the resume’s own message in the transcript for progress', () => {
    // Arrange
    const fleet = [view({ lastTranscriptAt: at(5_000) })];

    // Act
    const actual = resolveReviveWatch(revived(), fleet, NOON + 2 * MINUTE);

    // Assert
    should(actual.reviveWatch).have.length(1);
  });

  it('should count a ferret that ended again after the revive as stalled at once', () => {
    // Arrange
    const fleet = [view({ status: 'failed', finishedAt: at(MINUTE) })];

    // Act
    const actual = resolveReviveWatch(revived(), fleet, NOON + 2 * MINUTE);

    // Assert
    should(today(actual)?.reviveResults?.stalled).deepEqual({ auto: 1, jev: 0, llm: 0 });
  });

  it('should count a ferret that finished its work after the revive as progressed', () => {
    // Arrange
    const fleet = [view({ status: 'completed', finishedAt: at(4 * MINUTE) })];

    // Act
    const actual = resolveReviveWatch(revived(), fleet, NOON + 5 * MINUTE);

    // Assert
    should(today(actual)?.reviveResults?.progressed).deepEqual({ auto: 1, jev: 0, llm: 0 });
  });

  it('should ignore a terminal status from before the revive', () => {
    // Arrange
    const fleet = [view({ status: 'failed', finishedAt: at(-10 * MINUTE) })];

    // Act
    const actual = resolveReviveWatch(revived(), fleet, NOON + MINUTE);

    // Assert
    should(actual.reviveWatch).have.length(1);
  });

  it('should drop a revive nobody looked at for hours rather than guess', () => {
    // Act
    const actual = resolveReviveWatch(revived(), [view()], NOON + 5 * 60 * MINUTE);

    // Assert
    should(actual.reviveWatch).deepEqual([]);
    should(today(actual)?.reviveResults).be.undefined();
  });

  it('should add up the results of every day', () => {
    // Arrange
    const results = { progressed: { auto: 2, jev: 1, llm: 0 }, stalled: { auto: 1, jev: 0, llm: 1 } };

    // Act
    const actual = sumReviveResults([{ reviveResults: results }, { reviveResults: results }, {}]);

    // Assert
    should(actual).deepEqual({
      progressed: { auto: 4, jev: 2, llm: 0 },
      stalled: { auto: 2, jev: 0, llm: 2 },
    });
  });
});
