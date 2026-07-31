import { describe, it } from 'bun:test';
import should from 'should';
import {
  defaultSessionHealthSettings,
  detectZombies,
  journalOutlivedTerminal,
  type TerminalSessionActivity,
} from '../../../../src/lib/session/health/index.ts';

const SETTINGS = defaultSessionHealthSettings;
const FINISHED = '2026-07-31T10:00:00.000Z';
const FINISHED_MS = Date.parse(FINISHED);

function activity(overrides: Partial<TerminalSessionActivity> = {}): TerminalSessionActivity {
  return { id: 'session-1', finishedAt: FINISHED, journalModifiedMs: FINISHED_MS, ...overrides };
}

describe('terminal session zombie detection', () => {
  it('should flag a finished session whose journal kept growing past the grace period', () => {
    // Arrange
    const stillWriting = activity({ journalModifiedMs: FINISHED_MS + SETTINGS.terminalActivityGraceMs });

    // Act
    const actual = journalOutlivedTerminal(stillWriting, SETTINGS);

    // Assert
    should(actual).be.true();
  });

  it('should let a session finish its trailing writes inside the grace period', () => {
    // Arrange
    const settling = activity({ journalModifiedMs: FINISHED_MS + SETTINGS.terminalActivityGraceMs - 1 });

    // Act
    const actual = journalOutlivedTerminal(settling, SETTINGS);

    // Assert
    should(actual).be.false();
  });

  it('should never re-adopt on evidence it cannot use', () => {
    // Arrange — a zombie verdict restarts a monitor, so unusable evidence must answer no.
    const cases: readonly TerminalSessionActivity[] = [
      activity({ finishedAt: undefined }),
      activity({ finishedAt: 'sometime' }),
      activity({ journalModifiedMs: undefined }),
      activity({ journalModifiedMs: Number.NaN }),
      // A journal older than the finish stamp is a clock artefact, not live work.
      activity({ journalModifiedMs: FINISHED_MS - 600_000 }),
    ];

    // Act
    const actual = cases.map(item => journalOutlivedTerminal(item, SETTINGS));

    // Assert
    should(actual).deepEqual([false, false, false, false, false]);
  });

  it('should name only the zombies among a mixed set', () => {
    // Arrange
    const observed = [
      activity({ id: 'settled' }),
      activity({ id: 'zombie', journalModifiedMs: FINISHED_MS + 600_000 }),
      activity({ id: 'unknown', finishedAt: undefined }),
    ];

    // Act
    const actual = detectZombies(observed, SETTINGS);

    // Assert
    should(actual).deepEqual(['zombie']);
  });
});
