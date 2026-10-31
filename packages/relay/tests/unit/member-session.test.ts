import { describe, it } from 'bun:test';
import {
  deviceAuthMessage,
  devicePairMessage,
  deviceRenewMessage,
  MEMBER_AUTH_LABEL,
  MEMBER_JOIN_LABEL,
  MEMBER_RENEW_LABEL,
  MemberAuthRecordSchema,
  MemberBoxKeySchema,
  memberAuthMessage,
  MemberJoinOutcomeSchema,
  MemberJoinRecordSchema,
  memberJoinMessage,
  MemberKeySchema,
  MemberRenewedRecordSchema,
  memberRenewMessage,
  signDeviceProof,
  toBase64Url,
  verifyDeviceProof,
} from '@ferretry/relay';
import should from 'should';
import { newDaemonIdentity, relayCrypto } from '../support/identities.ts';

const TH = new Uint8Array(32).fill(7);
const OTHER_TH = new Uint8Array(32).fill(8);
const KEY_ID = `mk_${'k'.repeat(22)}`;
const APP_SESSION = toBase64Url(new Uint8Array(16).fill(1));
const NONCE = toBase64Url(new Uint8Array(32).fill(2));
const BOX = toBase64Url(new Uint8Array(32).fill(3));

/** A member key, made and held the way the browser holds one; the daemon identity helper is the same key type. */
async function memberKey() {
  const identity = await newDaemonIdentity();
  return { spki: toBase64Url(identity.publicKeySpki), privateKey: identity.privateKey };
}

describe('member proofs', () => {
  it('should verify each proof under its own message and no other session', async () => {
    const key = await memberKey();
    const join = memberJoinMessage(TH, key.spki, BOX);
    const auth = memberAuthMessage(TH, KEY_ID, APP_SESSION);
    const renew = memberRenewMessage(TH, NONCE);
    for (const message of [join, auth, renew]) {
      const proof = await signDeviceProof(relayCrypto, key.privateKey, message);
      should(await verifyDeviceProof(relayCrypto, key.spki, proof, message)).be.true();
    }
    const proof = await signDeviceProof(relayCrypto, key.privateKey, auth);
    should(
      await verifyDeviceProof(relayCrypto, key.spki, proof, memberAuthMessage(OTHER_TH, KEY_ID, APP_SESSION)),
    ).be.false();
  });

  it('should never let a member proof stand in for a device proof, or the reverse', async () => {
    const key = await memberKey();
    // The same key, the same transcript, the same field text: only the label differs.
    const pairs: readonly (readonly [Uint8Array, Uint8Array])[] = [
      [memberAuthMessage(TH, KEY_ID, APP_SESSION), deviceAuthMessage(TH, 'auth', KEY_ID, APP_SESSION)],
      [memberJoinMessage(TH, key.spki, BOX), devicePairMessage(TH, key.spki)],
      [memberRenewMessage(TH, NONCE), deviceRenewMessage(TH, NONCE)],
    ];
    for (const [memberMessage, deviceMessage] of pairs) {
      const memberProof = await signDeviceProof(relayCrypto, key.privateKey, memberMessage);
      const deviceProof = await signDeviceProof(relayCrypto, key.privateKey, deviceMessage);
      should(await verifyDeviceProof(relayCrypto, key.spki, memberProof, deviceMessage)).be.false();
      should(await verifyDeviceProof(relayCrypto, key.spki, deviceProof, memberMessage)).be.false();
    }
  });

  it('should bind the box key and the key id into the proof', async () => {
    const key = await memberKey();
    const proof = await signDeviceProof(relayCrypto, key.privateKey, memberJoinMessage(TH, key.spki, BOX));
    const otherBox = toBase64Url(new Uint8Array(32).fill(4));
    should(await verifyDeviceProof(relayCrypto, key.spki, proof, memberJoinMessage(TH, key.spki, otherBox))).be.false();
    const auth = await signDeviceProof(relayCrypto, key.privateKey, memberAuthMessage(TH, KEY_ID, APP_SESSION));
    should(
      await verifyDeviceProof(relayCrypto, key.spki, auth, memberAuthMessage(TH, `mk_${'x'.repeat(22)}`, APP_SESSION)),
    ).be.false();
  });

  it('should sign under labels of their own', () => {
    should([MEMBER_JOIN_LABEL, MEMBER_AUTH_LABEL, MEMBER_RENEW_LABEL]).eql([
      'ferretry-member-join-v1',
      'ferretry-member-auth-v1',
      'ferretry-member-renew-v1',
    ]);
    const message = memberAuthMessage(TH, KEY_ID, APP_SESSION);
    should(new TextDecoder().decode(message.slice(0, MEMBER_AUTH_LABEL.length))).equal(MEMBER_AUTH_LABEL);
    should(message[MEMBER_AUTH_LABEL.length]).equal(0);
  });
});

