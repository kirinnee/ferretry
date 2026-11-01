/**
 * The browser's session as a catalog MEMBER: a `join` that redeems a share once, and a `member`
 * session on the member route table (docs/relay-protocol.md §14 "Member sessions").
 */

import { describe, it } from 'bun:test';
import { RELAY_SESSION_CONCLUDED_CLOSE_CODE, RELAY_SESSION_CONCLUDED_CLOSE_REASON } from '@ferretry/protocol';
import { RELAY_CLOSE_CODES, SESSION_PROTOCOL_ID } from '@ferretry/relay';
import should from 'should';
import {
  RelayClientSession,
  type RelayClientSessionDependencies,
  RelayJoinRefusedError,
  RelaySessionError,
} from '../../src/lib/relay-session.ts';
import {
  controlFrame,
  LEASE_ENDS,
  newDaemonIdentity,
  readyFrame,
  relayCrypto,
  ScriptedDaemon,
  ScriptedSocket,
  testDevice,
  testSessionId,
} from '../support/relay.ts';

const sessionId = testSessionId();
const member = await testDevice('fy_member_key');
const BOX_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
const ACCEPTED = { t: 'authenticated', protocol: SESSION_PROTOCOL_ID, accessExpiresAt: LEASE_ENDS } as const;
const joinedResponse = (daemonId: string) => ({
  memberId: 'mbr_AAAAAAAAAAAAAAAAAAAAAA',
  keyId: 'mk_AAAAAAAAAAAAAAAAAAAAAA',
  label: 'Alice',
  daemonId,
  daemonName: 'Studio',
  catalogCount: 2,
  carriers: [],
  passkeyWindowEndsAt: '2099-01-01T00:10:00.000Z',
  memberUnlockDays: 30,
});

