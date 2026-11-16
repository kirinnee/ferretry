/**
 * The fleet's own values projected onto the shared wire shapes: what a plan operation is called, what an
 * apply result carries, and how each way an apply can fail reads to the person.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { ApplyOutcomeSchema, WriteOperationSchema } from '../../../contract/index.ts';
import { FleetManifestSchema } from '../../../daemon/lib/manifest.ts';
import {
  type FleetApplyResult,
  type FleetWriteOperation,
  FleetApplyFailureError,
} from '../../../daemon/lib/provisioning.ts';
import {
  applyFailureSummary,
  applyResultSummary,
  operationSummary,
  skippedWithinRuntimes,
} from '../../../daemon/lib/service/wire.ts';

const HISTORY = [
  {
    kind: 'claude' as const,
    pool: '/fy/pool/claude',
    moved: 3,
    conflicts: 1,
    links: 2,
    changes: [],
    emptiedSourceDirectories: [],
    refusals: [],
  },
];

describe('operationSummary', () => {
  const cases: readonly { readonly name: string; readonly operation: FleetWriteOperation; readonly wire: unknown }[] = [
    {
      name: 'a file keeps its path and mode but never its content',
      operation: { kind: 'file', path: '/h/a', content: 'SCRIPT', mode: 0o600 },
      wire: { kind: 'file', path: '/h/a', mode: 0o600 },
    },
    {
      name: 'a settings write with replaced keys is named json-keys and carries the layer count',
      operation: {
        kind: 'settings',
        path: '/h/.claude.json',
        format: 'json',
        mode: 0o600,
        layers: [{ from: 'inline', settings: {} }],
        preserveExisting: true,
        replaceKeys: ['mcpServers'],
      },
      wire: {
        kind: 'json-keys',
        path: '/h/.claude.json',
        format: 'json',
        mode: 0o600,
        replaceKeys: ['mcpServers'],
        layerCount: 1,
      },
    },
    {
      name: 'a plain settings write keeps preserveExisting and the layer count',
      operation: {
        kind: 'settings',
        path: '/h/settings.json',
        format: 'json',
        mode: 0o600,
        layers: [
          { from: 'inline', settings: {} },
          { from: 'file', path: '/a/b.json' },
        ],
        preserveExisting: false,
      },
      wire: {
        kind: 'settings',
        path: '/h/settings.json',
        format: 'json',
        mode: 0o600,
        preserveExisting: false,
        layerCount: 2,
      },
    },
    {
      name: 'a directory without a mode says no mode',
      operation: { kind: 'directory', path: '/h/d' },
      wire: { kind: 'directory', path: '/h/d' },
    },
    {
      name: 'a directory with a mode carries it',
      operation: { kind: 'directory', path: '/h/d', mode: 0o700 },
      wire: { kind: 'directory', path: '/h/d', mode: 0o700 },
    },
    {
      name: 'a copy without a mode says no mode',
      operation: { kind: 'copy', source: '/s', path: '/h/c' },
      wire: { kind: 'copy', source: '/s', path: '/h/c' },
    },
    {
      name: 'a copy with a mode carries it',
      operation: { kind: 'copy', source: '/s', path: '/h/c', mode: 0o644 },
      wire: { kind: 'copy', source: '/s', path: '/h/c', mode: 0o644 },
    },
    {
      name: 'a link allowed to dangle is a credential-link',
      operation: { kind: 'symlink', source: '/s/auth.json', path: '/h/auth.json', dangling: true },
      wire: { kind: 'credential-link', source: '/s/auth.json', path: '/h/auth.json' },
    },
    {
      name: 'an ordinary link stays a symlink',
      operation: { kind: 'symlink', source: '/s', path: '/h/l' },
      wire: { kind: 'symlink', source: '/s', path: '/h/l' },
    },
    {
      name: 'a prune carries its marker and keep list',
      operation: { kind: 'prune', path: '/h/bin', marker: 'MANAGED', keep: ['a'] },
      wire: { kind: 'prune', path: '/h/bin', marker: 'MANAGED', keep: ['a'] },
    },
    {
      name: 'a narrowed directory sweep is a retire',
      operation: { kind: 'prune-directory', path: '/h/skills', keep: ['k'], only: ['old'] },
      wire: { kind: 'retire', path: '/h/skills', only: ['old'], keep: ['k'] },
    },
    {
      name: 'a whole-directory sweep stays a prune-directory',
      operation: { kind: 'prune-directory', path: '/h/skills', keep: ['k'] },
      wire: { kind: 'prune-directory', path: '/h/skills', keep: ['k'] },
    },
  ];
  for (const { name, operation, wire } of cases) {
    it(`should project ${name}`, () => {
      const summary = operationSummary(operation);
      should(summary).deepEqual(wire);
      should(WriteOperationSchema.safeParse(summary).success).be.true();
    });
  }
});

describe('skippedWithinRuntimes', () => {
  const accounts = [
    { id: 'one', home: '/h/one/' },
    { id: 'two', home: '/h/two' },
  ];
  it('should say nothing when an apply skipped nothing', () => {
    should(skippedWithinRuntimes(undefined, accounts)).deepEqual({});
  });
  it("should key each skipped path by its runtime, relative to that runtime's folder", () => {
    const found = skippedWithinRuntimes([{ path: '/h/one/a/b' }, { path: '/h/two/c' }, { path: '/h/one/d' }], accounts);
    should(found).deepEqual({ one: ['a/b', 'd'], two: ['c'] });
  });
  it('should leave out a path in no runtime folder, and the folder itself', () => {
    should(
      skippedWithinRuntimes([{ path: '/elsewhere/x' }, { path: '/h/one/' }, { path: '/h/two' }], accounts),
    ).deepEqual({});
  });
});

describe('applyResultSummary', () => {
  const base: FleetApplyResult = {
    accountCount: 2,
    operationCount: 9,
    manifestPath: '/fy/fleet/manifest.json',
    prunedWrappers: ['old'],
    sharedHistory: HISTORY,
  };
  it('should carry only the counts, the pruned wrappers and the history totals when no residue was left', () => {
    should(applyResultSummary(base)).deepEqual({
      accountCount: 2,
      operationCount: 9,
      manifestPath: '/fy/fleet/manifest.json',
      prunedWrappers: ['old'],
      sharedHistory: [{ kind: 'claude-code', pool: '/fy/pool/claude', moved: 3, conflicts: 1, links: 2 }],
    });
  });
  it('should carry backup residue, a lock residue and the skipped paths when an apply left them', () => {
    const summary = applyResultSummary({
      ...base,
      backupResidue: ['/x.bak'],
      lockResidue: '/fy/lock',
      skipped: [{ path: '/h/a', reason: 'no descriptor', extra: 'dropped' } as { path: string; reason: string }],
    });
    should(summary.backupResidue).deepEqual(['/x.bak']);
    should(summary.lockResidue).equal('/fy/lock');
    should(summary.skipped).deepEqual([{ path: '/h/a', reason: 'no descriptor' }]);
  });
});

describe('applyFailureSummary', () => {
  const MANIFEST = FleetManifestSchema.parse({
    version: 1,
    generatedAt: '2027-01-15T08:00:00.000Z',
    accounts: [
      {
        id: '0b8f3a52-6d1e-4c7a-9f2b-3e5d7a1c9b04',
        kind: 'claude',
        mode: 'interactive',
        wrapper: '/fy/fleet/bin/one',
        home: '/fy/fleet/homes/one',
        displayName: 'One',
        defaultModel: 'm1',
        models: [
          { id: 'm1', available: true },
          { id: 'm2', displayName: 'Model Two', available: true },
          { id: 'm3', available: false, unavailableReason: 'plan' },
          { id: 'm4', displayName: 'Model Four', available: false, unavailableReason: 'plan' },
        ],
        available: true,
        unavailableReason: null,
      },
    ],
    runtimes: [],
  });

  it('should read a failure after the commit as committed, carrying the manifest summary and the lock residue', () => {
    const outcome = applyFailureSummary(
      new FleetApplyFailureError(
        {
          kind: 'history-failed-after-commit',
          failedHarness: 'claude',
          reason: 'disk full',
          committed: {
            accountCount: 1,
            operationCount: 4,
            manifestPath: '/fy/fleet/manifest.json',
            manifest: MANIFEST,
            prunedWrappers: [],
            sharedHistory: HISTORY,
            lockResidue: '/fy/lock',
          },
        },
        '/fy/lock',
      ),
    );
    should(ApplyOutcomeSchema.safeParse(outcome).success).be.true();
    if (outcome.outcome !== 'committed-with-history-failure') throw new Error('expected a committed outcome');
    should(outcome.lockResidue).equal('/fy/lock');
    should(outcome.committed.lockResidue).equal('/fy/lock');
    should(outcome.committed.manifest.accounts[0]).deepEqual({
      id: '0b8f3a52-6d1e-4c7a-9f2b-3e5d7a1c9b04',
      kind: 'claude-code',
      mode: 'interactive',
      wrapper: '/fy/fleet/bin/one',
      home: '/fy/fleet/homes/one',
      displayName: 'One',
      defaultModel: 'm1',
      models: [
        { id: 'm1', available: true },
        { id: 'm2', available: true, displayName: 'Model Two' },
        { id: 'm3', available: false, unavailableReason: 'plan' },
        { id: 'm4', available: false, unavailableReason: 'plan', displayName: 'Model Four' },
      ],
      available: true,
      unavailableReason: null,
    });
  });

  it('should read an unverified restoration as rollback-incomplete with what was displaced', () => {
    const outcome = applyFailureSummary(
      new FleetApplyFailureError({
        kind: 'rollback-incomplete',
        failedOperation: 'write /h/a',
        reason: 'boom',
        unrestored: [{ path: '/h/a', reason: 'changed' }],
        displaced: [{ path: '/h/b', movedTo: '/h/b.aside' }],
      }),
    );
    should(ApplyOutcomeSchema.safeParse(outcome).success).be.true();
    should(outcome).deepEqual({
      outcome: 'rollback-incomplete',
      failedOperation: 'write /h/a',
      reason: 'boom',
      unrestored: [{ path: '/h/a', reason: 'changed' }],
      displaced: [{ path: '/h/b', movedTo: '/h/b.aside' }],
    });
  });

  it('should leave displaced out of rollback-incomplete when nothing was moved aside', () => {
    const outcome = applyFailureSummary(
      new FleetApplyFailureError(
        {
          kind: 'rollback-incomplete',
          failedOperation: 'write /h/a',
          reason: 'boom',
          unrestored: [{ path: '/h/a', reason: 'changed' }],
        },
        '/fy/lock',
      ),
    );
    should(outcome).deepEqual({
      outcome: 'rollback-incomplete',
      failedOperation: 'write /h/a',
      reason: 'boom',
      unrestored: [{ path: '/h/a', reason: 'changed' }],
      lockResidue: '/fy/lock',
    });
  });

  it('BG-031 OM6 should carry the landed configuration files on a rollback-incomplete outcome', () => {
    const outcome = applyFailureSummary(
      new FleetApplyFailureError({
        kind: 'rollback-incomplete',
        failedOperation: 'write /h/a',
        reason: 'boom',
        unrestored: [{ path: '/h/a', reason: 'changed' }],
      }),
      ['/c/runtimes/work.yaml'],
    );
    should(ApplyOutcomeSchema.safeParse(outcome).success).be.true();
    should(outcome).have.property('configurationLanded', ['/c/runtimes/work.yaml']);
  });

  it('BG-031 OM8 should carry no landed files on a committed-with-history-failure outcome, which the strict client parse would reject', () => {
    const outcome = applyFailureSummary(
      new FleetApplyFailureError({
        kind: 'history-failed-after-commit',
        failedHarness: 'claude',
        reason: 'disk full',
        committed: {
          accountCount: 1,
          operationCount: 4,
          manifestPath: '/fy/fleet/manifest.json',
          manifest: MANIFEST,
          prunedWrappers: [],
          sharedHistory: HISTORY,
        },
      }),
      ['/c/runtimes/work.yaml'],
    );
    should(ApplyOutcomeSchema.safeParse(outcome).success).be.true();
    should(outcome).not.have.property('configurationLanded');
  });

  it('should read a restored host as rolled-back', () => {
    should(
      applyFailureSummary(
        new FleetApplyFailureError({ kind: 'rolled-back', failedOperation: 'write /h/a', reason: 'boom' }),
      ),
    ).deepEqual({ outcome: 'rolled-back', failedOperation: 'write /h/a', reason: 'boom' });
  });
});
