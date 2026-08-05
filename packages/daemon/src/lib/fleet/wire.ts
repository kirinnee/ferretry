/**
 * Project the fleet's own values onto the shared wire shapes.
 *
 * The browser does not depend on the fleet package, and that independence is the reason the shared
 * contract exists at all — so this is the boundary where a rich internal value becomes exactly the
 * fields a client renders, and no more.
 *
 * Two omissions are deliberate. A wrapper's rendered script never travels: it is thousands of bytes
 * nobody reads in a review, and carrying it would make the plan payload the largest thing in the
 * flow. A settings operation's resolved layers never travel either; their count does, because the
 * useful fact for a reader is how many things are being merged, not what is in them.
 *
 * Pure throughout, so every projection is a value a test can assert on.
 */
import type {
  FleetApplyCommittedState,
  FleetApplyPreview,
  FleetApplyResult,
  FleetManifest,
  FleetScaffold,
  FleetWriteOperation,
  SharedHistoryPreview,
} from '@ferretry/fleet';
import type {
  FleetApplyCommittedState as FleetWireCommittedState,
  FleetApplyResult as FleetWireApplyResult,
  FleetManifestSummary,
  FleetPlanSummary,
  FleetScaffoldSummary,
  FleetSharedHistorySummary,
  FleetWriteOperation as FleetWireOperation,
} from '@ferretry/protocol';

export function operationSummary(operation: FleetWriteOperation): FleetWireOperation {
  if (operation.kind === 'file') return { kind: 'file', path: operation.path, mode: operation.mode };
  if (operation.kind === 'settings') {
    return {
      kind: 'settings',
      path: operation.path,
      format: operation.format,
      mode: operation.mode,
      preserveExisting: operation.preserveExisting,
      layerCount: operation.layers.length,
    };
  }
  if (operation.kind === 'directory') {
    return {
      kind: 'directory',
      path: operation.path,
      ...(operation.mode === undefined ? {} : { mode: operation.mode }),
    };
  }
  if (operation.kind === 'copy') {
    return {
      kind: 'copy',
      source: operation.source,
      path: operation.path,
      ...(operation.mode === undefined ? {} : { mode: operation.mode }),
    };
  }
  if (operation.kind === 'symlink') return { kind: 'symlink', source: operation.source, path: operation.path };
  if (operation.kind === 'prune') {
    return { kind: 'prune', path: operation.path, marker: operation.marker, keep: [...operation.keep] };
  }
  return {
    kind: 'codex-sqlite-ownership',
    path: operation.path,
    markerPath: operation.markerPath,
    sqliteHome: operation.sqliteHome,
    enabled: operation.enabled,
  };
}

export function manifestSummary(manifest: FleetManifest): FleetManifestSummary {
  return {
    version: manifest.version,
    generatedAt: manifest.generatedAt,
    accounts: manifest.accounts.map(account => ({
      id: account.id,
      kind: account.kind,
      mode: account.mode,
      wrapper: account.wrapper,
      home: account.home,
      displayName: account.displayName,
      defaultModel: account.defaultModel,
      models: account.models.map(model =>
        model.available
          ? {
              id: model.id,
              available: true as const,
              ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
            }
          : {
              id: model.id,
              available: false as const,
              unavailableReason: model.unavailableReason,
              ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
            },
      ),
      available: account.available,
      unavailableReason: account.unavailableReason,
    })),
  };
}

/** What a history migration would move, per harness. Reported, never inferred from a total. */
export const historySummary = (previews: readonly SharedHistoryPreview[]): readonly FleetSharedHistorySummary[] =>
  previews.map(preview => ({
    kind: preview.kind,
    pool: preview.pool,
    migrated: preview.migrated,
    conflicts: preview.conflicts,
    links: preview.links,
  }));

export function planSummary(preview: FleetApplyPreview): FleetPlanSummary {
  return {
    manifest: manifestSummary(preview.manifest),
    manifestPath: preview.manifestPath,
    operations: preview.operations.map(operationSummary),
    sharedHistory: historySummary(preview.sharedHistory),
  };
}

export const scaffoldSummary = (scaffold: FleetScaffold): FleetScaffoldSummary => ({
  directories: [...scaffold.directories],
  files: scaffold.files.map(file => ({ path: file.path })),
  pathEntry: scaffold.pathEntry,
});

/** Residue is optional on the wire, so an apply that left none says nothing rather than empty. */
const residueOf = (value: { readonly backupResidue?: readonly string[]; readonly lockResidue?: string }) => ({
  ...(value.backupResidue === undefined ? {} : { backupResidue: [...value.backupResidue] }),
  ...(value.lockResidue === undefined ? {} : { lockResidue: value.lockResidue }),
});

export const applyResultSummary = (result: FleetApplyResult): FleetWireApplyResult => ({
  accountCount: result.accountCount,
  operationCount: result.operationCount,
  manifestPath: result.manifestPath,
  prunedWrappers: [...result.prunedWrappers],
  sharedHistory: historySummary(result.sharedHistory),
  ...residueOf(result),
});

export const committedSummary = (committed: FleetApplyCommittedState): FleetWireCommittedState => ({
  accountCount: committed.accountCount,
  operationCount: committed.operationCount,
  manifestPath: committed.manifestPath,
  manifest: manifestSummary(committed.manifest),
  prunedWrappers: [...committed.prunedWrappers],
  sharedHistory: historySummary(committed.sharedHistory),
  ...residueOf(committed),
});