const drain = async (): Promise<void> => {
  for (let spin = 0; spin < 20; spin += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

const opened = async (mode: RelayClientSessionDependencies['mode']) => {
  const identity = await newDaemonIdentity();
  const socket = new ScriptedSocket();
  const session = new RelayClientSession({ crypto: relayCrypto, daemonId: identity.daemonId, mode, socket });
  await session.receiveBinary(readyFrame(sessionId));
  const daemon = new ScriptedDaemon(identity, sessionId);
  await session.receiveBinary(await daemon.answer(socket.sent[0] as Uint8Array));
  await drain();
  return { session, socket, daemon, identity };
};

const joinMode = (): RelayClientSessionDependencies['mode'] => ({
  kind: 'join',
  code: 'fy_share_FAKEFAKEFAKEFAKEFAKEFA',
  clientName: 'Alice’s phone',
  memberKey: member.publicKey,
  boxKey: BOX_KEY,
  key: member.claim.key,
});

const memberMode = (): RelayClientSessionDependencies['mode'] => ({
  kind: 'member',
  member: { keyId: 'fy_mkey_one', key: member.claim.key, appSession: 'AAAAAAAAAAAAAAAAAAAAAA' },
});

const pad = (outcome: object): string => {
  const bare = JSON.stringify({ ...outcome, pad: '' });
  return JSON.stringify({ ...outcome, pad: ' '.repeat(24 * 1024 - bare.length) });
};

describe('a join session', () => {
  it('should send one join record, proved with the member key, and keep the key it registers', async () => {
    const { session, socket, daemon } = await opened(joinMode());
    should(session.credentialSent()).be.true();
    const record = (await daemon.receive(socket.sent[1] as Uint8Array)) as Record<string, unknown>;
    should(record).match({
      t: 'join',
      code: 'fy_share_FAKEFAKEFAKEFAKEFAKEFA',
      clientName: 'Alice’s phone',
      memberKey: member.publicKey,
      boxKey: BOX_KEY,
    });
    should(await daemon.proves(record, member.publicKey)).be.true();
    should(await daemon.proves(record, (await testDevice()).publicKey)).be.false();
  });

  it('should latch the sealed joined outcome and ignore the 4440 that follows it', async () => {
    const { session, daemon, identity } = await opened(joinMode());
    const joined = session.joined();
    await session.receiveBinary(
      await daemon.record(
        null,
        pad({ t: 'joined', protocol: SESSION_PROTOCOL_ID, response: joinedResponse(identity.daemonId) }),
      ),
    );
    await session.receiveBinary(
      controlFrame(sessionId, {
        t: 'closed',
        code: RELAY_SESSION_CONCLUDED_CLOSE_CODE,
        reason: RELAY_SESSION_CONCLUDED_CLOSE_REASON,
      }),
    );
    should(await joined).match({ kind: 'joined', response: { label: 'Alice', keyId: 'mk_AAAAAAAAAAAAAAAAAAAAAA' } });
  });

  it('should reject with the one generic refusal when the publisher refuses inside the channel', async () => {
    const { session, daemon } = await opened(joinMode());
    const joined = session.joined();
    await session.receiveBinary(
      await daemon.record(null, pad({ t: 'join-refused', protocol: SESSION_PROTOCOL_ID, reason: 'join_refused' })),
    );
    await session.receiveBinary(
      controlFrame(sessionId, {
        t: 'closed',
        code: RELAY_SESSION_CONCLUDED_CLOSE_CODE,
        reason: RELAY_SESSION_CONCLUDED_CLOSE_REASON,
      }),
    );
    const reason = await joined.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    should(reason).be.instanceof(RelayJoinRefusedError);
  });

  it('should fail, not settle, when the session closes before any outcome', async () => {
    const { session } = await opened(joinMode());
    const joined = session.joined();
    await session.receiveBinary(
      controlFrame(sessionId, { t: 'closed', code: RELAY_CLOSE_CODES.daemonAbsent, reason: 'gone' }),
    );
    const reason = await joined.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    should(reason).be.instanceof(RelaySessionError);
  });

  it('should refuse any record that is not a join outcome', async () => {
    const { session, daemon } = await opened(joinMode());
    const joined = session.joined();
    await session.receiveBinary(await daemon.record(ACCEPTED));
    const reason = await joined.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    should(reason).be.instanceof(RelaySessionError);
  });

  it('should never answer a renew on a join session', async () => {
    const { session, socket, daemon } = await opened(joinMode());
    const before = socket.sent.length;
    await session.receiveBinary(
      await daemon.record({ t: 'renew', protocol: SESSION_PROTOCOL_ID, nonce: 'bm9uY2U', expiresAt: LEASE_ENDS }),
    );
    await drain();
    should(socket.sent.length).equal(before);
  });
});

describe('a member session', () => {
  it('should open with a member record proved by the member key over this transcript', async () => {
    const { socket, daemon } = await opened(memberMode());
    const record = (await daemon.receive(socket.sent[1] as Uint8Array)) as Record<string, unknown>;
    should(record).match({ t: 'member', keyId: 'fy_mkey_one', appSession: 'AAAAAAAAAAAAAAAAAAAAAA' });
    should(record).not.have.property('deviceId');
    should(await daemon.proves(record, member.publicKey)).be.true();
    should(await daemon.proves(record, (await testDevice()).publicKey)).be.false();
  });

  it('should serve requests once the publisher says authenticated', async () => {
    const { session, daemon } = await opened(memberMode());
    const ready = session.ready();
    await session.receiveBinary(await daemon.record(ACCEPTED));
    await ready;
    should(session.live()).be.true();
  });

  it('should refuse a stream-opened on a member session', async () => {
    const { session, daemon } = await opened(memberMode());
    const ready = session.ready();
    await session.receiveBinary(
      await daemon.record({ t: 'stream-opened', protocol: SESSION_PROTOCOL_ID, accessExpiresAt: LEASE_ENDS }),
    );
    const reason = await ready.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    should(reason).be.instanceof(RelaySessionError);
  });

  it('should renew its lease under the member label, which a device label does not satisfy', async () => {
    const { session, socket, daemon } = await opened(memberMode());
    await session.receiveBinary(await daemon.record(ACCEPTED));
    await daemon.receive(socket.sent[1] as Uint8Array);
    await session.receiveBinary(
      await daemon.record({ t: 'renew', protocol: SESSION_PROTOCOL_ID, nonce: 'bm9uY2Utb25l', expiresAt: LEASE_ENDS }),
    );
    await drain();
    const renewed = (await daemon.receive(socket.sent[2] as Uint8Array)) as Record<string, unknown>;
    should(renewed).match({ t: 'renewed', protocol: SESSION_PROTOCOL_ID });
    should(await daemon.proves(renewed, member.publicKey, 'bm9uY2Utb25l', 'member')).be.true();
    should(await daemon.proves(renewed, member.publicKey, 'bm9uY2Utb25l', 'device')).be.false();
  });

  it('should report a 4403 close as the key being refused', async () => {
    const { session } = await opened(memberMode());
    const ready = session.ready();
    await session.receiveBinary(
      controlFrame(sessionId, {
        t: 'closed',
        code: RELAY_CLOSE_CODES.authRejected,
        reason: 'unknown device credential',
      }),
    );
    const reason = (await ready.then(
      () => undefined,
      (thrown: unknown) => thrown,
    )) as RelaySessionError;
    should(reason).be.instanceof(RelaySessionError);
    should(reason.code).equal(RELAY_CLOSE_CODES.authRejected);
  });
});
