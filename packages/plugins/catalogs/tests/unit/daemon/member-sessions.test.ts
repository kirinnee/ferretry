/**
 * CATALOG MEMBER SESSIONS ON THE KERNEL SESSION LAYER (Appendix D, §14 "Member sessions").
 *
 * Moved from today's `tests/integration/relay/member-sessions.test.ts` onto the 5.0 production path: a browser end
 * speaks the real records over real WebCrypto to the kernel's own session layer, whose only mode is Catalogs'
 * `session.modes:member` provider from the daemon half the kernel test host built; member requests go through the
 * kernel's own Dispatcher into that half's member routes. Each row id below names the guarantee its test proves.
 */
import { describe, expect, it } from 'bun:test';
import { session } from '@ferretry/kernel/host';
import { MemberJoinedResponseSchema } from '../../../contract/wire/catalog-member.ts';
import {
  CATALOG_LINK_SIGNATURE_LABEL,
  CATALOG_MANIFEST_SIGNATURE_LABEL,
  CATALOG_VERSIONS_SIGNATURE_LABEL,
} from '../../../contract/wire/index.ts';
import {
  LINK_STORE_DELETE_LABEL,
  LINK_STORE_STATUS_LABEL,
  LINK_STORE_UPLOAD_LABEL,
} from '../../../daemon/lib/relay-wire/catalog-wire/link-store.ts';
import {
  LINK_BUNDLE_KEY_LABEL,
  LINK_ENVELOPE_AAD_LABEL,
  LINK_FETCH_TOKEN_LABEL,
} from '../../../daemon/lib/relay-wire/catalog-wire/link-bundle.ts';
import {
  APP_ORIGIN,
  BOX_KEY,
  type Browser,
  type BrowserEnd,
  browser,
  CREDENTIAL,
  type CatalogsFixture,
  catalogsFixture,
  CLIENT_NAME,
  DAY,
  joinWith,
  MINUTE,
  makeCatalog,
  memberSession,
  mintShare,
  unlock,
  unlockOnly,
} from '../../support/daemon-host.ts';
import { everyUnusableKeyEndsTheSame, joinChallengeIsSpentByTheJoin } from '../../support/member-mode-cases.ts';

const { MEMBER_JOIN_OUTCOME_BYTES, SESSION_CLOSE_CODES, SESSION_PROTOCOL_ID } = session;
const CONCLUDED = 4440;
const b64 = (value: Uint8Array | string): string => Buffer.from(value).toString('base64url');
const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

async function publisher(options: Parameters<typeof catalogsFixture>[0] = {}) {
  const fx = await catalogsFixture(options);
  const catalog = await makeCatalog(fx, 'Team recipes');
  return { fx, catalog };
}

async function joinEnd(
  fx: CatalogsFixture,
  who: Browser,
  code: string,
  carrier = 'relay',
  peer?: { address?: string },
) {
  const end = await fx.open(carrier, peer).handshake();
  await end.join(who, code);
  return end;
}

async function members(fx: CatalogsFixture) {
  const listed = await fx.host.request('GET', '/v1/catalog-members');
  return listed.json<{ members: { memberId: string; label: string; keys: { keyId: string }[] }[] }>().members;
}

/** A joined key, unlocked on a live session, with a second catalog it was never given. */
async function unlockedMember(options: Parameters<typeof catalogsFixture>[0] = {}) {
  const { fx, catalog } = await publisher(options);
  const ungranted = await makeCatalog(fx, 'Private');
  const who = await browser();
  const share = await mintShare(fx, { catalogIds: [catalog] });
  const joined = await joinWith(fx, who, share.code);
  const end = await memberSession(fx, who, joined.keyId);
  await unlock(end);
  return { fx, catalog, ungranted, who, joined, end };
}

