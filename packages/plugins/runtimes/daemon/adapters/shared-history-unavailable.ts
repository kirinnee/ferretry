/**
 * A Runtimes apply does not pool history.
 *
 * The shared history pool is each harness plugin's own (docs/design/shared-history.md): Claude Code and Codex link every
 * history entry of a ferret's home to their one pool when the ferret starts. So a plan carrying a history request has it
 * left out of a preview and skipped, with the reason, by an apply; nothing a Runtimes apply writes is the pool. A
 * provisioner given no pooling at all refuses such a plan, so a host never silently plans a move it cannot make.
 */
import type { SharedHistoryPooling } from './ports.ts';

const SHARED_HISTORY_UNAVAILABLE =
  'shared history is linked by each harness when a ferret starts, not by a Runtimes apply, so this request was skipped';

export const unavailableSharedHistory: SharedHistoryPooling = {
  preview: async () => await Promise.reject(new Error(SHARED_HISTORY_UNAVAILABLE)),
  materialize: async () => await Promise.reject(new Error(SHARED_HISTORY_UNAVAILABLE)),
  isUnavailable: error => error instanceof Error && error.message === SHARED_HISTORY_UNAVAILABLE,
};
