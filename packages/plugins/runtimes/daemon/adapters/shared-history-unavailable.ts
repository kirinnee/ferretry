/**
 * The shared-history pooling this host does not have yet.
 *
 * The pooling is Conversation's. Until it is wired, every host that applies a plan carrying history requests supplies
 * THIS pooling: a preview leaves the request out of the plan and an apply skips it and says why. A provisioner given no
 * pooling at all refuses such a plan, so a host never silently plans a move it cannot make.
 */
import type { SharedHistoryPooling } from './ports.ts';

const SHARED_HISTORY_UNAVAILABLE =
  'pooling conversation history across runtimes is not available from the Runtimes plugin yet, so it was skipped';

export const unavailableSharedHistory: SharedHistoryPooling = {
  preview: async () => await Promise.reject(new Error(SHARED_HISTORY_UNAVAILABLE)),
  materialize: async () => await Promise.reject(new Error(SHARED_HISTORY_UNAVAILABLE)),
  isUnavailable: error => error instanceof Error && error.message === SHARED_HISTORY_UNAVAILABLE,
};
