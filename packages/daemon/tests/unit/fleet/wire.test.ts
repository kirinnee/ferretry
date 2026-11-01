import { describe, it } from 'bun:test';
import {
  type FleetApplyCommittedState,
  FleetApplyFailureError,
  type FleetApplyResult,
  type FleetManifest,
  type FleetWriteOperation,
  type SharedHistoryPreview,
} from '@ferretry/fleet';
import {
  FleetApplyOutcomeSchema,
  FleetApplyResultSchema,
  FleetManifestSummarySchema,
  FleetWriteOperationSchema,
} from '@ferretry/protocol';
import should from 'should';
import { applyFailureSummary, applyResultSummary, operationSummary } from '../../../src/lib/fleet/wire.ts';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

const manifest = (): FleetManifest => ({
  version: 1,
  generatedAt: '2027-01-15T08:00:00.000Z',
  accounts: [
    {
      secretEnv: {},
      id: ACCOUNT_ID,
      kind: 'claude',
      mode: 'auto',
      wrapper: '/state/fleet/bin/claude-kirin',
      home: '/state/fleet/homes/claude-kirin',
      displayName: 'Kirin',
      defaultModel: 'opus',
      models: [
        { id: 'opus', available: true, displayName: 'Opus' },
        { id: 'retired', available: false, unavailableReason: 'the provider withdrew it' },
      ],
      available: true,
      unavailableReason: null,
    },
  ],
});

const history = (): SharedHistoryPreview => ({
  kind: 'claude',
  pool: '/state/fleet/shared/claude',
  migrated: 3,
  conflicts: 1,
  links: 2,
  changes: [],
});

describe('operationSummary', () => {
  it.each([
    [
      { kind: 'directory', path: '/homes/one', mode: 0o700 },
      { kind: 'directory', path: '/homes/one', mode: 0o700 },
    ],
    [
      { kind: 'directory', path: '/homes/one' },
      { kind: 'directory', path: '/homes/one' },
    ],
    [
      { kind: 'symlink', source: '/assets/a.md', path: '/homes/one/a.md' },
      { kind: 'symlink', source: '/assets/a.md', path: '/homes/one/a.md' },
    ],
    [
      { kind: 'copy', source: '/assets/s', path: '/homes/one/s' },
      { kind: 'copy', source: '/assets/s', path: '/homes/one/s' },
    ],
    [
      { kind: 'copy', source: '/assets/s', path: '/homes/one/s', mode: 0o755 },
      { kind: 'copy', source: '/assets/s', path: '/homes/one/s', mode: 0o755 },
    ],
    [
      { kind: 'prune', path: '/bin', marker: '# managed', keep: ['claude-kirin'] },
      { kind: 'prune', path: '/bin', marker: '# managed', keep: ['claude-kirin'] },
    ],
    [
      { kind: 'prune-directory', path: '/homes/one/skills', keep: ['review', 'deploy'] },
      { kind: 'prune-directory', path: '/homes/one/skills', keep: ['review', 'deploy'] },
    ],
    [
      {
        kind: 'codex-sqlite-ownership',
        path: '/homes/one/config.toml',
        markerPath: '/homes/one/.marker.json',
        sqliteHome: '/shared/codex/sqlite',
        enabled: true,
      },
      {
        kind: 'codex-sqlite-ownership',
        path: '/homes/one/config.toml',
        markerPath: '/homes/one/.marker.json',
        sqliteHome: '/shared/codex/sqlite',
        enabled: true,
      },
    ],
  ] as const)('should carry %j across unchanged', (operation, expected) => {
    // Act
    const actual = operationSummary(operation as FleetWriteOperation);

    // Assert
    should(actual).deepEqual(expected);
  });

  it('should drop a wrapper script rather than ship thousands of bytes nobody reads', () => {
    // Act
    const actual = operationSummary({
      kind: 'file',
      path: '/bin/claude-kirin',
      content: '#!/bin/sh\n'.repeat(500),
      mode: 0o755,
    });

    // Assert
    should(actual).deepEqual({ kind: 'file', path: '/bin/claude-kirin', mode: 0o755 });
  });

  it('should report how many settings layers merge rather than what is in them', () => {
    // Act
    const actual = operationSummary({
      kind: 'settings',
      path: '/homes/one/settings.json',
      format: 'json',
      layers: [
        { from: 'inline', settings: { theme: 'dark' } },
        { from: 'file', path: '/assets/base.json' },
      ],
      mode: 0o600,
      preserveExisting: true,
    });

    // Assert
    should(actual).deepEqual({
      kind: 'settings',
      path: '/homes/one/settings.json',
      format: 'json',
      mode: 0o600,
      preserveExisting: true,
      layerCount: 2,
    });
  });
});

