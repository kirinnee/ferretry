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
  FleetApplyFailureError,
  FleetApplyResult,
  FleetManifest,
  FleetWriteOperation,
  SharedHistoryPreview,
} from '@ferretry/fleet';
import type {
  FleetApplyCommittedState as FleetWireCommittedState,
  FleetApplyOutcome as FleetWireApplyOutcome,
  FleetApplyResult as FleetWireApplyResult,
  FleetManifestSummary,
  FleetSharedHistorySummary,
  FleetWriteOperation as FleetWireOperation,
} from '@ferretry/protocol';

/**
 * One plan operation as the person approving it reads it.
 *
 * THREE BEHAVIOURS GET THEIR OWN WORDS on the wire even though the plan spells them as options on an
 * older kind. A link allowed to point at nothing yet, a document whose named keys are replaced while
 * the harness keeps the rest, and a sweep limited to what an earlier apply left behind each do
 * something a reviewer would misread under the older name — "symlink", "settings", "remove unselected
 * items" — so the wire says `credential-link`, `json-keys` and `retire`, and every reader renders
 * those. The plan keeps its options because the provisioner's checks are shared with the plain kinds.
 */
export function operationSummary(operation: FleetWriteOperation): FleetWireOperation {
  if (operation.kind === 'file') return { kind: 'file', path: operation.path, mode: operation.mode };
  if (operation.kind === 'settings' && operation.replaceKeys !== undefined) {
    return {
      kind: 'json-keys',
      path: operation.path,
      format: operation.format,
      mode: operation.mode,
      replaceKeys: [...operation.replaceKeys],
      layerCount: operation.layers.length,
    };
  }
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
  if (operation.kind === 'symlink') {
    return {
      kind: operation.dangling === true ? 'credential-link' : 'symlink',
      source: operation.source,
      path: operation.path,
    };
  }
  if (operation.kind === 'prune') {
    return { kind: 'prune', path: operation.path, marker: operation.marker, keep: [...operation.keep] };
  }
  if (operation.kind === 'prune-directory' && operation.only !== undefined) {
    return { kind: 'retire', path: operation.path, only: [...operation.only], keep: [...operation.keep] };
  }
  if (operation.kind === 'prune-directory') {
    return { kind: 'prune-directory', path: operation.path, keep: [...operation.keep] };
  }
  return {
    kind: 'codex-sqlite-ownership',
    path: operation.path,
    markerPath: operation.markerPath,
    sqliteHome: operation.sqliteHome,
    enabled: operation.enabled,
  };
}

function manifestSummary(manifest: FleetManifest): FleetManifestSummary {
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
const historySummary = (previews: readonly SharedHistoryPreview[]): readonly FleetSharedHistorySummary[] =>
  previews.map(preview => ({
    kind: preview.kind,
    pool: preview.pool,
    migrated: preview.migrated,
    conflicts: preview.conflicts,
    links: preview.links,
  }));

/**
 * Each runtime's skipped paths from an apply, inside that runtime's own folder and keyed by its id. A path in no
 * runtime's folder is left out: it names nothing a runtime could say, and the folder's place on disk stays here.
 */
export const skippedWithinRuntimes = (
  skipped: readonly { readonly path: string }[] | undefined,
  accounts: readonly { readonly id: string; readonly home: string }[],
): Readonly<Record<string, readonly string[]>> => {
  const found: Record<string, readonly string[]> = {};
  for (const { path } of skipped ?? []) {
    for (const { id, home } of accounts) {
      const folder = `${home.replace(/\/+$/u, '')}/`;
      if (!path.startsWith(folder) || path.length === folder.length) continue;
      found[id] = [...(found[id] ?? []), path.slice(folder.length)];
      break;
    }
  }
  return found;
};

/** Residue is optional on the wire, so an apply that left none says nothing rather than empty. */
const residueOf = (value: {
  readonly backupResidue?: readonly string[];
  readonly lockResidue?: string;
  readonly skipped?: readonly { readonly path: string; readonly reason: string }[];
}) => ({
  ...(value.backupResidue === undefined ? {} : { backupResidue: [...value.backupResidue] }),
  ...(value.lockResidue === undefined ? {} : { lockResidue: value.lockResidue }),
  ...(value.skipped === undefined ? {} : { skipped: value.skipped.map(({ path, reason }) => ({ path, reason })) }),
});

export const applyResultSummary = (result: FleetApplyResult): FleetWireApplyResult => ({
  accountCount: result.accountCount,
  operationCount: result.operationCount,
  manifestPath: result.manifestPath,
  prunedWrappers: [...result.prunedWrappers],
  sharedHistory: historySummary(result.sharedHistory),
  ...residueOf(result),
});

const committedSummary = (committed: FleetApplyCommittedState): FleetWireCommittedState => ({
  accountCount: committed.accountCount,
  operationCount: committed.operationCount,
  manifestPath: committed.manifestPath,
  manifest: manifestSummary(committed.manifest),
  prunedWrappers: [...committed.prunedWrappers],
  sharedHistory: historySummary(committed.sharedHistory),
  ...residueOf(committed),
});

/**
 * A failed apply as the outcome a person reads: rolled back, rolled back only in part, or committed
 * with the history step failing afterwards.
 *
 */
export function applyFailureSummary(error: FleetApplyFailureError): FleetWireApplyOutcome {
  const failure = error.failure;
  // A claim nobody cleared blocks the next apply whatever else happened, so it travels with every ending.
  const residue = error.lockResidue === undefined ? {} : { lockResidue: error.lockResidue };
  if (failure.kind === 'history-failed-after-commit') {
    return {
      outcome: 'committed-with-history-failure',
      failedHarness: failure.failedHarness,
      reason: failure.reason,
      committed: committedSummary(failure.committed),
      ...residue,
    };
  }
  if (failure.kind === 'rollback-incomplete') {
    return {
      outcome: 'rollback-incomplete',
      failedOperation: failure.failedOperation,
      reason: failure.reason,
      unrestored: failure.unrestored.map(entry => ({ ...entry })),
      ...(failure.displaced === undefined ? {} : { displaced: failure.displaced.map(entry => ({ ...entry })) }),
      ...residue,
    };
  }
  return { outcome: 'rolled-back', failedOperation: failure.failedOperation, reason: failure.reason, ...residue };
}
