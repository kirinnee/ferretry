/** Stable role exposed by this workspace package's initial public surface. */
export const packageRole = 'fleet' as const;

export * from './assets.ts';
export * from './capabilities.ts';
export * from './config.ts';
export * from './harness.ts';
export * from './harness-env.ts';
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
export * from './unimplemented.ts';
export * from './usage.ts';
export * from './wrappers.ts';