/** A history step that failed after the commit, carrying the fleet that landed. */
const committedFailure = (committed: FleetApplyCommittedState): FleetApplyFailureError =>
  new FleetApplyFailureError({
    kind: 'history-failed-after-commit',
    failedHarness: 'codex',
    reason: 'the pool is not writable',
    committed,
  });

const committedOf = (fleet: FleetManifest): FleetApplyCommittedState => ({
  accountCount: 1,
  operationCount: 6,
  manifestPath: '/state/fleet/manifest.json',
  manifest: fleet,
  prunedWrappers: [],
  sharedHistory: [],
});

/** The manifest a committed-with-history-failure outcome carries. */
const landedManifest = (fleet: FleetManifest) => {
  const actual = applyFailureSummary(committedFailure(committedOf(fleet)));
  if (actual.outcome !== 'committed-with-history-failure') throw new Error('expected a committed outcome');
  return actual.committed.manifest;
};

describe('the manifest a committed apply reports', () => {
  it('should carry every model, available and not, through the shared contract', () => {
    // Act
    const actual = landedManifest(manifest());

    // Assert — parsed, so the projection is proven against the schema its consumers read.
    should(FleetManifestSummarySchema.safeParse(actual).success).be.true();
    should(actual.accounts[0]?.models).deepEqual([
      { id: 'opus', available: true, displayName: 'Opus' },
      { id: 'retired', available: false, unavailableReason: 'the provider withdrew it' },
    ]);
  });

  it('should omit a display name a model does not have', () => {
    // Arrange
    const source = manifest();
    const [account] = source.accounts;
    if (account === undefined) throw new Error('the fixture declares one account');
    const bare: FleetManifest = {
      ...source,
      accounts: [
        {
          ...account,
          models: [
            { id: 'opus', available: true },
            { id: 'retired', available: false, unavailableReason: 'gone' },
          ],
        },
      ],
    };

    // Act
    const actual = landedManifest(bare);

    // Assert
    should(Object.hasOwn(actual.accounts[0]?.models[0] ?? {}, 'displayName')).be.false();
    should(Object.hasOwn(actual.accounts[0]?.models[1] ?? {}, 'displayName')).be.false();
  });
});

