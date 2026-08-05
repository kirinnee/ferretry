import { describe, it } from 'bun:test';
import should from 'should';
import type { FleetConfig } from '../../src/lib/config.ts';
import {
  type FleetApplyCommittedState,
  FleetApplyFailureError,
  type FleetApplyPlan,
  FleetApplyService,
  type FleetLayout,
  type FleetPlanBuilder,
  type FleetProvisioner,
} from '../../src/lib/provisioning.ts';

describe('FleetApplyService', () => {
  it('should build and apply one immutable plan', async () => {
    // Arrange
    const config = {} as FleetConfig;
    const layout: FleetLayout = {
      stateHome: '/tmp/fy-test/state',
      userHome: '/tmp/fy-test/user',
      fleetDirectory: '/tmp/fy-test/state/fleet',
      binDirectory: '/tmp/fy-test/state/fleet/bin',
      homesDirectory: '/tmp/fy-test/state/fleet/homes',
      assetsDirectory: '/tmp/fy-test/state/fleet/assets',
      manifestPath: '/tmp/fy-test/state/fleet/manifest.json',
      defaultHomeDirectories: { claude: '/tmp/fy-test/user/.claude', codex: '/tmp/fy-test/user/.codex' },
    };
    const generatedAt = '2027-01-15T08:00:00.000Z';
    const plan: FleetApplyPlan = {
      manifest: { version: 1, generatedAt, accounts: [] },
      manifestPath: layout.manifestPath,
      operations: [],
      sharedHistoryRequests: [],
    };
    const calls: unknown[] = [];
    const plans: FleetPlanBuilder = {
      build(actualConfig, actualLayout, actualGeneratedAt) {
        calls.push(['build', actualConfig, actualLayout, actualGeneratedAt]);
        return plan;
      },
    };
    const provisioner: FleetProvisioner = {
      async preview(actualPlan) {
        calls.push(['preview', actualPlan]);
        return { ...actualPlan, sharedHistory: [] };
      },
      async apply(actualPlan) {
        calls.push(['apply', actualPlan]);
        return {
          accountCount: 0,
          operationCount: 0,
          manifestPath: actualPlan.manifestPath,
          prunedWrappers: [],
          sharedHistory: [],
        };
      },
    };
    const subject = new FleetApplyService(plans, provisioner);

    // Act
    const actual = await subject.apply(config, layout, generatedAt);

    // Assert
    should(calls).deepEqual([
      ['build', config, layout, generatedAt],
      ['apply', plan],
    ]);
    should(actual).deepEqual({
      accountCount: 0,
      operationCount: 0,
      manifestPath: layout.manifestPath,
      prunedWrappers: [],
      sharedHistory: [],
    });
  });

  it('should build and preview one immutable plan', async () => {
    // Arrange
    const config = {} as FleetConfig;
    const layout = {
      stateHome: '/tmp/fy-test/state',
      userHome: '/tmp/fy-test/user',
      fleetDirectory: '/tmp/fy-test/state/fleet',
      binDirectory: '/tmp/fy-test/state/fleet/bin',
      homesDirectory: '/tmp/fy-test/state/fleet/homes',
      assetsDirectory: '/tmp/fy-test/state/fleet/assets',
      manifestPath: '/tmp/fy-test/state/fleet/manifest.json',
      defaultHomeDirectories: { claude: '/tmp/fy-test/user/.claude', codex: '/tmp/fy-test/user/.codex' },
    } as const satisfies FleetLayout;
    const plan: FleetApplyPlan = {
      manifest: { version: 1, generatedAt: '2027-01-15T08:00:00.000Z', accounts: [] },
      manifestPath: layout.manifestPath,
      operations: [],
      sharedHistoryRequests: [],
    };
    const plans: FleetPlanBuilder = { build: () => plan };
    const provisioner: FleetProvisioner = {
      preview: async actual => ({ ...actual, sharedHistory: [] }),
      apply: async () => {
        throw new Error('not called');
      },
    };

    // Act
    const actual = await new FleetApplyService(plans, provisioner).preview(config, layout, plan.manifest.generatedAt);

    // Assert
    should(actual).deepEqual({ ...plan, sharedHistory: [] });
  });
});

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
