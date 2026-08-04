/**
 * WHO OPENED THIS SHELL — derivation and durable form, as pure decisions.
 *
 * Handover #34 asks for ownership that is DURABLE and VISIBLE. Two facts have to
 * be true for that to be worth anything, and both live here:
 *
 * DERIVED, NOT DECLARED. The class of the opener comes from the credential that
 * authenticated the request, never from the request body. A paired device is a
 * human holding it; the box's own admin token is something running locally. A
 * remote device therefore cannot open a shell and label it as an agent's — which
 * is the only reason `by: 'agent'` is worth reading before typing into one. The
 * single thing a caller may state is WHICH agent it is acting for, and only from
 * the local credential; a device that tries is REFUSED rather than quietly
 * downgraded, because silently recording the wrong owner is worse than failing.
 *
 * THREE OUTCOMES, NOT TWO. A request the daemon cannot attribute at all records
 * NOTHING and the terminal reads as unrecorded. That is not the same as `local`:
 * `local` is evidence that the box's own credential opened it, and no-evidence is
 * the absence of any. Inventing the benign reading here is the failure this
 * migration has already hit three times.
 *
 * THE DURABLE FORM IS THE PANE'S OWN. The encoding below is written into a tmux
 * user option beside the terminal's id and title, so ownership survives a daemon
 * restart, a reconnect and a redeploy — it lives exactly as long as the shell it
 * describes. Decoding is TOTAL: anything this daemon did not write, including a
 * value from a future build, decodes to nothing and the terminal reads as
 * unrecorded rather than as a guess.
 */

import { type SurfaceOpener, SurfaceOpenerSchema } from '@ferretry/protocol';

/** The authenticated credential, reduced to what ownership depends on. */
export type TerminalOpenerCredential =
  | { readonly tokenClass: 'admin' | 'warden' }
  | { readonly tokenClass: 'device'; readonly deviceId: string };

export type TerminalOpenerDecision =
  /** Record this opener against the new terminal. */
  | { readonly outcome: 'attributed'; readonly openedBy: SurfaceOpener }
  /** Open it, but record no opener: nothing here can be attested. */
  | { readonly outcome: 'unattributed' }
  /** Do not open it at all — the caller asked to be recorded as someone it is not. */
  | { readonly outcome: 'refused'; readonly reason: string };

/**
 * Decides the opener for one create request.
 *
 * `agentSessionId` is the caller's claim about WHO it acts for; the credential
 * decides whether that claim is admissible. A warden token is refused outright:
 * it exists to judge sessions, and a shell it opened would be attributable to
 * nothing a reader could act on.
 */
export function decideTerminalOpener(
  credential: TerminalOpenerCredential | undefined,
  agentSessionId: string | undefined,
): TerminalOpenerDecision {
  const declared = agentSessionId?.trim() ?? '';
  if (credential === undefined) {
    // Nothing authenticated this that we can see. A declared agent cannot be
    // admitted on no evidence, and inventing `local` would claim evidence we do
    // not have — so the terminal opens with its ownership honestly blank.
    if (declared !== '') return { outcome: 'refused', reason: 'an unattributed caller may not name an agent owner' };
    return { outcome: 'unattributed' };
  }
  if (credential.tokenClass === 'warden')
    return { outcome: 'refused', reason: 'a warden credential may not open a terminal' };
  if (credential.tokenClass === 'device') {
    if (declared !== '') return { outcome: 'refused', reason: 'a paired device may not open a terminal as an agent' };
    const parsed = SurfaceOpenerSchema.safeParse({ by: 'human', deviceId: credential.deviceId });
    // A device id this daemon cannot represent on the wire is not a reason to
    // refuse the shell — but it is a reason not to print an unrenderable owner.
    return parsed.success ? { outcome: 'attributed', openedBy: parsed.data } : { outcome: 'unattributed' };
  }
  if (declared === '') return { outcome: 'attributed', openedBy: { by: 'local' } };
  const parsed = SurfaceOpenerSchema.safeParse({ by: 'agent', sessionId: declared });
  if (!parsed.success) return { outcome: 'refused', reason: 'the agent session id is not a usable identity' };
  return { outcome: 'attributed', openedBy: parsed.data };
}

/** The durable form written beside the terminal's own id on the pane. */
export function encodeTerminalOpener(opener: SurfaceOpener): string {
  if (opener.by === 'human') return `human:${opener.deviceId}`;
  if (opener.by === 'agent') return `agent:${opener.sessionId}`;
  return 'local';
}

/**
 * Reads back what was written, and NOTHING else.
 *
 * An unset tmux option answers with the empty string, a build older than this one
 * wrote no option at all, and a future build may write a class this one has never
 * heard of. All three are the same answer here: no evidence, so the terminal
 * reads as unrecorded.
 */
export function decodeTerminalOpener(raw: string | undefined): SurfaceOpener | undefined {
  const value = raw?.trim() ?? '';
  if (value === '') return undefined;
  if (value === 'local') return { by: 'local' };
  const separator = value.indexOf(':');
  if (separator <= 0) return undefined;
  const kind = value.slice(0, separator);
  const identity = value.slice(separator + 1);
  const candidate =
    kind === 'human'
      ? { by: 'human', deviceId: identity }
      : kind === 'agent'
        ? { by: 'agent', sessionId: identity }
        : undefined;
  if (candidate === undefined) return undefined;
  const parsed = SurfaceOpenerSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