describe('applyResultSummary', () => {
  it('should say nothing about residue when an apply left none', () => {
    // Arrange
    const result: FleetApplyResult = {
      accountCount: 1,
      operationCount: 4,
      manifestPath: '/state/fleet/manifest.json',
      prunedWrappers: ['claude-retired'],
      sharedHistory: [history()],
    };

    // Act
    const actual = applyResultSummary(result);

    // Assert — absent rather than an empty array, so "nothing was left behind" reads as itself.
    should(FleetApplyResultSchema.safeParse(actual).success).be.true();
    should(Object.hasOwn(actual, 'backupResidue')).be.false();
    should(Object.hasOwn(actual, 'lockResidue')).be.false();
  });

  it('should report what each harness would move, per harness', () => {
    // Act
    const actual = applyResultSummary({
      accountCount: 1,
      operationCount: 4,
      manifestPath: '/state/fleet/manifest.json',
      prunedWrappers: [],
      sharedHistory: [history()],
    });

    // Assert — reported, never inferred from a total; the per-change detail stays out.
    should(actual.sharedHistory).deepEqual([
      { kind: 'claude', pool: '/state/fleet/shared/claude', migrated: 3, conflicts: 1, links: 2 },
    ]);
  });

  it('should carry both kinds of residue when an apply left them', () => {
    // Act
    const actual = applyResultSummary({
      accountCount: 0,
      operationCount: 1,
      manifestPath: '/state/fleet/manifest.json',
      prunedWrappers: [],
      sharedHistory: [],
      backupResidue: ['/state/fleet/bin/.fy-fleet-backup-abc'],
      lockResidue: '/state/fleet/.fy-fleet-apply.lock',
    });

    // Assert — a claim nobody cleared blocks the next apply, so it travels with a success too.
    should(actual.backupResidue).deepEqual(['/state/fleet/bin/.fy-fleet-backup-abc']);
    should(actual.lockResidue).equal('/state/fleet/.fy-fleet-apply.lock');
  });

  it('should carry what an apply left as the disk has it, and why', () => {
    // Act
    const actual = applyResultSummary({
      accountCount: 1,
      operationCount: 1,
      manifestPath: '/state/fleet/manifest.json',
      prunedWrappers: [],
      sharedHistory: [],
      skipped: [{ path: '/state/fleet/homes/one/skills', reason: 'not moving or removing it on this platform' }],
    });

    // Assert
    should(actual.skipped).deepEqual([
      { path: '/state/fleet/homes/one/skills', reason: 'not moving or removing it on this platform' },
    ]);
  });

  it('should name the runtime a skipped entry belongs to and its path inside that runtime', () => {
    // Arrange
    const account = manifest().accounts[0];
    if (account === undefined) throw new Error('fixture has an account');
    const home = account.home;

    // Act
    const actual = applyResultSummary(
      {
        accountCount: 1,
        operationCount: 1,
        manifestPath: '/state/fleet/manifest.json',
        prunedWrappers: [],
        sharedHistory: [],
        skipped: [
          { path: `${home}/skills/review`, reason: `not moving or removing ${home}/skills/review on this platform` },
          { path: '/elsewhere/skills', reason: 'not moving or removing it on this platform' },
        ],
      },
      [account],
    );

    // Assert — an entry outside every runtime folder is kept as it was, never guessed into one.
    should(actual.skipped?.[0]).deepEqual({
      path: `${home}/skills/review`,
      reason: `not moving or removing ${home}/skills/review on this platform`,
      runtime: ACCOUNT_ID,
      within: 'skills/review',
    });
    should(actual.skipped?.[1]).deepEqual({
      path: '/elsewhere/skills',
      reason: 'not moving or removing it on this platform',
    });
    should(FleetApplyResultSchema.safeParse(actual).success).be.true();
  });

  it('should not read a folder that merely starts with the runtime folder name as inside it', () => {
    // Arrange
    const account = manifest().accounts[0];
    if (account === undefined) throw new Error('fixture has an account');

    // Act
    const actual = applyResultSummary(
      {
        accountCount: 1,
        operationCount: 1,
        manifestPath: '/state/fleet/manifest.json',
        prunedWrappers: [],
        sharedHistory: [],
        skipped: [{ path: `${account.home}-two/skills`, reason: 'left as it was' }],
      },
      [account],
    );

    // Assert
    should(actual.skipped).deepEqual([{ path: `${account.home}-two/skills`, reason: 'left as it was' }]);
  });
});

describe('the committed state a history failure reports', () => {
  it('should describe the fleet that landed when only history failed afterwards', () => {
    // Arrange
    const committed: FleetApplyCommittedState = {
      ...committedOf(manifest()),
      sharedHistory: [history()],
      lockResidue: '/state/fleet/.fy-fleet-apply.lock',
    };

    // Act
    const actual = applyFailureSummary(committedFailure(committed));

    // Assert — the manifest is carried, because "your fleet did land" is the whole point.
    if (actual.outcome !== 'committed-with-history-failure') throw new Error('expected a committed outcome');
    should(actual.committed.manifest.accounts).have.length(1);
    should(actual.committed.manifestPath).equal('/state/fleet/manifest.json');
    should(actual.committed.lockResidue).equal('/state/fleet/.fy-fleet-apply.lock');
    should(actual.committed.sharedHistory).have.length(1);
  });

  it('should name the runtime of a skipped entry when only history failed afterwards', () => {
    // Arrange
    const fleet = manifest();
    const home = fleet.accounts[0]?.home ?? '';
    const committed: FleetApplyCommittedState = {
      ...committedOf(fleet),
      skipped: [{ path: `${home}/commands`, reason: 'left as it was' }],
    };

    // Act
    const actual = applyFailureSummary(committedFailure(committed));

    // Assert
    if (actual.outcome !== 'committed-with-history-failure') throw new Error('expected a committed outcome');
    should(actual.committed.skipped).deepEqual([
      { path: `${home}/commands`, reason: 'left as it was', runtime: ACCOUNT_ID, within: 'commands' },
    ]);
  });
});

