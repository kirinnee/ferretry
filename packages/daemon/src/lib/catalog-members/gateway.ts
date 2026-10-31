/**
 * THE MEMBER SIDE AS THE SESSION LINK SEES IT (docs/relay-protocol.md §14 "Member sessions").
 *
 * One object answers the link's four needs and nothing more: the join, the filed key to verify, the live
 * registration a revoke can close, and the one door a member's request has. It owns no policy; the gate, the
 * service and the dispatcher each own theirs.
 */
import type { ApiRequest, ApiResponse, SessionMember } from '../api/http.ts';
import type {
  MemberJoinAttempt,
  MemberJoinCarrier,
  MemberJoinResult,
  MemberKeyLookup,
  RelayMemberSessions,
} from '../relay/member-port.ts';
import type { MemberJoinGate } from './join.ts';
import type { MemberDispatcher } from './shared-routes.ts';
import type { LiveMemberSessions } from './sessions.ts';
import type { CatalogMemberService } from './service.ts';

export interface MemberGatewayDeps {
  readonly gate: Pick<MemberJoinGate, 'join'>;
  readonly dispatcher: Pick<MemberDispatcher, 'dispatch'>;
  readonly members: Pick<CatalogMemberService, 'access' | 'touchKey'>;
  readonly live: Pick<LiveMemberSessions, 'track'>;
}

export class MemberGateway implements RelayMemberSessions {
  constructor(private readonly deps: MemberGatewayDeps) {}

  async join(attempt: MemberJoinAttempt, carrier: MemberJoinCarrier): Promise<MemberJoinResult> {
    return await this.deps.gate.join(attempt, carrier);
  }

  /** `undefined` for every reason a key is not to be trusted: the link cannot tell them apart, and neither can a peer. */
  async key(keyId: string): Promise<MemberKeyLookup | undefined> {
    const access = await this.deps.members.access(keyId).catch(() => undefined);
    return access === undefined ? undefined : { memberId: access.memberId, memberKey: access.memberKey };
  }

  async open(member: SessionMember, end: () => void): Promise<(() => void) | undefined> {
    // Registered BEFORE the key is read again, so a revoke landing between the two finds this session to close.
    const release = this.deps.live.track(member.memberId, member.keyId, end, member.sessionId);
    const access = await this.deps.members.access(member.keyId).catch(() => undefined);
    if (access === undefined || access.memberId !== member.memberId) {
      release();
      return undefined;
    }
    await this.deps.members.touchKey(member.keyId).catch(() => undefined);
    return release;
  }

  async dispatch(request: ApiRequest): Promise<ApiResponse> {
    return await this.deps.dispatcher.dispatch(request);
  }
}
