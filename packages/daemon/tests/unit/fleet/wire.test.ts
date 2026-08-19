import { describe, it } from 'bun:test';
import type {
  FleetApplyCommittedState,
  FleetApplyPreview,
  FleetApplyResult,
  FleetManifest,
  FleetScaffold,
  FleetWriteOperation,
  SharedHistoryPreview,
} from '@ferretry/fleet';
import { FleetApplyResultSchema, FleetManifestSummarySchema, FleetPlanSummarySchema } from '@ferretry/protocol';
import should from 'should';
import {
  applyResultSummary,
  committedSummary,
  historySummary,
  manifestSummary,
  operationSummary,
  planSummary,
  scaffoldSummary,
} from '../../../src/lib/fleet/wire.ts';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

const manifest = (): FleetManifest => ({
  version: 1,
  generatedAt: '2027-01-15T08:00:00.000Z',
  accounts: [
    {
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

describe('manifestSummary', () => {
  it('should carry every model, available and not, through the shared contract', () => {
    // Act
    const actual = manifestSummary(manifest());

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
    const bare: FleetManifest = {
      ...source,
      accounts: [{ ...source.accounts[0]!, models: [{ id: 'opus', available: true }] }],
    };

    // Act
    const actual = manifestSummary(bare);

    // Assert
    should(Object.hasOwn(actual.accounts[0]?.models[0] ?? {}, 'displayName')).be.false();
  });
});

describe('historySummary', () => {
  it('should report what each harness would move, per harness', () => {
    // Act
    const actual = historySummary([history()]);

    // Assert
    should(actual).deepEqual([
      { kind: 'claude', pool: '/state/fleet/shared/claude', migrated: 3, conflicts: 1, links: 2 },
    ]);
  });
});

describe('planSummary', () => {
  it('should describe a whole plan in the shape a reviewer reads', () => {
    // Arrange
    const preview: FleetApplyPreview = {
      manifest: manifest(),
      manifestPath: '/state/fleet/manifest.json',
      operations: [{ kind: 'file', path: '/bin/claude-kirin', content: 'script', mode: 0o755 }],
      sharedHistory: [history()],
    };

    // Act
    const actual = planSummary(preview);

    // Assert
    should(FleetPlanSummarySchema.safeParse(actual).success).be.true();
    should(actual.operations).deepEqual([{ kind: 'file', path: '/bin/claude-kirin', mode: 0o755 }]);
    should(actual.sharedHistory).have.length(1);
  });
});

describe('scaffoldSummary', () => {
  it('should name the files a first run creates as objects, not bare strings', () => {
    // Arrange
    const scaffold: FleetScaffold = {
      directories: ['/state/fleet', '/state/fleet/bin'],
      directoryMode: 0o700,
      files: [{ path: '/state/fleet/config.yaml', content: 'agents: []\n', mode: 0o600 }],
      pathEntry: 'export PATH="/state/fleet/bin:$PATH"',
    };

    // Act
    const actual = scaffoldSummary(scaffold);

    // Assert
    should(actual).deepEqual({
      directories: ['/state/fleet', '/state/fleet/bin'],
      files: [{ path: '/state/fleet/config.yaml' }],
      pathEntry: 'export PATH="/state/fleet/bin:$PATH"',
    });
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
});

describe('committedSummary', () => {
  it('should describe the fleet that landed when only history failed afterwards', () => {
    // Arrange
    const committed: FleetApplyCommittedState = {
      accountCount: 1,
      operationCount: 6,
      manifestPath: '/state/fleet/manifest.json',
      manifest: manifest(),
      prunedWrappers: [],
      sharedHistory: [],
      lockResidue: '/state/fleet/.fy-fleet-apply.lock',
    };

    // Act
    const actual = committedSummary(committed);

    // Assert — the manifest is carried, because "your fleet did land" is the whole point.
    should(actual.manifest.accounts).have.length(1);
    should(actual.manifestPath).equal('/state/fleet/manifest.json');
    should(actual.lockResidue).equal('/state/fleet/.fy-fleet-apply.lock');
  });
});
