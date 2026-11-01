/**
 * Why a ferret must not be moved right now: something of the owner's is open on it, and a move — which kills its
 * pane and relaunches it — would throw that away or pull the surface out from under the owner's hands.
 *
 * Each check is its own, and each says what it found in words the owner reads under Recent actions:
 *
 * - an input card the owner has not answered (`terminal_request_input`, `browser_request_input`, a sign-in choice);
 * - a sign-in waiting for the owner to approve it on their phone;
 * - a plan card (pastes, a sign-in) waiting for the owner's answer;
 * - a secure copy the ferret holds, which lives in this daemon's memory with its pane;
 * - a terminal or browser the ferret handed to the owner, who has not given it back;
 * - a permission prompt, or a harness dialog other than the usage-limit notice that made it a candidate.
 *
 * DELIBERATELY NOT a hold: an agenda item the ferret raised. It belongs to the session, which keeps its id across a
 * move, so the owner's answer still reaches it.
 *
 * FAILS CLOSED. A check that cannot be made is a reason not to move: an unreadable surface or session state says so.
 *
 * Pure but for its ports.
 */

import { SessionStateSchema } from '@ferretry/protocol';

export interface WardenOwnerHoldPorts {
  inputCardOpen(sessionId: string): boolean;
  phoneApprovalOpen(sessionId: string): boolean;
  planAwaitingOwner(sessionId: string): boolean;
  heldSecrets(sessionId: string): number;
  /** Whether the ferret handed this surface to the owner and has not had it back. Throws when it cannot be read. */
  surfaceAsked(sessionId: string, surface: 'terminal' | 'browser'): Promise<boolean>;
  /** The session's state document as stored. */
  state(sessionId: string): Promise<unknown>;
}

export async function ownerHoldReason(ports: WardenOwnerHoldPorts, sessionId: string): Promise<string | undefined> {
  if (ports.inputCardOpen(sessionId)) return 'it has an input card open for the owner';
  if (ports.phoneApprovalOpen(sessionId)) return 'it is waiting for the owner to approve a sign-in on their phone';
  if (ports.planAwaitingOwner(sessionId)) return 'it has a plan card waiting for the owner';
  if (ports.heldSecrets(sessionId) > 0) return 'it holds a secret it copied, which a move would drop';
  for (const surface of ['terminal', 'browser'] as const) {
    const asked = await ports.surfaceAsked(sessionId, surface).catch(() => undefined);
    if (asked === undefined) return `whether it handed its ${surface} to the owner could not be read`;
    if (asked) return `it handed its ${surface} to the owner, who has not given it back`;
  }
  const state = SessionStateSchema.safeParse(await ports.state(sessionId).catch(() => undefined));
  if (!state.success) return 'its state could not be read';
  if (state.data.permissionRequest !== undefined) return 'it is waiting on a permission prompt';
  const dialog = state.data.harnessDialog;
  if (dialog !== undefined && dialog.kind !== 'usage-limit') return `it is waiting on a dialog: ${dialog.title}`;
  return undefined;
}
