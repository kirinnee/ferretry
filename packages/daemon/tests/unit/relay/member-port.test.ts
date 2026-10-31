import { describe, it } from 'bun:test';
import should from 'should';
import type { ApiRequest } from '../../../src/lib/api/http.ts';
import {
  DeferredMemberSessions,
  type MemberJoinAttempt,
  type RelayMemberSessions,
} from '../../../src/lib/relay/member-port.ts';

const ATTEMPT: MemberJoinAttempt = { code: 'c', clientName: 'n', memberKey: 'k', boxKey: 'b', prove: async () => true };
const REQUEST = { method: 'GET', path: '/v1/shared/me' } as ApiRequest;
const MEMBER = { memberId: 'mbr_1', keyId: 'mk_1', appSession: 'app', sessionId: 'session-1' };

describe('DeferredMemberSessions: before the member side is bound', () => {
  it('should refuse every join, know no key and register no session', async () => {
    // Arrange
    const deferred = new DeferredMemberSessions();

    // Act
    const joined = await deferred.join(ATTEMPT, { kind: 'relay' });
    const key = await deferred.key('mk_1');
    const open = await deferred.open(MEMBER, () => undefined);

    // Assert
    should(joined).eql({ ok: false });
    should(key).equal(undefined);
    should(open).equal(undefined);
  });

  it('should answer a request with a 503 that says the member side is not ready', async () => {
    // Arrange
    const deferred = new DeferredMemberSessions();

    // Act
    const response = await deferred.dispatch(REQUEST);

    // Assert
    should(response.status).equal(503);
    should(response.headers.get('content-type')).equal('application/json');
    should(JSON.parse(response.body ?? '')).eql({
      error: { code: 'unavailable', message: 'the member side is not ready' },
    });
  });
});

describe('DeferredMemberSessions: once bound', () => {
  it('should hand everything to the bound member side', async () => {
    // Arrange
    const log: string[] = [];
    const release = (): void => undefined;
    const bound: RelayMemberSessions = {
      join: async (_attempt, carrier) => {
        log.push(`join:${carrier.kind}`);
        return { ok: false };
      },
      key: async keyId => {
        log.push(`key:${keyId}`);
        return { memberId: 'mbr_1', memberKey: 'k' };
      },
      open: async member => {
        log.push(`open:${member.keyId}`);
        return release;
      },
      dispatch: async request => {
        log.push(`dispatch:${request.path}`);
        return { status: 200, headers: new Map(), body: 'ok' };
      },
    };
    const deferred = new DeferredMemberSessions();
    deferred.bind(bound);

    // Act
    await deferred.join(ATTEMPT, { kind: 'tunnel' });
    const key = await deferred.key('mk_1');
    const open = await deferred.open(MEMBER, () => undefined);
    const response = await deferred.dispatch(REQUEST);

    // Assert
    should(log).eql(['join:tunnel', 'key:mk_1', 'open:mk_1', 'dispatch:/v1/shared/me']);
    should(key).eql({ memberId: 'mbr_1', memberKey: 'k' });
    should(open).equal(release);
    should(response.status).equal(200);
  });
});