describe('operationSummary for the account model', () => {
  it('should name a link allowed to point at nothing yet a credential link, so a reviewer is told', () => {
    // Act
    const actual = operationSummary({
      kind: 'symlink',
      source: '/state/fleet/credentials/codex-slot/auth.json',
      path: '/state/fleet/homes/one/auth.json',
      dangling: true,
    });

    // Assert
    should(actual).deepEqual({
      kind: 'credential-link',
      source: '/state/fleet/credentials/codex-slot/auth.json',
      path: '/state/fleet/homes/one/auth.json',
    });
    should(FleetWriteOperationSchema.safeParse(actual).success).be.true();
  });

  it('should name a document whose listed keys are replaced json-keys, with the keys it replaces', () => {
    // Act
    const actual = operationSummary({
      kind: 'settings',
      path: '/state/fleet/homes/one/.claude.json',
      format: 'json',
      layers: [{ from: 'inline', settings: { mcpServers: {} } }],
      mode: 0o600,
      preserveExisting: true,
      replaceKeys: ['mcpServers'],
    });

    // Assert
    should(actual).deepEqual({
      kind: 'json-keys',
      path: '/state/fleet/homes/one/.claude.json',
      format: 'json',
      mode: 0o600,
      replaceKeys: ['mcpServers'],
      layerCount: 1,
    });
    should(FleetWriteOperationSchema.safeParse(actual).success).be.true();
  });

  it('should name a sweep limited to what an earlier apply left a retire, with what it may remove', () => {
    // Act
    const actual = operationSummary({
      kind: 'prune-directory',
      path: '/state/fleet/homes/one',
      keep: ['CLAUDE.md'],
      only: ['CLAUDE.md', 'skills'],
      record: '/state/fleet/homes/one/.fy/materialised.json',
    });

    // Assert
    should(actual).deepEqual({
      kind: 'retire',
      path: '/state/fleet/homes/one',
      only: ['CLAUDE.md', 'skills'],
      keep: ['CLAUDE.md'],
    });
    should(FleetWriteOperationSchema.safeParse(actual).success).be.true();
  });
});

describe('applyFailureSummary', () => {
  it('should report a rolled-back apply in the words a person reads', () => {
    // Act
    const actual = applyFailureSummary(
      new FleetApplyFailureError({ kind: 'rolled-back', failedOperation: 'write /a', reason: 'disk full' }),
    );

    // Assert
    should(actual).deepEqual({ outcome: 'rolled-back', failedOperation: 'write /a', reason: 'disk full' });
    should(FleetApplyOutcomeSchema.safeParse(actual).success).be.true();
  });

  it('should carry what could not be restored, and what was set aside, when a rollback was incomplete', () => {
    // Act
    const actual = applyFailureSummary(
      new FleetApplyFailureError(
        {
          kind: 'rollback-incomplete',
          failedOperation: 'write /a',
          reason: 'disk full',
          unrestored: [{ path: '/a', reason: 'busy', backup: '/a.fy-backup' }],
          displaced: [{ path: '/b', movedTo: '/b.fy-displaced' }],
        },
        '/state/fleet/.fy-fleet-apply.lock',
      ),
    );

    // Assert
    should(actual).deepEqual({
      outcome: 'rollback-incomplete',
      failedOperation: 'write /a',
      reason: 'disk full',
      unrestored: [{ path: '/a', reason: 'busy', backup: '/a.fy-backup' }],
      displaced: [{ path: '/b', movedTo: '/b.fy-displaced' }],
      lockResidue: '/state/fleet/.fy-fleet-apply.lock',
    });
    should(FleetApplyOutcomeSchema.safeParse(actual).success).be.true();
  });

  it('should leave out displaced state a rollback never had to set aside', () => {
    // Act
    const actual = applyFailureSummary(
      new FleetApplyFailureError({
        kind: 'rollback-incomplete',
        failedOperation: 'write /a',
        reason: 'disk full',
        unrestored: [{ path: '/a', reason: 'busy' }],
      }),
    );

    // Assert
    should(actual).not.have.property('displaced');
    should(actual).not.have.property('lockResidue');
  });

  it('should say the fleet landed when only the history step failed after the commit', () => {
    // Act
    const actual = applyFailureSummary(
      new FleetApplyFailureError({
        kind: 'history-failed-after-commit',
        failedHarness: 'codex',
        reason: 'the pool is not writable',
        committed: {
          accountCount: 1,
          operationCount: 6,
          manifestPath: '/state/fleet/manifest.json',
          manifest: manifest(),
          prunedWrappers: [],
          sharedHistory: [],
        },
      }),
    );

    // Assert
    should(actual.outcome).equal('committed-with-history-failure');
    should(FleetApplyOutcomeSchema.safeParse(actual).success).be.true();
  });
});
