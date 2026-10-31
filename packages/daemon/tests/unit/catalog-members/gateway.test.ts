import { describe, it } from 'bun:test';
import should from 'should';
import type { ApiRequest, ApiResponse, SessionMember } from '../../../src/lib/api/http.ts';
import { MemberGateway, type MemberGatewayDeps } from '../../../src/lib/catalog-members/gateway.ts';
import { LiveMemberSessions } from '../../../src/lib/catalog-members/sessions.ts';
import type { MemberAccess } from '../../../src/lib/catalog-members/service.ts';
import type { MemberJoinAttempt } from '../../../src/lib/relay/member-port.ts';
import { keyId, memberId, storedKey } from './support.ts';

const MEMBER: SessionMember = { memberId: memberId(1), keyId: keyId(1), appSession: 'app-1', sessionId: 'session-1' };
const ACCESS: MemberAccess = {
  memberId: memberId(1),
  keyId: keyId(1),
  label: 'Member 1',
  memberKey: storedKey(1).memberKey,
  clientName: 'Browser 1',
  catalogIds: [],
  passkeyCount: 1,
};

function rigOf(parts: { access?: () => Promise<MemberAccess | undefined>; touch?: () => Promise<void> } = {}) {
  const log: string[] = [];
  const live = new LiveMemberSessions();
  const deps: MemberGatewayDeps = {
    gate: {
      join: async (attempt, carrier) => {
        log.push(`join:${attempt.code}:${carrier.kind}`);
        return { ok: false };
      },
    },
    dispatcher: {
      dispatch: async request => {
        log.push(`dispatch:${request.path}`);
        return { status: 204, headers: new Map(), body: '' };
      },
    },
    members: {
      access: async () => {
        log.push(`access:size${String(live.size)}`);
        return await (parts.access ?? (async () => ACCESS))();
      },
      touchKey: async () => {
        log.push('touch');
        await (parts.touch ?? (async () => undefined))();
      },
    },
    live,
  };
  return { gateway: new MemberGateway(deps), live, log };
}

describe('MemberGateway: join and dispatch', () => {
  it('should hand a join to the gate and a request to the dispatcher, and nothing else', async () => {
    // Arrange
    const r = rigOf();
    const attempt: MemberJoinAttempt = {
      code: 'c',
      clientName: 'n',
      memberKey: 'k',
      boxKey: 'b',
      prove: async () => true,
    };
    const request = { method: 'GET', path: '/v1/shared/me' } as ApiRequest;

    // Act
    const joined = await r.gateway.join(attempt, { kind: 'relay' });
    const response: ApiResponse = await r.gateway.dispatch(request);

    // Assert
    should(joined).eql({ ok: false });
    should(response.status).equal(204);
    should(r.log).eql(['join:c:relay', 'dispatch:/v1/shared/me']);
  });
});

describe('MemberGateway: the key to verify', () => {
  it('should give the filed key and whose it is', async () => {
    // Arrange
    const r = rigOf();

    // Act
    const found = await r.gateway.key(keyId(1));

    // Assert
    should(found).eql({ memberId: memberId(1), memberKey: ACCESS.memberKey });
  });

  it('should give nothing for an unknown, revoked or idle key alike', async () => {
    // Arrange
    const r = rigOf({ access: async () => undefined });

    // Act
    const found = await r.gateway.key(keyId(1));

    // Assert
    should(found).equal(undefined);
  });

  it('should give nothing when reading the key fails', async () => {
    // Arrange
    const r = rigOf({
      access: async () => {
        throw new Error('disk gone');
      },
    });

    // Act
    const found = await r.gateway.key(keyId(1));

    // Assert
    should(found).equal(undefined);
  });
});

describe('MemberGateway: opening a session', () => {
  it('should register the session before it re-reads the key, then note the key was seen', async () => {
    // Arrange
    const r = rigOf();

    // Act
    const release = await r.gateway.open(MEMBER, () => undefined);

    // Assert
    should(r.log).eql(['access:size1', 'touch']);
    should(r.live.size).equal(1);
    should(typeof release).equal('function');
  });

  it('should let a revoke find the session it registered, and end it', async () => {
    // Arrange
    const r = rigOf();
    let ended = 0;
    await r.gateway.open(MEMBER, () => {
      ended += 1;
    });

    // Act
    await r.live.closeMember(memberId(1));

    // Assert
    should(ended).equal(1);
    should(r.live.size).equal(0);
  });

  it('should deregister the session when the returned release is called', async () => {
    // Arrange
    const r = rigOf();
    const release = await r.gateway.open(MEMBER, () => undefined);

    // Act
    release?.();

    // Assert
    should(r.live.size).equal(0);
  });

  it('should register nothing when the key went away', async () => {
    // Arrange
    const r = rigOf({ access: async () => undefined });

    // Act
    const release = await r.gateway.open(MEMBER, () => undefined);

    // Assert
    should(release).equal(undefined);
    should(r.live.size).equal(0);
    should(r.log).not.containEql('touch');
  });

  it('should register nothing when the key now belongs to another member', async () => {
    // Arrange
    const r = rigOf({ access: async () => ({ ...ACCESS, memberId: memberId(2) }) });

    // Act
    const release = await r.gateway.open(MEMBER, () => undefined);

    // Assert
    should(release).equal(undefined);
    should(r.live.size).equal(0);
  });

  it('should register nothing when reading the key fails', async () => {
    // Arrange
    const r = rigOf({
      access: async () => {
        throw new Error('disk gone');
      },
    });

    // Act
    const release = await r.gateway.open(MEMBER, () => undefined);

    // Assert
    should(release).equal(undefined);
    should(r.live.size).equal(0);
  });

  it('should open the session even when noting that the key was seen fails', async () => {
    // Arrange
    const r = rigOf({
      touch: async () => {
        throw new Error('disk full');
      },
    });

    // Act
    const release = await r.gateway.open(MEMBER, () => undefined);

    // Assert
    should(typeof release).equal('function');
    should(r.live.size).equal(1);
  });
});
