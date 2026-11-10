/**
 * `@ferretry/core-ferrets/contract` (§2.2, §4.3, §4.4, §4.6): ferret identity and state, the harness, runner (with
 * `attach`, spine D15) and login kinds, the launch and sitrep hooks, `ferret.changed`, the Ferrets port and its files.
 * Re-exports the kernel-bound `WorkFolders` and `AgentControl` ports Ferrets provides (spine D4).
 */
export {
  AGENT_CONTROL_KINDS,
  type AgentControlKind,
  AgentControlPort,
  type AgentControlReader,
  type FencedPath,
  type FolderRefusal,
  type WorkFolders,
  WorkFoldersPort,
} from '@ferretry/kernel/contract';
export * from './instructions-report.ts';
export * from './hooks.ts';
export * from './ids.ts';
export * from './kinds.ts';
export * from './port.ts';
export * from './records.ts';
export * from './skill-home.ts';
export * from './slots.ts';
export * from './state.ts';
export * from './transfer.ts';
export * from './subtree.ts';
export * from './fork.ts';
export * from './handover.ts';
export * from './move.ts';
export * from './handover-state.ts';
export * from './transfer-state.ts';
export * from './sessions-root.ts';
export * from './move-state.ts';

/**
 * The ferret view (today's session view, moved here whole): what `GET /v1/ferrets/:ferretId` describes for a reader,
 * the live line while a turn runs, how full the context is, the in-ferret search query, and the file index the search reads (its schemas, limits and matching helpers). The daemon builds them;
 * the app's chat parses the same shapes.
 */
export { type FerretContext, FerretContextSchema, type FerretView, FerretViewSchema } from './view/ferret-view.ts';
export {
  compactionFreed,
  type FerretCompactionDone,
  type FerretCompactionRunning,
  type FerretLiveActivity,
  FerretLiveActivitySchema,
} from './view/session-live.ts';
export * from './view/session-search.ts';
export * from './pins.ts';
export * from './ferret-files.ts';
export * from './session-restart.ts';
export * from './start-requests.ts';
export * from './worktrees.ts';
export * from './view/event-stream.ts';