describe('member records', () => {
  it('should read a join and a member record, and refuse an extra field or another dialect', async () => {
    const key = await memberKey();
    const join = {
      t: 'join',
      protocol: 'ferretry-relay/2',
      code: `fy_share_${'Q'.repeat(22)}`,
      clientName: 'Firefox on a Mac',
      memberKey: key.spki,
      boxKey: BOX,
      proof: 'p'.repeat(86),
    };
    should(MemberJoinRecordSchema.safeParse(join).success).be.true();
    should(MemberJoinRecordSchema.safeParse({ ...join, deviceName: 'x' }).success).be.false();
    should(MemberJoinRecordSchema.safeParse({ ...join, protocol: 'ferretry-relay/1' }).success).be.false();
    should(MemberJoinRecordSchema.safeParse({ ...join, code: 'x'.repeat(65) }).success).be.false();

    const member = {
      t: 'member',
      protocol: 'ferretry-relay/2',
      keyId: KEY_ID,
      appSession: APP_SESSION,
      proof: 'p'.repeat(86),
    };
    should(MemberAuthRecordSchema.safeParse(member).success).be.true();
    should(MemberAuthRecordSchema.safeParse({ ...member, deviceId: 'x' }).success).be.false();
    should(
      MemberRenewedRecordSchema.safeParse({ t: 'renewed', protocol: 'ferretry-relay/2', proof: 'p'.repeat(86) })
        .success,
    ).be.true();
  });

  it('should take a usable box key and an Ed25519 member key only', async () => {
    const key = await memberKey();
    should(MemberBoxKeySchema.safeParse(BOX).success).be.true();
    should(MemberBoxKeySchema.safeParse(toBase64Url(new Uint8Array(32))).success).be.false();
    should(MemberBoxKeySchema.safeParse(toBase64Url(new Uint8Array(31).fill(1))).success).be.false();
    should(MemberKeySchema.safeParse(key.spki).success).be.true();
    should(MemberKeySchema.safeParse(BOX).success).be.false();
  });

  it('should answer a join with one outcome or the one generic refusal', () => {
    const joined = {
      t: 'joined',
      protocol: 'ferretry-relay/2',
      response: {
        memberId: `mbr_${'m'.repeat(22)}`,
        keyId: KEY_ID,
        label: 'Alice',
        daemonId: `fy_daemon_${'D'.repeat(43)}`,
        daemonName: 'kirin-box',
        catalogs: [],
        passkeyWindowEndsAt: '2026-10-31T09:10:00.000Z',
        memberUnlockDays: 30,
      },
    };
    should(MemberJoinOutcomeSchema.safeParse(joined).success).be.true();
    should(
      MemberJoinOutcomeSchema.safeParse({ t: 'join-refused', protocol: 'ferretry-relay/2', reason: 'join_refused' })
        .success,
    ).be.true();
    // One reason only: a second one would be an oracle.
    should(
      MemberJoinOutcomeSchema.safeParse({ t: 'join-refused', protocol: 'ferretry-relay/2', reason: 'code_expired' })
        .success,
    ).be.false();
  });
});
