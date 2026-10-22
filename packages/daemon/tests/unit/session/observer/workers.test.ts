import { describe, it } from 'bun:test';
import type { SessionState } from '@ferretry/protocol';
import should from 'should';
import {
  NEW_WORKER,
  observerFactsOf,
  planSessionWorkers,
  SESSION_WORKER_CRASH_WINDOW_MS,
  sessionWorkerRestart,
  turnPaneEvidenceOf,
} from '../../../../src/lib/session/observer/index.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/session-id.ts';
import type { PaneState } from '../../../../src/lib/tmux/contracts.ts';

/**
 * The pure halves of the session workers: which thread hosts which session, what a crash costs, what
 * the main thread tells a worker, and how a frame reads as turn evidence.
 */

const ids = (...names: string[]): SessionId[] => names.map(name => parseSessionId(name));
const [A, B, C, D] = ids('a', 'b', 'c', 'd') as [SessionId, SessionId, SessionId, SessionId];

describe('planSessionWorkers', () => {
  it('should give every session its own new thread up to the cap', () => {
    // Act
    const actual = planSessionWorkers([A, B], new Map(), 8);

    // Assert
    should(actual).deepEqual({
      attach: [
        { session: A, worker: NEW_WORKER },
        { session: B, worker: NEW_WORKER },
      ],
      detach: [],
      terminate: [],
    });
  });

  it('should pool past the cap into the least-loaded worker, ties to the lowest id', () => {
    // Arrange
    const hosted = new Map([
      [2, [A]],
      [1, [B]],
    ]);

    // Act
    const actual = planSessionWorkers([A, B, C, D], hosted, 2);

    // Assert — C joins worker 1 (ties go low), then D the now least-loaded worker 2.
    should(actual.attach).deepEqual([
      { session: C, worker: 1 },
      { session: D, worker: 2 },
    ]);
    should(actual.terminate).deepEqual([]);
  });

  it('should detach what left and end a worker left hosting nothing', () => {
    // Arrange
    const hosted = new Map([
      [1, [A, B]],
      [2, [C]],
    ]);

    // Act
    const actual = planSessionWorkers([A], hosted, 1);

    // Assert
    should(actual.detach).deepEqual([
      { session: B, worker: 1 },
      { session: C, worker: 2 },
    ]);
    should(actual.terminate).deepEqual([2]);
    should(actual.attach).deepEqual([]);
  });

  it('should move one pooled session to a dedicated thread once the set fits the cap again', () => {
    // Arrange
    const hosted = new Map([[1, [A, B, C]]]);

    // Act
    const actual = planSessionWorkers([A, B, C], hosted, 8);

    // Assert
    should(actual.detach).deepEqual([{ session: C, worker: 1 }]);
    should(actual.attach).deepEqual([{ session: C, worker: NEW_WORKER }]);
  });

  it('should leave a settled pool alone, and add nothing with a cap no thread fits', () => {
    // Act + Assert
    should(planSessionWorkers([A], new Map([[1, [A]]]), 8)).deepEqual({ attach: [], detach: [], terminate: [] });
    should(planSessionWorkers([A], new Map(), 0).attach).deepEqual([]);
  });
});

describe('sessionWorkerRestart', () => {
  const now = 100 * SESSION_WORKER_CRASH_WINDOW_MS;

  it.each([
    [[now], 1_000],
    [[now - 1_000, now], 2_000],
    [[now - 3_000, now - 2_000, now], 4_000],
    [[now - SESSION_WORKER_CRASH_WINDOW_MS - 1, now], 1_000],
  ])('should restart after back-off: %p → %p ms', (crashes, expected) => {
    // Act
    const actual = sessionWorkerRestart(crashes, now);

    // Assert
    should(actual).deepEqual({ kind: 'restart', afterMs: expected });
  });

  it('should cap the back-off at a minute and give up at the fifth crash in ten minutes', () => {
    // Arrange
    const four = [now - 4, now - 3, now - 2, now];
    const five = [now - 5, ...four];

    // Act + Assert
    should(sessionWorkerRestart(four, now)).deepEqual({ kind: 'restart', afterMs: 8_000 });
    should(sessionWorkerRestart(five, now)).deepEqual({ kind: 'inline' });
    should(sessionWorkerRestart([], now)).deepEqual({ kind: 'restart', afterMs: 1_000 });
  });
});

describe('observerFactsOf', () => {
  it('should keep the turn fields and the question fields, and nothing else', () => {
    // Arrange
    const input = {
      id: 'a',
      status: 'running',
      turn: 2,
      turnState: 'working',
      lastAnsweredQuestionToolUseId: 'tool-1',
      needsHuman: 'look at this',
      needsHumanKind: 'structured-answer-released',
      observedModel: 'claude-opus-5-5',
      observedModelAt: '2026-10-22T08:00:00.000Z',
      observedReasoningEffort: 'high',
      observedFast: false,
      reason: 'not a fact the observer is told',
    } as unknown as SessionState;

    // Act
    const actual = observerFactsOf(input);

    // Assert
    should(actual).deepEqual({
      status: 'running',
      turn: 2,
      turnState: 'working',
      lastAnsweredQuestionToolUseId: 'tool-1',
      needsHuman: 'look at this',
      needsHumanKind: 'structured-answer-released',
      observedModel: 'claude-opus-5-5',
      observedModelAt: '2026-10-22T08:00:00.000Z',
      observedReasoningEffort: 'high',
      observedFast: false,
    });
    should(observerFactsOf({ id: 'a', status: 'running', turn: 1 } as SessionState)).deepEqual({
      status: 'running',
      turn: 1,
    });
  });
});

describe('turnPaneEvidenceOf', () => {
  const pane = (visible: string, promptReady: boolean): PaneState =>
    ({ alive: true, dead: false, promptReady, history: '', visible }) as PaneState;

  it('should read a working line, an idle prompt and a permission prompt', () => {
    // Arrange
    const working = '✽ Pontificating… (3s · ↓ 1.2k tokens · esc to interrupt)';
    const permission = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently';

    // Act
    const busy = turnPaneEvidenceOf(pane(working, false));
    const idle = turnPaneEvidenceOf(pane('│ > ', true));
    const asking = turnPaneEvidenceOf(pane(permission, false));

    // Assert
    should(busy.working).be.true();
    should(idle).containEql({ working: false, atPrompt: true, permission: false });
    should(asking.permission).be.true();
  });
});
