/**
 * What a session's link needs from the member side, as ONE port (docs/relay-protocol.md §14 "Member sessions").
 *
 * Like the pairing port, it is how a join happens with no route involved at all; unlike it, it also carries
 * the request session's three needs: the key to verify, the live registration, and the member route table.
 * `dispatch` is the ONLY door a member's request has — the link never hands one to the device dispatcher.
 */
import type { MemberJoinedResponse, MemberJoinProof, StepUpOptions } from '../lib/boundary.ts';

/**
 * Where a join arrived. Only a direct socket has a peer worth keying a budget by: a relayed session's
 * address is the relay's, and a tunnel's is the tunnel's.
 */
export type MemberJoinCarrier =
  | { readonly kind: 'relay' }
  | { readonly kind: 'tunnel' }
  | { readonly kind: 'direct'; readonly rateLimitKey: string };

/** A join record exactly as the browser sent it: nothing in it has been judged yet. */
export interface MemberJoinAttempt {
  readonly code: string;
  readonly clientName: string;
  readonly memberKey: string;
  readonly boxKey: string;
  /** One of the person's passkeys proved, for a code that names a person who already has one. */
  readonly passkey?: MemberJoinProof;
  /** Run only after the cheap checks pass, so a stranger cannot make this daemon verify a signature first. */
  readonly prove: () => Promise<boolean>;
}

/** `ok: false` is the one generic refusal; the port never says why. */
export type MemberJoinResult = { readonly ok: true; readonly response: MemberJoinedResponse } | { readonly ok: false };

/** A `join-options` record exactly as the browser sent it. */
export interface MemberJoinOptionsAttempt {
  readonly code: string;
  readonly memberKey: string;
  /** The page's origin: the passkeys offered are the ones made there. */
  readonly origin: string;
  /** Run only after the cheap checks pass, so a stranger cannot make this daemon verify a signature first. */
  readonly prove: () => Promise<boolean>;
}

/**
 * What joining with a code needs. `open`: no proof (the person's first browser, or an invite the owner marked "They need
 * a new passkey"). `challenge`: prove one of these passkeys. `ok: false` is the one generic refusal, which also covers
 * "this person has no passkey that answers at this page".
 */
export type MemberJoinAnswer =
  | { readonly kind: 'open'; readonly why: 'first-browser' | 'owner-approved' }
  | { readonly kind: 'challenge'; readonly memberLabel: string; readonly options: StepUpOptions };

export type MemberJoinOptionsResult = { readonly ok: true; readonly answer: MemberJoinAnswer } | { readonly ok: false };
