/** Stable role exposed by this workspace package's initial public surface. */
export const packageRole = 'fleet' as const;

export * from './account/adapt.ts';
export * from './account/clone.ts';
export * from './account/credential-status.ts';
export * from './account/credentials.ts';
export * from './account/fixed-layer.ts';
export * from './account/ids.ts';
export * from './account/import.ts';
export * from './account/layering.ts';
export * from './account/legacy.ts';
export * from './account/materialise.ts';
export * from './account/migration.ts';
export * from './account/schema.ts';
export * from './assets.ts';
export * from './capabilities.ts';
export * from './config.ts';
export * from './credential-seed.ts';
export * from './credential-source.ts';
export * from './defaults.ts';
export * from './env-profiles.ts';
export * from './harness.ts';
export * from './harness-env.ts';
export * from './harness-login.ts';
export * from './health.ts';
export * from './identity.ts';
export * from './login.ts';
export * from './manifest.ts';
export * from './paths.ts';
export * from './plan.ts';
export * from './profiles.ts';
export * from './provisioning.ts';
export * from './quota.ts';
export * from './scaffold.ts';
export * from './seed-provenance.ts';
export * from './settings.ts';
export * from './sharing.ts';
export {
  planSharedHistory,
  type SharedHistoryAction,
  type SharedHistoryChange,
  type SharedHistoryDirectoryNode,
  type SharedHistoryEntry,
  type SharedHistoryEntryType,
  type SharedHistoryFileNode,
  type SharedHistoryFileSystem,
  type SharedHistoryHome,
  SharedHistoryMigration,
  SharedHistoryMigrationError,
  type SharedHistoryNode,
  type SharedHistoryObservation,
  type SharedHistoryObservedHome,
  type SharedHistoryOtherNode,
  type SharedHistoryPlan,
  type SharedHistoryPreview,
  type SharedHistoryRequest,
  type SharedHistorySymbolicLinkNode,
  sharedHistoryEntries,
} from './shared-history.ts';
export * from './token-refresh.ts';
export * from './unimplemented.ts';
export * from './usage.ts';
export * from './wrappers.ts';