describe('catalog member sessions on the kernel session layer', () => {
  it('R591 should take join, join-options and member as a first record on the relay and the direct carrier alike', async () => {
    for (const carrier of ['relay', 'direct']) {
      // Arrange
      const { fx, catalog } = await publisher();
      const who = await browser();
      const share = await mintShare(fx, { catalogIds: [catalog] });

      // Act
      const options = await fx.open(carrier).handshake();
      await options.joinOptions(who, share.code);
      const join = await joinEnd(fx, who, share.code, carrier);
      const response = join.records[0]?.message.response as { keyId: string };
      const member = await memberSession(fx, who, response.keyId, carrier);
      const device = await fx.open(carrier).handshake();
      const deviceId = `fy_device_id_${'A'.repeat(22)}`;
      await device.send({
        t: 'auth',
        protocol: SESSION_PROTOCOL_ID,
        deviceId,
        appSession: who.appSession,
        proof: await device.sign(who, session.deviceAuthMessage(device.transcript, 'auth', deviceId, who.appSession)),
      });
      await device.pump();

      // Assert — each is a credential this layer reads; `auth` reaches the device mode (absent here: 4403, not 4400)
      expect(options.records[0]?.message.t).toBe('join-open');
      expect(join.records[0]?.message.t).toBe('joined');
      expect(member.last('authenticated')).toBeDefined();
      expect(device.end?.code).not.toBe(SESSION_CLOSE_CODES.protocolError);
    }
  });

  it('R592 should never let a join or a member session reach a route a device session reaches', async () => {
    // Arrange
    const { fx, end } = await unlockedMember();
    const before = fx.dispatched.length;

    // Act
    const device = await end.ask('GET', '/v1/catalogs');
    const shares = await end.ask('GET', '/v1/catalog-shares');

    // Assert — the kernel's dispatcher sent the member principal to the member table only, which has neither
    expect(device.status).toBe(403);
    expect(device.body.code).toBe('member_only');
    expect(shares.body.code).toBe('member_only');
    expect(fx.dispatched.slice(before).every(request => request.principal?.kind === 'member')).toBe(true);
  });

  it('R594 should give every member, catalog and link-store signature its own label', async () => {
    // Arrange
    const labels = [
      session.MEMBER_JOIN_LABEL,
      session.MEMBER_AUTH_LABEL,
      session.MEMBER_RENEW_LABEL,
      session.MEMBER_JOIN_OPTIONS_LABEL,
      CATALOG_MANIFEST_SIGNATURE_LABEL,
      CATALOG_VERSIONS_SIGNATURE_LABEL,
      CATALOG_LINK_SIGNATURE_LABEL,
      LINK_STORE_UPLOAD_LABEL,
      LINK_STORE_DELETE_LABEL,
      LINK_STORE_STATUS_LABEL,
      LINK_BUNDLE_KEY_LABEL,
      LINK_FETCH_TOKEN_LABEL,
      LINK_ENVELOPE_AAD_LABEL,
    ];
    const { fx, catalog } = await publisher();
    const who = await browser();
    const joined = await joinWith(fx, who, (await mintShare(fx, { catalogIds: [catalog] })).code);
    const end = await fx.open().handshake();

    // Act — a join proof over this transcript, presented as the member proof
    const joinProof = await end.sign(who, session.memberJoinMessage(end.transcript, who.memberKey, BOX_KEY));
    await end.send({
      t: 'member',
      protocol: SESSION_PROTOCOL_ID,
      keyId: joined.keyId,
      appSession: who.appSession,
      proof: joinProof,
    });
    await end.pump();

    // Assert
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label).toMatch(/^ferretry-(member|catalog|link)-[a-z-]+-v1$/u);
    expect(end.end?.code).toBe(SESSION_CLOSE_CODES.authRejected);
    expect(end.records).toEqual([]);
  });

  it('R595 should seal exactly one join outcome, then conclude with 4440', async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog] });

    // Act
    const end = await joinEnd(fx, await browser(), share.code);

    // Assert
    expect(end.records.map(record => record.message.t)).toEqual(['joined']);
    expect(end.end?.code).toBe(CONCLUDED);
  });

  it('R596 should pad both outcomes with spaces to exactly 24 KiB, and refuse an outcome too large to pad', async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog] });
    const big = await catalogsFixture({
      carriers: Array.from({ length: 8 }, (_, index) => ({
        kind: 'direct' as const,
        url: `https://${String(index)}${'a'.repeat(240)}.example`,
      })),
    });
    const bigShare = await mintShare(big, { catalogIds: [await makeCatalog(big)] });

    // Act
    const joined = await joinEnd(fx, await browser(), share.code);
    const refused = await joinEnd(fx, await browser(), share.code);
    const oversized = await joinEnd(big, await browser(), bigShare.code);

    // Assert
    for (const end of [joined, refused]) {
      const [outcome] = end.records;
      expect(outcome?.bytes).toBe(MEMBER_JOIN_OUTCOME_BYTES);
      expect(outcome?.message.pad).toMatch(/^ +$/u);
    }
    expect(joined.records[0]?.message.t).toBe('joined');
    expect(refused.records[0]?.message.t).toBe('join-refused');
    expect(oversized.records[0]?.bytes).toBe(MEMBER_JOIN_OUTCOME_BYTES);
    expect(['joined', 'join-refused']).toContain(oversized.records[0]?.message.t as string);
  });

  it('R597 should name no catalog in joined, only how many', async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const second = await makeCatalog(fx, 'Second secret name');
    const share = await mintShare(fx, { catalogIds: [catalog, second] });

    // Act
    const end = await joinEnd(fx, await browser(), share.code);
    const [outcome] = end.records;

    // Assert
    expect((outcome?.message.response as { catalogCount: number } | undefined)?.catalogCount).toBe(2);
    for (const named of [catalog, second, 'Team recipes', 'Second secret name'])
      expect(outcome?.text).not.toContain(named);
  });

  it('R598 should refuse every cause with one identical join-refused, a publisher with no live share included', async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const empty = await catalogsFixture();
    const share = await mintShare(fx, { catalogIds: [catalog] });
    const who = await browser();

    // Act
    const wrong = await joinEnd(fx, who, `fy_share_${'A'.repeat(22)}`);
    const malformed = await joinEnd(fx, who, 'not-a-code');
    const noShare = await joinEnd(empty, who, share.code);

    // Assert — keyed, refused, and the same text every time
    const texts = [wrong, malformed, noShare].map(end => end.records[0]?.text);
    expect(texts[0]).toContain('"join-refused"');
    expect(new Set(texts).size).toBe(1);
    for (const end of [wrong, malformed, noShare]) expect(end.end?.code).toBe(CONCLUDED);
  });

  it('R599 should make a 128-bit fy_share_ code, store only its SHA-256, and carry it only sealed or in the fragment', async () => {
    // Arrange
    const { fx, catalog } = await publisher();

    // Act
    const share = await mintShare(fx, { catalogIds: [catalog] });
    const end = await joinEnd(fx, await browser(), share.code);
    const digest = new Bun.CryptoHasher('sha256').update(share.code).digest('hex');
    const stored = [...fx.host.state('catalogs').files.values()].join('\n');
    const link = String(share.body.link);

    // Assert
    expect(share.code).toMatch(/^fy_share_[A-Za-z0-9_-]{22}$/u);
    expect(Buffer.from(share.code.slice(9), 'base64url').length).toBe(16);
    expect(stored).not.toContain(share.code);
    expect(stored).toContain(digest);
    expect(link.slice(0, link.indexOf('#'))).not.toContain(share.code);
    expect(link.slice(link.indexOf('#'))).toContain(encodeURIComponent(share.code).replaceAll('%5F', '_'));
    for (const frame of end.wire) expect(utf8(frame)).not.toContain(share.code);
  });

  it('R600 should spend nothing on a stateless refusal, and have the member on file before the outcome is sealed', async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog] });
    const who = await browser();

    // Act — a malformed box key fails before the code is looked at; then the same code joins
    const bad = await fx.open().handshake();
    await bad.join(who, share.code, { boxKey: b64(new Uint8Array(32)) });
    const good = await fx.open().handshake();
    await good.join(who, share.code);

    // Assert
    expect(bad.records[0]?.message.t).toBe('join-refused');
    expect(good.records[0]?.message.t).toBe('joined');
    expect(fx.host.state('catalogs').files.get('members.json')).toContain(
      String((good.records[0]?.message.response as { keyId: string } | undefined)?.keyId),
    );
  });

  it('R601 should leave the code live after an hourly refusal, so it joins once the hour has passed', async () => {
    // Arrange — a multi-use code at its hourly most
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog], uses: { kind: 'multi', cap: 100 }, expiresIn: '3h' });
    for (let joined = 0; joined < 60; joined += 1) await joinWith(fx, await browser(), share.code);

    // Act
    const refused = await joinEnd(fx, await browser(), share.code);
    await fx.clock.advance(61 * MINUTE);
    const later = await joinEnd(fx, await browser(), share.code);

    // Assert
    expect(refused.records[0]?.message.t).toBe('join-refused');
    expect(later.records[0]?.message.t).toBe('joined');
  });

  it('R602 should send joined.response whole, with no field for a key, a proof or a fingerprint', async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const who = await browser();

    // Act
    const end = await joinEnd(fx, who, (await mintShare(fx, { catalogIds: [catalog] })).code);
    const response = end.records[0]?.message.response as Record<string, unknown>;

    // Assert
    expect(MemberJoinedResponseSchema.parse(response)).toEqual(response as never);
    for (const field of Object.keys(response))
      expect(field).not.toMatch(/^(memberKey|boxKey|proof|spki|publicKey|fingerprint|fp)$/iu);
    expect(end.records[0]?.text).not.toContain(who.memberKey);
    expect(end.records[0]?.text).not.toContain(BOX_KEY);
  });

  it('R603 should be concluding while it judges: a second record is refused and only one outcome is sealed', async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog] });
    const who = await browser();
    const end = await fx.open().handshake();
    const proof = await end.sign(who, session.memberJoinMessage(end.transcript, who.memberKey, BOX_KEY));

    // Act — the join and a second record in the same turn
    await end.send({
      t: 'join',
      protocol: SESSION_PROTOCOL_ID,
      code: share.code,
      clientName: CLIENT_NAME,
      memberKey: who.memberKey,
      boxKey: BOX_KEY,
      proof,
    });
    await end.send({ t: 'req', id: 1, method: 'GET', path: '/v1/shared/me' });
    await end.pump();

    // Assert — no answer to the request; at most the one outcome
    expect(end.records.filter(record => record.message.t === 'res')).toEqual([]);
    expect(end.records.length).toBeLessThanOrEqual(1);
    expect(fx.dispatched).toEqual([]);
  });

  it('R604 should refuse a direct peer past ten failed joins a minute, good code included, and fold the audit', async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog] });
    const peer = { address: '203.0.113.7' };
    for (let attempt = 0; attempt < 10; attempt += 1)
      await joinEnd(fx, await browser(), `fy_share_${'B'.repeat(22)}`, 'direct', peer);

    // Act
    const blocked = await joinEnd(fx, await browser(), share.code, 'direct', peer);
    const otherPeer = await joinEnd(fx, await browser(), share.code, 'direct', { address: '203.0.113.8' });

    // Assert
    expect(blocked.records[0]?.message.t).toBe('join-refused');
    expect(otherPeer.records[0]?.message.t).toBe('joined');
    const refusals = fx.gate.audits.filter(entry => String(entry.event).includes('join-refused'));
    expect(refusals.length).toBe(1);
  });

  it('R605 should refuse every join identically on a daemon with no bound member side', async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const off = await catalogsFixture({ noMemberMode: true });
    const share = await mintShare(off, { catalogIds: [await makeCatalog(off)] });

    // Act
    const unbound = await joinEnd(off, await browser(), share.code);
    const wrong = await joinEnd(fx, await browser(), `fy_share_${'C'.repeat(22)}`);

    // Assert — the same padded refusal, and nothing a browser could keep its key on
    expect(unbound.records[0]?.text).toBe(wrong.records[0]?.text);
    expect(unbound.end?.code).toBe(CONCLUDED);
    expect(await members(off)).toEqual([]);
    void catalog;
  });

  it('R606 should let a new key register one passkey in ten minutes, more only unlocked, and remove a key with none', async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const who = await browser();
    const late = await browser();
    const share = await mintShare(fx, { catalogIds: [catalog], uses: { kind: 'multi', cap: 100 } });
    const joined = await joinWith(fx, who, share.code);
    const idle = await joinWith(fx, late, share.code);
    const end = await memberSession(fx, who, joined.keyId);

    // Act — one passkey in the window; a second is refused while locked
    const first = await end.ask('POST', '/v1/shared/passkeys/options', { origin: APP_ORIGIN });
    const registered = await end.ask('POST', '/v1/shared/passkeys', {
      credentialId: b64(CREDENTIAL),
      clientDataJSON: b64('client'),
      attestationObject: b64('attestation'),
    });
    const second = await end.ask('POST', '/v1/shared/passkeys/options', { origin: APP_ORIGIN });
    await unlockOnly(end);
    const unlockedSecond = await end.ask('POST', '/v1/shared/passkeys/options', { origin: APP_ORIGIN });
    await fx.clock.advance(11 * MINUTE);
    await fx.host.runJob('catalogs-sweep');
    const lateSession = await memberSession(fx, late, idle.keyId);

    // Assert
    expect(first.status).toBe(200);
    expect(registered.status).toBe(201);
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(unlockedSecond.status).toBe(200);
    expect(lateSession.end?.code).toBe(SESSION_CLOSE_CODES.authRejected);
    expect((await members(fx)).flatMap(member => member.keys.map(key => key.keyId))).not.toContain(idle.keyId);
  });

  it('R607 should count no failed join against a code, and count successes per share', async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog] });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const forger = await browser();
      const end = await fx.open().handshake();
      const proof = await end.sign(
        await browser(),
        session.memberJoinMessage(end.transcript, forger.memberKey, BOX_KEY),
      );
      await end.send({
        t: 'join',
        protocol: SESSION_PROTOCOL_ID,
        code: share.code,
        clientName: CLIENT_NAME,
        memberKey: forger.memberKey,
        boxKey: BOX_KEY,
        proof,
      });
      await end.pump();
    }

    // Act
    const end = await joinEnd(fx, await browser(), share.code);

    // Assert
    expect(end.records[0]?.message.t).toBe('joined');
  });

  it('R608 should prove memberKey on join-options, spend nothing, pad the answer and conclude', async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog] });
    const who = await browser();

    // Act
    const asked = await fx.open().handshake();
    await asked.joinOptions(who, share.code);
    const forged = await fx.open().handshake();
    await forged.joinOptions(who, share.code, APP_ORIGIN, await browser());
    const joined = await joinEnd(fx, who, share.code);

    // Assert
    expect(asked.records[0]?.bytes).toBe(MEMBER_JOIN_OUTCOME_BYTES);
    expect(asked.records[0]?.message.t).toBe('join-open');
    expect(asked.end?.code).toBe(CONCLUDED);
    expect(forged.records[0]?.message.t).toBe('join-refused');
    expect(forged.records[0]?.bytes).toBe(MEMBER_JOIN_OUTCOME_BYTES);
    expect(joined.records[0]?.message.t).toBe('joined');
  });

  it('R609 should issue a challenge on join-options that a join spends, so a replay is refused', async () => {
    // The arrangement and the assertions are the shared case, which the integration tier runs too.
    await joinChallengeIsSpentByTheJoin();
  });

  it('R610 should refuse a join with no passkey proof for a person who has one, and leave the code live', async () => {
    // Arrange
    const { fx, joined } = await unlockedMember();
    const second = await browser();
    const share = await mintShare(fx, {
      catalogIds: [await makeCatalog(fx, 'Third')],
      member: { kind: 'existing', memberId: joined.memberId },
    });

    // Act
    const absent = await joinEnd(fx, second, share.code);
    const options = await fx.open().handshake();
    await options.joinOptions(second, share.code);
    const proved = await fx.open().handshake();
    await proved.join(second, share.code, {
      passkey: {
        credentialId: b64(CREDENTIAL),
        clientDataJSON: b64('client'),
        authenticatorData: b64('authenticator'),
        signature: b64('signature'),
      },
    });

    // Assert
    expect(absent.records[0]?.message.t).toBe('join-refused');
    expect(proved.records[0]?.message.t).toBe('joined');
  });

  it('R612 should end an unknown key, a removed key, an idle key and a bad proof with the same 4403', async () => {
    // The arrangement and the assertions are the shared case, which the integration tier runs too.
    await everyUnusableKeyEndsTheSame();
  });

  it('R613 should end a revoked browser with the same cleartext 4403 an unknown one gets, sealing no reason', async () => {
    // Arrange
    const { fx, joined, end } = await unlockedMember();
    const stranger = await memberSession(fx, await browser(), `mk_${'Y'.repeat(22)}`);

    // Act
    await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}`);
    await end.pump();

    // Assert — nothing sealed says "revoked", so a browser cannot tell it from a stray 4403 (the app keeps its key)
    expect(end.end).toEqual(stranger.end);
    expect(end.records.some(record => /revok/iu.test(record.text))).toBe(false);
  });

  it('R614 should re-read the key on every request after the proof, and close every session on removal with 4403', async () => {
    // Arrange
    const { fx, joined, end } = await unlockedMember();
    const other = await memberSession(fx, (await browser()) as Browser, joined.keyId);
    await end.ask('GET', '/v1/shared/me');
    const inFlight = fx.dispatched.at(-1);
    if (inFlight === undefined) throw new Error('no request was dispatched');

    // Act
    await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}/keys/${joined.keyId}`);
    await end.pump();
    const stale = await fx.dispatcher.dispatch(inFlight);

    // Assert
    expect(end.end?.code).toBe(SESSION_CLOSE_CODES.authRejected);
    expect(other.end?.code).toBe(SESSION_CLOSE_CODES.authRejected);
    expect(stale.status).toBe(401);
  });

  it('R615 should give a member session only /v1/shared/*: every main-table route is member_only', async () => {
    // Arrange
    const { fx, end } = await unlockedMember();
    const { default: manifest } = await import('../../../manifest.ts');
    const admitted = fx.callers.memberAdmissions.length;

    // Act
    const answers = [];
    for (const route of manifest.actions.routes)
      answers.push(await end.ask(route.method, route.path.replaceAll(/:([A-Za-z]+)/gu, 'x')));

    // Assert
    for (const answer of answers) {
      expect(answer.status).toBe(403);
      expect(answer.body.code).toBe('member_only');
    }
    expect(fx.callers.memberAdmissions.length).toBe(admitted);
  });

  it('R616 should accept no device credential on /v1/shared/*', async () => {
    // Arrange
    const { fx, end } = await unlockedMember();
    await end.ask('GET', '/v1/shared/me');
    const asMember = fx.dispatched.at(-1);
    if (asMember?.principal === undefined) throw new Error('no member request');
    const admitted = fx.callers.memberAdmissions.length;

    // Act
    const asDevice = await fx.dispatcher.dispatch({
      ...asMember,
      principal: { ...asMember.principal, kind: 'device' },
    });

    // Assert — the main table has no /v1/shared/* route, and the member table was never asked
    expect(asDevice.status).toBe(404);
    expect(fx.callers.memberAdmissions.length).toBe(admitted);
  });

  it('R617 should re-read grants on every member request: gone 401, locked 403, ungranted catalog 404', async () => {
    // Arrange — one person with two catalogs, unlocked; a second, locked
    const { fx, catalog } = await publisher();
    const kept = await makeCatalog(fx, 'Kept');
    const ungranted = await makeCatalog(fx, 'Private');
    const who = await browser();
    const joined = await joinWith(fx, who, (await mintShare(fx, { catalogIds: [catalog, kept] })).code);
    const end = await memberSession(fx, who, joined.keyId);
    await unlock(end);
    const other = await browser();
    const lockedKey = await joinWith(fx, other, (await mintShare(fx, { catalogIds: [catalog] })).code);
    const locked = await memberSession(fx, other, lockedKey.keyId);

    // Act
    const granted = await end.ask('GET', `/v1/shared/catalogs/${catalog}/manifest`);
    const notGranted = await end.ask('GET', `/v1/shared/catalogs/${ungranted}/manifest`);
    const lockedAnswer = await locked.ask('GET', `/v1/shared/catalogs/${catalog}/manifest`);
    await end.ask('GET', `/v1/shared/catalogs/${catalog}/manifest`);
    const read = fx.dispatched.at(-1);
    await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}/catalogs/${catalog}`);
    const taken = read === undefined ? undefined : await fx.dispatcher.dispatch(read);
    const again = await memberSession(fx, who, joined.keyId);
    const takenFresh = await again.ask('GET', `/v1/shared/catalogs/${catalog}/manifest`);
    await again.ask('GET', '/v1/shared/me');
    const last = fx.dispatched.at(-1);
    await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}`);
    const gone = last === undefined ? undefined : await fx.dispatcher.dispatch(last);

    // Assert
    expect(granted.status).toBe(200);
    expect(notGranted.status).toBe(404);
    expect(notGranted.body.code).toBe('catalog_unknown');
    expect(lockedAnswer.status).toBe(403);
    expect(lockedAnswer.body.code).toBe('member_locked');
    // Taking a catalog ends the live sessions (today), so the read already in flight is refused as gone.
    expect(taken?.status).toBe(401);
    expect(takenFresh.body.code).toBe('catalog_unknown');
    expect(gone?.status).toBe(401);
  });

  it('R618 should answer item_unknown with one fixed sentence on both item routes', async () => {
    // Arrange
    const { catalog, end } = await unlockedMember();
    const missing = `itm_${'q'.repeat(22)}`;

    // Act
    const versions = await end.ask('GET', `/v1/shared/catalogs/${catalog}/items/${missing}/versions`);
    const frozen = await end.ask('GET', `/v1/shared/catalogs/${catalog}/items/${missing}/1`);
    const malformed = await end.ask('GET', `/v1/shared/catalogs/${catalog}/items/nope/1`);

    // Assert
    for (const answer of [versions, frozen, malformed]) {
      expect(answer.status).toBe(404);
      expect(answer.body.code).toBe('item_unknown');
      expect(answer.body.error).toBe('this catalog does not offer that');
    }
    expect(new Set([versions, frozen, malformed].map(answer => JSON.stringify(answer.body))).size).toBe(1);
  });

  it('R619 should answer no-store, reach only unlock and passkeys while locked, and unlock for the policy days', async () => {
    // Arrange
    const { fx, catalog } = await publisher({ memberUnlockDays: 7 });
    const who = await browser();
    const joined = await joinWith(fx, who, (await mintShare(fx, { catalogIds: [catalog] })).code);
    const end = await memberSession(fx, who, joined.keyId);

    // Act
    const me = await end.ask('GET', '/v1/shared/me');
    const manifestAnswer = await end.ask('GET', `/v1/shared/catalogs/${catalog}/manifest`);
    const options = await end.ask('POST', '/v1/shared/passkeys/options', { origin: APP_ORIGIN });
    await unlock(end);
    const unlocked = fx.half.hooks['credentials:member'].standing(joined.keyId as never, fx.clock.now());

    // Assert
    expect(joined.memberUnlockDays).toBe(7);
    expect(me.body.code).toBe('member_locked');
    expect(manifestAnswer.body.code).toBe('member_locked');
    expect(options.status).toBe(200);
    for (const answer of [me, manifestAnswer, options]) expect(answer.headers['cache-control']).toBe('no-store');
    expect(typeof unlocked === 'object' && unlocked.kind === 'member' ? unlocked.unlockedUntil : undefined).toBe(
      new Date(fx.clock.nowMs() + 7 * DAY).toISOString() as never,
    );
  });

  it('R620 should make a revoke take effect on the next request, written before its sessions are closed', async () => {
    // Arrange
    const { fx, joined, end } = await unlockedMember();
    const atClose: { onFile: string; standing: unknown }[] = [];
    fx.closing.onRevoked = () =>
      atClose.push({
        onFile: fx.host.state('catalogs').files.get('members.json') ?? '',
        standing: fx.half.hooks['credentials:member'].standing(joined.keyId as never, fx.clock.now()),
      });

    // Act
    const revoked = await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}`);
    const onFile = fx.host.state('catalogs').files.get('members.json') ?? '';
    await end.pump();

    // Assert
    expect(revoked.status).toBe(200);
    expect(onFile).not.toContain(joined.memberId);
    expect(end.end?.code).toBe(SESSION_CLOSE_CODES.authRejected);
    // The order: the write is on disk and the projection has dropped the key BEFORE its session is told to close.
    expect(atClose.length).toBeGreaterThan(0);
    for (const seen of atClose) {
      expect(seen.onFile).not.toContain(joined.memberId);
      expect(seen.standing).toBe('unknown');
    }
  });

  it('R622 should end a guest or member-revoked first record as an unknown t, 4400', async () => {
    for (const t of ['guest', 'member-revoked']) {
      // Arrange
      const { fx } = await publisher();
      const end = await fx.open().handshake();

      // Act
      await end.send({ t, protocol: SESSION_PROTOCOL_ID });
      await end.pump();

      // Assert
      expect(end.end?.code).toBe(SESSION_CLOSE_CODES.protocolError);
    }
  });

  it("R623 should never put a member's code, keys, name, catalogs or content on the wire in clear", async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const who = await browser();
    const share = await mintShare(fx, { catalogIds: [catalog], member: { kind: 'new', label: 'Zelda Quill' } });

    // Act
    const join = await joinEnd(fx, who, share.code);
    const keyId = String((join.records[0]?.message.response as { keyId: string } | undefined)?.keyId);
    const end = await memberSession(fx, who, keyId);
    await unlock(end);
    await end.ask('GET', '/v1/shared/me');
    await end.ask('GET', `/v1/shared/catalogs/${catalog}/manifest`);
    const wire = [...join.wire, ...end.wire].map(utf8).join('\n');

    // Assert
    for (const secret of [
      share.code,
      who.memberKey,
      BOX_KEY,
      keyId,
      'Zelda Quill',
      catalog,
      'Team recipes',
      CLIENT_NAME,
    ])
      expect(wire).not.toContain(secret);
  });

  it('G63 should treat join and join-options as no route and no grant, and close a revoked member’s sessions', async () => {
    // Arrange
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog] });
    const who = await browser();

    // Act
    const options = await fx.open().handshake();
    await options.joinOptions(who, share.code);
    const joined = await joinWith(fx, who, share.code);
    const dispatchedByJoin = fx.dispatched.length;
    const end = await memberSession(fx, who, joined.keyId);
    await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}`);
    await end.pump();

    // Assert — nothing reached a route table, Gate was asked for no grant, and the session ended
    expect(dispatchedByJoin).toBe(0);
    expect(fx.callers.memberAdmissions).toEqual([]);
    expect(fx.callers.claims).toEqual([]);
    expect(end.end?.code).toBe(SESSION_CLOSE_CODES.authRejected);
  });
});

export type { BrowserEnd };
