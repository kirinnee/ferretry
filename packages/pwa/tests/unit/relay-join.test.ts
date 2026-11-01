/**
 * Joining a publisher as a catalog member: the carrier walk, the sealed outcome, and what a refusal ends.
 */

import { describe, it } from 'bun:test';
import { CatalogShareCodeSchema, type ShareLinkSeed } from '@ferretry/protocol';
import should from 'should';
import {
  JoinOutcomeUnknownError,
  joinCandidates,
  joinInSession,
  joinPublisher,
  memberCandidates,
} from '../../src/lib/relay-join.ts';
import { RelayJoinRefusedError, RelaySessionError } from '../../src/lib/relay-session.ts';
import { testMemberKeys } from '../support/member-keys.ts';
import { autoDial, dialByHost, newDaemonIdentity, relayCrypto } from '../support/relay.ts';

const HOSTED = 'wss://relay.ferretry.test';
const CODE = CatalogShareCodeSchema.parse('fy_share_FAKEFAKEFAKEFAKEFAKEFA');
const FINGERPRINT = `fy_daemon_${'A'.repeat(43)}`;

const seedFor = (daemonId: string): ShareLinkSeed => ({ daemonUrl: 'https://studio.example', daemonId, code: CODE });

const joinedFor = (daemonId: string) => ({
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

const reasonOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

describe('the carriers a join walks', () => {
  it('should try the publisher’s own address, then the discovered rendezvous', () => {
    const candidates = joinCandidates(seedFor(FINGERPRINT), HOSTED);
    should(candidates.map(one => one.kind)).eql(['direct', 'relay']);
  });

  it('should offer only the direct address when this build discovered no rendezvous', () => {
    should(joinCandidates(seedFor(FINGERPRINT), undefined).map(one => one.kind)).eql(['direct']);
    should(joinCandidates(seedFor(FINGERPRINT), 'not a url').map(one => one.kind)).eql(['direct']);
  });

  it('should offer nothing for a fingerprint it cannot address', () => {
    should(joinCandidates(seedFor('sha256:legacy'), HOSTED)).eql([]);
  });
});

describe('the carriers a member session may try', () => {
  const subscription = {
    daemonId: FINGERPRINT,
    daemonUrl: 'https://studio.example',
    carriers: [
      { kind: 'direct' as const, url: 'https://studio.example' },
      { kind: 'direct' as const, url: 'https://studio.lan' },
      { kind: 'relay' as const, url: 'wss://relay.mine.test' },
    ],
  };

  it('should put its own address first, keep published relays, and add the discovered rendezvous last', () => {
    const methods = memberCandidates(subscription, HOSTED);
    should(methods[0]).match({ kind: 'direct', daemonUrl: 'https://studio.example' });
    should(methods.filter(one => one.kind === 'direct')).have.length(2);
    should(methods.at(-1)).match({ kind: 'relay', relayUrl: HOSTED });
  });

  it('should not add the rendezvous twice when the publisher already published it', () => {
    const methods = memberCandidates({ ...subscription, carriers: [{ kind: 'relay', url: HOSTED }] }, HOSTED);
    should(methods.filter(one => one.kind === 'relay')).have.length(1);
  });

  it('should drop tunnels and addresses it cannot address', () => {
    should(
      memberCandidates({ ...subscription, carriers: [{ kind: 'tunnel', url: 'https://t.example.com' }] }, undefined),
    ).have.length(1);
    should(memberCandidates({ ...subscription, daemonId: 'sha256:legacy' }, HOSTED)).eql([]);
  });
});

describe('joining in one session', () => {
  it('should refuse a fingerprint that cannot address a session rather than dialling', async () => {
    const keys = await testMemberKeys();
    const reason = await reasonOf(
      joinInSession({
        crypto: relayCrypto,
        seed: seedFor('sha256:legacy'),
        clientName: 'phone',
        method: { kind: 'relay', relayUrl: HOSTED, operator: 'hosted' },
        keys,
        key: relayCrypto.deviceKeyHandle(keys.signingKey),
        dial: () => {
          throw new Error('nothing may be dialled for an unverifiable fingerprint');
        },
      }),
    );
    should(reason).be.instanceof(RelaySessionError);
    should((reason as Error).message).match(/cannot address a session/u);
  });

  it('should send the join record and resolve with the publisher’s joined response', async () => {
    const id = await newDaemonIdentity();
    const keys = await testMemberKeys();
    const auto = autoDial(id, { joined: joinedFor(id.daemonId) });
    const response = await joinInSession({
      crypto: relayCrypto,
      seed: seedFor(id.daemonId),
      clientName: 'Alice’s phone',
      method: { kind: 'relay', relayUrl: HOSTED, operator: 'hosted' },
      keys,
      key: relayCrypto.deviceKeyHandle(keys.signingKey),
      dial: auto.dial,
      heartbeat: () => () => undefined,
    });
    should(response.label).equal('Alice');
    should(auto.requests[0]).match({
      t: 'join',
      code: CODE,
      clientName: 'Alice’s phone',
      memberKey: keys.publicKey,
      boxKey: keys.boxKey,
    });
    should(auto.sockets[0]?.closed?.code).equal(1000);
  });

  it('should reject the one generic refusal as its own class', async () => {
    const id = await newDaemonIdentity();
    const keys = await testMemberKeys();
    const auto = autoDial(id, { joinRefused: true });
    const reason = await reasonOf(
      joinInSession({
        crypto: relayCrypto,
        seed: seedFor(id.daemonId),
        clientName: 'phone',
        method: { kind: 'relay', relayUrl: HOSTED, operator: 'hosted' },
        keys,
        key: relayCrypto.deviceKeyHandle(keys.signingKey),
        dial: auto.dial,
        heartbeat: () => () => undefined,
      }),
    );
    should(reason).be.instanceof(RelayJoinRefusedError);
  });

  it('should say the share may be spent when the code was sent and nothing answered', async () => {
    const id = await newDaemonIdentity();
    const keys = await testMemberKeys();
    const auto = autoDial(id, { joinSilently: true });
    const reason = await reasonOf(
      joinInSession({
        crypto: relayCrypto,
        seed: seedFor(id.daemonId),
        clientName: 'phone',
        method: { kind: 'relay', relayUrl: HOSTED, operator: 'hosted' },
        keys,
        key: relayCrypto.deviceKeyHandle(keys.signingKey),
        dial: auto.dial,
        deadlineMs: 30,
      }),
    );
    should(reason).be.instanceof(JoinOutcomeUnknownError);
  });
});

const noHeartbeat = () => () => undefined;

describe('walking the carriers to join', () => {
  const walk = async (
    id: Awaited<ReturnType<typeof newDaemonIdentity>>,
    dial: (url: string) => never | unknown,
    heartbeat: typeof noHeartbeat | 'real' = noHeartbeat,
  ) => {
    const keys = await testMemberKeys();
    return joinPublisher({
      crypto: relayCrypto,
      seed: { daemonUrl: 'https://studio.example', daemonId: id.daemonId, code: CODE },
      clientName: 'phone',
      keys,
      hostedRelayUrl: HOSTED,
      dial: dial as never,
      ...(heartbeat === 'real' ? {} : { heartbeat }),
      directTimeoutMs: 30,
      relayTimeoutMs: 30,
    });
  };

  it('should join over the publisher’s own address first', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, { joined: joinedFor(id.daemonId) });
    const result = await walk(id, auto.dial);
    should(result).match({ kind: 'joined', carrier: { kind: 'direct' } });
  });

  it('should move to the rendezvous when the direct address does not answer', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, { joined: joinedFor(id.daemonId) });
    const routes = dialByHost({ 'relay.ferretry.test': auto.dial });
    const result = await walk(id, routes.dial);
    should(result).match({ kind: 'joined', carrier: { kind: 'relay' } });
    should(routes.dialled).have.length(2);
  });

  it('should leave the rendezvous leg to the heartbeat grace when no deadline is given', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, { joined: joinedFor(id.daemonId) });
    const routes = dialByHost({ 'relay.ferretry.test': auto.dial });
    const result = await joinPublisher({
      crypto: relayCrypto,
      seed: { daemonUrl: 'https://studio.example', daemonId: id.daemonId, code: CODE },
      clientName: 'phone',
      keys: await testMemberKeys(),
      hostedRelayUrl: HOSTED,
      dial: routes.dial as never,
      heartbeat: noHeartbeat,
      directTimeoutMs: 30,
    });
    should(result).match({ kind: 'joined', carrier: { kind: 'relay' } });
  });

  it('should stop at a refusal and not carry the code to the next carrier', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, { joinRefused: true });
    const result = await walk(id, auto.dial);
    should(result).eql({ kind: 'refused', maybeSpentUnheard: false });
    should(auto.sockets).have.length(1);
  });

  it('should report every carrier failing, and that the code may have been spent unheard', async () => {
    const id = await newDaemonIdentity();
    const silent = autoDial(id, { joinSilently: true });
    const result = await walk(id, silent.dial, 'real');
    should(result).eql({ kind: 'unreachable', maybeSpentUnheard: true, tried: 2 });

    const none = dialByHost({});
    should(await walk(id, none.dial)).eql({ kind: 'unreachable', maybeSpentUnheard: false, tried: 2 });
  });
});
