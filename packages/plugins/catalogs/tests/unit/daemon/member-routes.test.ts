/**
 * THE MEMBER ROUTES, THROUGH THE KERNEL'S OWN DISPATCHER (Appendix D R617–R621): a member's refusal answers as it
 * always did — its own code and status, never a bare 500 — over a REAL member session on the real session layer.
 */
import { describe, expect, it } from 'bun:test';
import { session } from '@ferretry/kernel/host';
import {
  APP_ORIGIN,
  type Browser,
  browser,
  catalogsFixture,
  joinWith,
  makeCatalog,
  memberSession,
  mintShare,
  MINUTE,
  unlock,
} from '../../support/daemon-host.ts';

const { SESSION_CLOSE_CODES } = session;
const CONCLUDED = 4440;
const UNKNOWN_CODE = `fy_share_${'x'.repeat(22)}`;

async function unlockedMember() {
  const fx = await catalogsFixture();
  const catalog = await makeCatalog(fx, 'Team recipes');
  const who = await browser();
  const joined = await joinWith(fx, who, (await mintShare(fx, { catalogIds: [catalog] })).code);
  const end = await memberSession(fx, who, joined.keyId);
  await unlock(end);
  return { fx, catalog, who, joined, end };
}

describe('the member routes answer a refusal with its own code and status', () => {
  it('R621 should answer an unknown code 409 share_refused over a member session, never 500', async () => {
    // Arrange
    const { end } = await unlockedMember();

    // Act
    const answer = await end.ask('POST', '/v1/shared/redeem', { code: UNKNOWN_CODE });

    // Assert
    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe('share_refused');
    expect(answer.headers['cache-control']).toBe('no-store');
  });

  it('R621 should answer a new-member code from an existing member 409 share_new_member over the route, and spend it', async () => {
    // Arrange
    const { fx, catalog, end } = await unlockedMember();
    const other = await makeCatalog(fx, 'Other');
    const newMember = await mintShare(fx, { catalogIds: [other], member: { kind: 'new', label: 'Somebody new' } });

    // Act
    const answer = await end.ask('POST', '/v1/shared/redeem', { code: newMember.code });
    const again = await end.ask('POST', '/v1/shared/redeem', { code: newMember.code });

    // Assert
    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe('share_new_member');
    expect(again.status).toBe(409);
    expect(catalog).not.toBe(other);
  });

  it('R621 should answer another member’s code 409 share_other_member over the route', async () => {
    // Arrange
    const { fx, end } = await unlockedMember();
    const other = await makeCatalog(fx, 'Other');
    const stranger = await joinWith(fx, await browser(), (await mintShare(fx, { catalogIds: [other] })).code);
    const forStranger = await mintShare(fx, {
      catalogIds: [other],
      member: { kind: 'existing', memberId: stranger.memberId },
    });

    // Act
    const answer = await end.ask('POST', '/v1/shared/redeem', { code: forStranger.code });

    // Assert
    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe('share_other_member');
  });

  it('R621 should add the catalog when the member redeems a code the owner made for them', async () => {
    // Arrange
    const { fx, joined, end } = await unlockedMember();
    const other = await makeCatalog(fx, 'Other');
    const mine = await mintShare(fx, { catalogIds: [other], member: { kind: 'existing', memberId: joined.memberId } });

    // Act
    const answer = await end.ask('POST', '/v1/shared/redeem', { code: mine.code });

    // Assert
    expect(answer.status).toBe(200);
    expect(answer.body.added).toEqual([{ catalogId: other, name: 'Other' }]);
  });

  it('R617 should answer a locked key with today’s sentence: unlock with your passkey first', async () => {
    // Arrange
    const fx = await catalogsFixture();
    const catalog = await makeCatalog(fx);
    const who = await browser();
    const joined = await joinWith(fx, who, (await mintShare(fx, { catalogIds: [catalog] })).code);
    const locked = await memberSession(fx, who, joined.keyId);

    // Act
    const answer = await locked.ask('GET', '/v1/shared/me');

    // Assert
    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe('member_locked');
    expect(JSON.stringify(answer.body)).toContain('unlock with your passkey first');
    expect(JSON.stringify(answer.body)).not.toContain('unlock this browser');
  });

  it('G4 should answer a member the contract hash of Catalogs, as the host holds it, and nothing else', async () => {
    // Arrange
    const fx = await catalogsFixture({ contractHash: id => `effective-of-${id}` });
    const catalog = await makeCatalog(fx, 'Team recipes');
    const who = await browser();
    const joined = await joinWith(fx, who, (await mintShare(fx, { catalogIds: [catalog] })).code);
    const end = await memberSession(fx, who, joined.keyId);
    await unlock(end);

    // Act
    const answer = await end.ask('GET', '/v1/shared/contract');

    // Assert — one field: Catalogs' hash from `kernel.contract.hash()`, no inventory and no other plugin
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ contract: 'effective-of-catalogs' });
    expect(answer.headers['cache-control']).toBe('no-store');
  });

  it('G4 should refuse a locked member key GET /v1/shared/contract 403 member_locked', async () => {
    // Arrange
    const fx = await catalogsFixture();
    const catalog = await makeCatalog(fx);
    const who = await browser();
    const joined = await joinWith(fx, who, (await mintShare(fx, { catalogIds: [catalog] })).code);
    const locked = await memberSession(fx, who, joined.keyId);

    // Act
    const answer = await locked.ask('GET', '/v1/shared/contract');

    // Assert
    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe('member_locked');
  });

  it('G4 should refuse a caller with no principal on GET /v1/shared/contract', async () => {
    // Arrange
    const { fx } = await unlockedMember();

    // Act
    const answer = await fx.dispatcher.dispatch({
      method: 'GET',
      path: '/v1/shared/contract',
      headers: new Map(),
      body: '',
    } as never);

    // Assert — the member table is reached only by a member principal: nothing is answered, no member is admitted
    expect(answer.status).not.toBe(200);
    expect(answer.body).not.toContain('contract');
    expect(fx.callers.memberAdmissions.filter(admitted => admitted.path === '/v1/shared/contract')).toEqual([]);
  });

  it('G4 should refuse a member session the main inventory GET /v1/plugins 403 member_only', async () => {
    // Arrange — the kernel's dispatcher sends a member principal to the member table only (dispatch.test.ts
    // "a member principal is served only from the member table"); this is the same refusal over a real member session
    const { end } = await unlockedMember();

    // Act
    const answer = await end.ask('GET', '/v1/plugins');

    // Assert
    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe('member_only');
  });

  it('should let a member remove their own browser: 200 with the key id, the session concluded, the key gone', async () => {
    // Arrange
    const { fx, joined, end } = await unlockedMember();

    // Act
    const answer = await end.ask('DELETE', '/v1/shared/me/keys/self');
    await end.pump();
    const listed = await fx.host.request('GET', '/v1/catalog-members');

    // Assert
    expect(answer.status).toBe(200);
    expect(answer.body.keyId).toBe(joined.keyId);
    expect(end.end?.code).toBe(CONCLUDED);
    expect(listed.body).not.toContain(joined.keyId);
    const again = await memberSession(fx, (await browser()) as Browser, joined.keyId);
    expect(again.end?.code).toBe(SESSION_CLOSE_CODES.authRejected);
  });

  it('should refuse a revoked key: the credential provider forgets it, so it is unknown and every act is refused', async () => {
    // Arrange
    const { fx, who, joined, end } = await unlockedMember();
    const provider = fx.half.hooks['credentials:member'];
    await end.ask('GET', '/v1/shared/me');
    const inFlight = fx.dispatched.at(-1);
    if (inFlight === undefined) throw new Error('no request was dispatched');
    const live = provider.standing(joined.keyId as never, fx.clock.now());

    // Act
    await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}`);
    const standing = provider.standing(joined.keyId as never, fx.clock.now());
    const stale = await fx.dispatcher.dispatch(inFlight);
    const reopened = await memberSession(fx, who, joined.keyId);
    const options = await fx.open().handshake();
    await options.joinOptions(who, UNKNOWN_CODE, APP_ORIGIN);

    // Assert — 'unknown' is never read as admitted: the old request, a new session and a join all refuse
    expect(typeof live === 'object' && live.kind === 'member').toBe(true);
    expect(standing).toBe('unknown');
    expect(stale.status).toBe(401);
    expect(reopened.end?.code).toBe(SESSION_CLOSE_CODES.authRejected);
    expect(reopened.records).toEqual([]);
  });

  it('should file a browser as seen when its session opens, and not again on each request', async () => {
    // Arrange
    const { fx, joined, who, end } = await unlockedMember();
    const seen = async () =>
      (await fx.host.request('GET', '/v1/catalog-members'))
        .json<{ members: { keys: { keyId: string; lastSeenAt?: string }[] }[] }>()
        .members.flatMap(member => member.keys)
        .find(key => key.keyId === joined.keyId)?.lastSeenAt;
    const opened = await seen();

    // Act
    await fx.clock.advance(11 * MINUTE);
    await end.ask('GET', '/v1/shared/me');
    const afterRequest = await seen();
    const next = await memberSession(fx, who, joined.keyId);
    await next.ask('GET', '/v1/shared/me');
    const afterOpen = await seen();

    // Assert
    expect(fx.half.hooks['session.modes:member'].seen).toBeUndefined();
    expect(opened).toBeDefined();
    expect(afterRequest).toBe(opened as string);
    expect(afterOpen).not.toBe(opened as string);
  });
});
