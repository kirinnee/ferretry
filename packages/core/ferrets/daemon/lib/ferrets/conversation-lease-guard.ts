/**
 * The conversation lease as the launch's built-in INNERMOST guard (docs/design/account-model.md H2, §9.3): one live writer
 * per harness conversation. Built by the service from `FerretsPorts.leases` (never registered by a feature: the lifecycle's
 * own invariant, and the same lease object the session files claim by argv), so every lease call a launch makes goes
 * through the generic guard runner. Its errors are mapped HERE, so they never reach the runner's catch-all and its
 * sentences stay exactly what a launch has always said.
 */
import { ConversationLeaseHeldError } from '../../../contract/conversation-lease.ts';
import type { FerretId } from '../../../contract/index.ts';
import type { FerretLaunchLeases } from './launch-leases.ts';
import type { GuardVerdict, LaunchGuard } from './launch-steps.ts';

export const LEASE_UNCHECKED =
  'the ferret was not started: whether another session is writing its conversation could not be checked';
export const LEASE_UNHELD =
  'the ferret was stopped: its conversation could not be kept for it, and a second writer on it would corrupt it';

const ALLOW: GuardVerdict = { allow: true };

const refusal = (error: unknown, otherwise: string): GuardVerdict =>
  error instanceof ConversationLeaseHeldError
    ? { allow: false, code: 'refused', reason: error.message }
    : { allow: false, code: 'failed', reason: otherwise };

/**
 * Claims the conversation a launch resumes, or refuses with who holds it. Nothing is said of a lease store's own failure.
 * Also the restart hand-over's re-claim (`releaseLive`), which is not a launch phase.
 */
export async function claimConversationLease(
  leases: FerretLaunchLeases,
  ferret: FerretId,
  conversation: string,
): Promise<GuardVerdict> {
  try {
    await leases.claimConversation(ferret, conversation);
    return ALLOW;
  } catch (error) {
    return refusal(error, LEASE_UNCHECKED);
  }
}

/** Before the pane exists a conversation another live writer holds is refused, never taken over; a new one leases nothing. */
export function conversationLeaseGuard(leases: FerretLaunchLeases): LaunchGuard {
  return {
    id: 'conversation-lease',
    beforePane: async ({ record, conversation }) =>
      conversation === undefined ? ALLOW : await claimConversationLease(leases, record.id, conversation),
    // The open pane's conversation moves onto the pane's own pid. A conversation the harness has not named leases nothing.
    paneOpened: async ({ record, conversation, pid }) => {
      if (conversation === undefined) return ALLOW;
      try {
        await leases.moveConversationToPane(record.id, conversation, pid);
        return ALLOW;
      } catch (error) {
        return refusal(error, LEASE_UNHELD);
      }
    },
    // A lease that cannot be freed only delays a terminal claim: the daemon already reads a stopped session's as stale.
    released: async ferret => await leases.release(ferret),
  };
}
