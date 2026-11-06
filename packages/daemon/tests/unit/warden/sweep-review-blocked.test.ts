import { describe, it } from 'bun:test';
import type { PrLink } from '@ferretry/protocol';
import should from 'should';
import type { WardenBoardPort, WardenBoardRead, WardenFleetSession } from '../../../src/lib/warden/index.ts';
import { boardOf, cardView } from './board-fixtures.ts';
import { enabled, type Harness, harness, journalTypes, NOW, session } from './sweep-harness.ts';

/**
 * A card in Review with a pull request that cannot merge, end to end through the real sweep: its idle ferret is woken
 * once after 30 minutes, never again for the same state, and again only for a new one. The shape of 2026-11-04, when
 * the compact-header PR sat in conflict for about seven hours and nothing woke its finished ferret.
 */

const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const URL = 'https://github.com/kirinnee/ferretry/pull/940';

const pr = (over: Partial<PrLink> = {}): PrLink => ({
  url: URL,
  number: 940,
  repo: 'kirinnee/ferretry',
  state: 'open',
  draft: false,
  checks: 'passing',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: iso(NOW),
  ...over,
});

const reviewBoard = (...prs: PrLink[]): WardenBoardRead =>
  boardOf(
    cardView({
      laneId: 'review',
      assignee: 'worker',
      links: { prs, branch: null, commits: [], docs: [] },
    }),
  );

/** A board port over a board the test can change between sweeps. */
const boardPort = (
  initial: WardenBoardRead | undefined,
): WardenBoardPort & { set(next: WardenBoardRead | undefined): void } => {
  let current = initial;
  return {
    read: async () => current,
    focusCard: async () => undefined,
    set: next => {
      current = next;
    },
  };
};

const idleWorker = (over: Partial<WardenFleetSession['state']> = {}): WardenFleetSession =>
  session({
    id: 'worker',
    status: 'running',
    state: { turnState: 'your-turn', turnStateAt: iso(NOW - 5 * MINUTE), lastActivityAt: iso(NOW - MINUTE), ...over },
  });

const nudges = (subject: Harness) =>
  subject.remedies.filter(remedy => remedy.action === 'nudge' && remedy.detail.includes('&F1'));

describe('a card in Review whose pull request cannot merge', () => {
  it('should wake its idle ferret once after 30 minutes, and never again for the same state', async () => {
    // Arrange
    let now = NOW;
    const board = boardPort(reviewBoard(pr({ mergeable: 'conflicting' })));
    const subject = harness({ config: enabled(), fleet: [idleWorker()], board, now: () => now });

    // Act — first seen; a young conflict; past 30 minutes; and hours after.
    await subject.service.run({ force: false });
    now = NOW + 20 * MINUTE;
    await subject.service.run({ force: false });
    const youngNudges = nudges(subject).length;
    now = NOW + 31 * MINUTE;
    await subject.service.run({ force: false });
    now = NOW + 7 * 60 * MINUTE;
    await subject.service.run({ force: false });

    // Assert
    should(youngNudges).equal(0);
    should(nudges(subject).map(remedy => remedy.sessionId)).eql(['worker']);
    should(nudges(subject)[0]?.detail).containEql(URL);
    should(nudges(subject)[0]?.detail).containEql('a merge conflict');
    should(subject.state().reviewBlocked).eql({
      F1: { state: `${URL}:conflict`, since: iso(NOW), nudgedAt: iso(NOW + 31 * MINUTE) },
    });
    should(journalTypes(subject).filter(type => type === 'fleet.warden_review_blocked_nudged')).have.length(1);
  });

  it('should wake it again for a new blocking state, after that state has stood 30 minutes', async () => {
    // Arrange
    let now = NOW;
    const board = boardPort(reviewBoard(pr({ mergeable: 'conflicting' })));
    const subject = harness({ config: enabled(), fleet: [idleWorker()], board, now: () => now });
    await subject.service.run({ force: false });
    now = NOW + 31 * MINUTE;
    await subject.service.run({ force: false });

    // Act — the conflict is fixed but CI is red.
    board.set(reviewBoard(pr({ mergeable: 'mergeable', checks: 'failing' })));
    now = NOW + 40 * MINUTE;
    await subject.service.run({ force: false });
    const beforeClock = nudges(subject).length;
    now = NOW + 75 * MINUTE;
    await subject.service.run({ force: false });

    // Assert
    should(beforeClock).equal(1);
    should(nudges(subject)).have.length(2);
    should(nudges(subject)[1]?.detail).containEql('has red CI');
  });

  it('should leave a working ferret alone, and wake it once it is idle', async () => {
    // Arrange
    let now = NOW;
    let worker = idleWorker({ turnState: 'working' });
    const board = boardPort(reviewBoard(pr({ checks: 'failing' })));
    const subject = harness({ config: enabled(), fleet: [worker], board, now: () => now });

    // Act
    await subject.service.run({ force: false });
    now = NOW + 40 * MINUTE;
    await subject.service.run({ force: false });
    const whileWorking = nudges(subject).length;
    worker = idleWorker();
    subject.setFleet([worker]);
    now = NOW + 45 * MINUTE;
    await subject.service.run({ force: false });

    // Assert
    should(whileWorking).equal(0);
    should(nudges(subject)).have.length(1);
  });

  it('should wake nobody and forget nothing when the board cannot be read', async () => {
    // Arrange
    let now = NOW;
    const board = boardPort(reviewBoard(pr({ mergeable: 'conflicting' })));
    const subject = harness({ config: enabled(), fleet: [idleWorker()], board, now: () => now });
    await subject.service.run({ force: false });
    const remembered = subject.state().reviewBlocked;

    // Act
    board.set(undefined);
    now = NOW + 2 * 60 * MINUTE;
    await subject.service.run({ force: false });

    // Assert
    should(nudges(subject)).be.empty();
    should(subject.state().reviewBlocked).eql(remembered);
  });

  it('should wake nobody while the owner has not let the Warden nudge alone', async () => {
    // Arrange
    let now = NOW;
    const config = enabled();
    const subject = harness({
      config: { ...config, mayActAlone: { ...config.mayActAlone, nudge: false } },
      fleet: [idleWorker()],
      board: boardPort(reviewBoard(pr({ mergeable: 'conflicting' }))),
      now: () => now,
    });

    // Act
    await subject.service.run({ force: false });
    now = NOW + 2 * 60 * MINUTE;
    await subject.service.run({ force: false });

    // Assert
    should(nudges(subject)).be.empty();
  });
});

describe('a nudge that could not be typed', () => {
  it('should be journalled and not remembered, so the next sweep tries again', async () => {
    // Arrange
    let now = NOW;
    const subject = harness({
      config: enabled(),
      fleet: [idleWorker()],
      board: boardPort(reviewBoard(pr({ mergeable: 'conflicting' }))),
      remedyFails: 'nudge',
      now: () => now,
    });

    // Act
    await subject.service.run({ force: false });
    now = NOW + 31 * MINUTE;
    await subject.service.run({ force: false });
    now = NOW + 36 * MINUTE;
    await subject.service.run({ force: false });

    // Assert
    should(journalTypes(subject).filter(type => type === 'fleet.warden_review_blocked_failed')).have.length(2);
    should(journalTypes(subject)).not.containEql('fleet.warden_review_blocked_nudged');
    should(subject.state().reviewBlocked?.F1).eql({ state: `${URL}:conflict`, since: iso(NOW) });
  });
});
