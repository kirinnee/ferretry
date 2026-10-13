import { describe, it } from 'bun:test';
import should from 'should';
import { type FleetApplyCommittedState, FleetApplyFailureError } from '../../src/lib/provisioning.ts';

describe('FleetApplyFailureError', () => {
  it('should say the host was restored when every captured entry went back', () => {
    // Act
    const actual = new FleetApplyFailureError({
      kind: 'rolled-back',
      failedOperation: 'copy /homes/one/skills',
      reason: 'source is unreadable',
    });

    // Assert
    should(actual.name).equal('FleetApplyFailureError');
    should(actual.message).match(/copy \/homes\/one\/skills/u);
    should(actual.message).match(/source is unreadable/u);
    should(actual.message).match(/restored to its previous state and nothing was committed/u);
  });

  it('should name every path whose restoration could not be verified', () => {
    // Act
    const actual = new FleetApplyFailureError({
      kind: 'rollback-incomplete',
      failedOperation: 'file /fleet/bin/claude-kirin',
      reason: 'disk is full',
      unrestored: [
        { path: '/homes/one/memory.md', reason: 'outside configured fleet roots', backup: '/homes/one/.backup' },
        { path: '/homes/two/memory.md', reason: 'changed after this apply wrote it' },
      ],
    });

    // Assert
    should(actual.message).match(/restoration could not be verified/u);
    should(actual.message).match(/\/homes\/one\/memory\.md \(outside configured fleet roots\)/u);
    should(actual.message).match(/\/homes\/two\/memory\.md \(changed after this apply wrote it\)/u);
  });

  it('should report a committed fleet rather than claim it rolled back', () => {
    // Arrange
    const committed: FleetApplyCommittedState = {
      accountCount: 2,
      operationCount: 9,
      manifestPath: '/state/fleet/manifest.json',
      manifest: { version: 1, generatedAt: '2027-01-15T08:00:00.000Z', accounts: [] },
      prunedWrappers: [],
      sharedHistory: [],
    };

    // Act
    const actual = new FleetApplyFailureError({
      kind: 'history-failed-after-commit',
      failedHarness: 'codex',
      reason: 'pool is locked',
      committed,
    });

    // Assert
    should(actual.failure.kind).equal('history-failed-after-commit');
    should(actual.message).match(/was applied and its manifest published at \/state\/fleet\/manifest\.json/u);
    should(actual.message).match(/codex shared history failed afterwards: pool is locked/u);
  });
});
