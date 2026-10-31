/**
 * What a session's link needs from the member side, as ONE port (docs/relay-protocol.md §14 "Member sessions").
 *
 * Like the pairing port, it is how a join happens with no route involved at all; unlike it, it also carries
 * the request session's three needs: the key to verify, the live registration, and the member route table.
 * `dispatch` is the ONLY door a member's request has — the link never hands one to the device dispatcher.
 */
import type { MemberJoinedResponse } from '@ferretry/protocol';
import type { ApiRequest, ApiResponse, SessionMember } from '../api/http.ts';

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
  /** Run only after the cheap checks pass, so a stranger cannot make this daemon verify a signature first. */
  readonly prove: () => Promise<boolean>;
}

/** `ok: false` is the one generic refusal; the port never says why. */
export type MemberJoinResult = { readonly ok: true; readonly response: MemberJoinedResponse } | { readonly ok: false };

/** The key a browser must prove, and whose it is. */
export interface MemberKeyLookup {
  readonly memberId: string;
  readonly memberKey: string;
}

export interface RelayMemberSessions {
  /** One redemption of a share code. Never throws: anything that goes wrong is a refusal. */
  join(attempt: MemberJoinAttempt, carrier: MemberJoinCarrier): Promise<MemberJoinResult>;
  /** The filed key of a browser, or nothing when it is unknown, revoked or idle-expired. */
  key(keyId: string): Promise<MemberKeyLookup | undefined>;
  /**
   * The browser proved its key: register the session so a revoke can end it with `end`, and answer how to
   * deregister it. Nothing when the key went away in the meantime, in which case nothing is registered.
   */
  open(member: SessionMember, end: () => void): Promise<(() => void) | undefined>;
  /** One request, on the member route table and nothing else. Never throws. */
  dispatch(request: ApiRequest): Promise<ApiResponse>;
}

/**
 * The member side, bound late.
 *
 * The carriers are built before the subsystems that answer for members, so they hold this and the machine binds
 * the real one once it exists. Until then — and on a daemon with no member side — every join is refused and
 * every key is unknown, exactly as a publisher with no live share answers.
 */
export class DeferredMemberSessions implements RelayMemberSessions {
  #bound: RelayMemberSessions | undefined;

  bind(bound: RelayMemberSessions): void {
    this.#bound = bound;
  }

  async join(attempt: MemberJoinAttempt, carrier: MemberJoinCarrier): Promise<MemberJoinResult> {
    return this.#bound === undefined ? { ok: false } : await this.#bound.join(attempt, carrier);
  }

  async key(keyId: string): Promise<MemberKeyLookup | undefined> {
    return await this.#bound?.key(keyId);
  }

  async open(member: SessionMember, end: () => void): Promise<(() => void) | undefined> {
    return await this.#bound?.open(member, end);
  }

  async dispatch(request: ApiRequest): Promise<ApiResponse> {
    if (this.#bound !== undefined) return await this.#bound.dispatch(request);
    return {
      status: 503,
      headers: new Map([['content-type', 'application/json']]),
      body: JSON.stringify({ error: { code: 'unavailable', message: 'the member side is not ready' } }),
    };
  }
}
