/**
 * CATALOG MEMBER SESSIONS, END TO END ON THE PUBLISHER, over both carriers a browser can reach it by.
 *
 * Nothing between the browser's records and the files is faked: the real direct carrier (and, for the relayed
 * variant, the real `RelayLink`) opens the real session, seals every record under real AES-256-GCM, and hands a
 * join and a member's requests to the real `MemberGateway` over the real `CatalogMemberService`, whose members and
 * shares live in real files under a temporary state home. The only fakes are what a daemon does not own here: the
 * socket, the clock the member side reads, and the WebAuthn authenticator (a member's passkey ceremony is not what
 * this suite is about, so the verifier refuses everything and the cases that need one stop at the options).
 *
 * WRITTEN AGAINST THE CONTRACT IN docs/relay-protocol.md §14 "Member sessions"; it is the join, the member
 * route table's gate, and a revoke ending a live session that these cases watch.
 */

import { afterEach, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CatalogShareMintRequest,
  MemberJoinedResponseSchema,
  RELAY_SESSION_CONCLUDED_CLOSE_CODE,
} from '@ferretry/protocol';
import {
  type ChannelState,
  completeClientHandshake,
  type DaemonIdentity,
  decodeControlMessage,
  decodeDaemonHello,
  decodeFrame,
  encodeControlMessage,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  HANDSHAKE_FRAME_SEQUENCE,
  MEMBER_JOIN_OUTCOME_BYTES,
  memberAuthMessage,
  memberJoinMessage,
  NONCE_BYTES,
  openChannel,
  openRecord,
  type PrivateKeyHandle,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type RelayFrame,
  SESSION_PROTOCOL_ID,
  type SessionId,
  sealRecord,
  sessionIdFromBytes,
  signDeviceProof,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
  utf8Text,
} from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import should from 'should';
import {
  FileCatalogMembersStore,
  FileCatalogSharesStore,
  NodeShareCodeHasher,
} from '../../../src/adapters/catalog-members/index.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import type { ApiRequest, ApiResponse } from '../../../src/lib/api/http.ts';
import type { SocketDownstream, SocketHandler } from '../../../src/lib/api/socket.ts';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import {
  CatalogMemberService,
  LiveMemberSessions,
  MemberDispatcher,
  MemberGateway,
  MemberJoinGate,
  MemberPasskeyService,
} from '../../../src/lib/catalog-members/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { LiveDeviceConnections } from '../../../src/lib/pairing/index.ts';
import { RelayLink, type RelayLinkSocket } from '../../../src/lib/relay/index.ts';
import { tunnelMemberRequest } from '../../../src/lib/relay/tunnel.ts';
import { directCarrierSocketRoute } from '../../../src/lib/runtime/mounts/direct-carrier.ts';
import { ChallengeLedger } from '../../../src/lib/step-up/registry.ts';
import type { StoredPasskey } from '../../../src/lib/step-up/types.ts';
import { request } from '../../unit/api/support.ts';

const relayCrypto = new WebCryptoRelayCrypto();
const CATALOG = `cat_${'c'.repeat(22)}`;
const APP_ORIGIN = 'https://app.example';
const APP_SESSION = toBase64Url(new Uint8Array(16).fill(5));
const BOX_KEY = toBase64Url(new Uint8Array(32).fill(7));

const field = (record: { readonly message: Record<string, unknown> } | undefined, name: string): unknown =>
  record?.message[name];
const CLIENT_NAME = 'Firefox on a Mac';
const CREDENTIAL = new TextEncoder().encode('credential-one');
const MINUTE = 60_000;
const MINT: CatalogShareMintRequest = {
  catalogIds: [CATALOG],
  member: { kind: 'new', label: 'Alice' },
  expiresIn: '1h',
  uses: { kind: 'single' },
};

let identity: DaemonIdentity;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  identity = await relayCrypto.importDaemonIdentity(
    ['-----BEGIN PRIVATE KEY-----', ...(base64.match(/.{1,64}/gu) ?? []), '-----END PRIVATE KEY-----', ''].join('\n'),
  );
});

const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

/** Waits for a condition the daemon makes true off the event loop — a sealed record, a close — never a fixed sleep. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition was not met in time');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

// ─── the publisher, built the way fyd builds it, over real files ────────────────────────────────

async function publisher() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-member-sessions-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  const clock = { now: Date.now() };
  const audited: AuditEntry[] = [];
  const audit = {
    record: async (entry: AuditEntry) => {
      audited.push(entry);
    },
  };
  const live = new LiveMemberSessions();
  const stored: StoredPasskey[] = [];
  const members = new CatalogMemberService({
    members: new FileCatalogMembersStore(paths, files),
    shares: new FileCatalogSharesStore(paths, files),
    hasher: new NodeShareCodeHasher(),
    crypto: relayCrypto,
    catalogs: { knownIds: async () => new Set([CATALOG]) },
    links: {
      target: () => ({
        kind: 'ready',
        appOrigin: APP_ORIGIN,
        daemonUrl: 'https://studio.example:8443',
        daemonId: identity.daemonId,
      }),
    },
    sessions: {
      closeMember: async memberId => await live.closeMember(memberId),
      closeKey: async (memberId, keyId) => await live.closeKey(memberId, keyId),
    },
    audit,
    now: () => clock.now,
  });
  const passkeys = new MemberPasskeyService({
    store: {
      list: async keyId => stored.filter(row => row.deviceId === keyId),
      holder: async credentialId => stored.find(row => row.credentialId === credentialId)?.deviceId,
      add: async passkey => {
        stored.push(passkey);
      },
      updateSignCount: async () => true,
      forgetDevice: async keyId => {
        stored.splice(0, stored.length, ...stored.filter(row => row.deviceId !== keyId));
      },
    },
    // This suite owns no authenticator: any well-formed ceremony is taken as done, so a key can be unlocked.
    verifier: {
      verifyRegistration: async () => ({
        ok: true,
        credentialId: CREDENTIAL,
        algorithm: -7,
        publicKeySpki: new Uint8Array(32).fill(7),
        signCount: 0,
        origin: APP_ORIGIN,
      }),
      verifyAssertion: async () => ({ ok: true, signCount: 1, origin: APP_ORIGIN }),
    },
    challenges: new ChallengeLedger(),
    random: { bytes: length => crypto.getRandomValues(new Uint8Array(length)) },
    clock: { nowMs: () => clock.now },
    members: {
      passkeyAdded: async keyId => await members.passkeyAdded(keyId),
      access: async keyId => await members.access(keyId),
    },
    catalogNames: async () => new Map([[CATALOG, 'Workshop']]),
    allowedOrigins: () => [APP_ORIGIN],
    relyingPartyName: 'Ferretry',
    daemonName: () => 'studio',
    unlockDays: () => 30,
    audit,
  });
  const dispatcher = new MemberDispatcher({
    members,
    passkeys,
    sessions: live,
    catalogs: {
      catalogs: async () => [{ id: CATALOG, name: 'Workshop', revision: 3 }],
      signedManifest: async () => {
        throw new Error('this suite reads no manifest');
      },
      versionsRevision: async () => {
        throw new Error('this suite reads no version list');
      },
      signedVersions: async () => {
        throw new Error('this suite reads no version list');
      },
      frozenItem: async () => {
        throw new Error('this suite reads no item');
      },
    },
    publisher: () => ({ daemonId: identity.daemonId, daemonName: 'studio', carriers: [] }),
    audit,
    now: () => clock.now,
  });
  const gate = new MemberJoinGate({
    members,
    publisher: () => ({ daemonId: identity.daemonId, daemonName: 'studio', carriers: [], memberUnlockDays: 30 }),
    audit,
    now: () => clock.now,
    after: () => undefined,
  });
  const gateway = new MemberGateway({ gate, dispatcher, members, live });
  /** Every request the DEVICE side was asked: a member must never put one here. */
  const deviceRequests: ApiRequest[] = [];
  const deviceDispatch = async (asked: ApiRequest): Promise<ApiResponse> => {
    deviceRequests.push(asked);
    return { status: 200, headers: new Map(), body: '{"device":true}' };
  };
  return { paths, clock, audited, live, members, gateway, deviceRequests, deviceDispatch };
}

type Publisher = Awaited<ReturnType<typeof publisher>>;

// ─── a browser: a member key and the transcript it signs ────────────────────────────────────────

interface Browser {
  readonly memberKey: string;
  readonly handle: PrivateKeyHandle;
}

async function browser(): Promise<Browser> {
  const key = await relayCrypto.generateDeviceKey();
  return { memberKey: toBase64Url(key.publicKeySpki), handle: relayCrypto.deviceKeyHandle(key.privateKey) };
}

// ─── one session over either carrier, behind one shape ──────────────────────────────────────────

interface Wire {
  readonly frames: RelayFrame[];
  /** Socket closes a direct carrier made, by code. */
  readonly closes: number[];
}

interface Peer {
  readonly transcript: Uint8Array;
  send(message: unknown): Promise<void>;
  /** Every sealed record the daemon sent, opened in order, with the plaintext byte count of each. */
  records(): Promise<{ readonly message: Record<string, unknown>; readonly bytes: number }[]>;
  /** Every close the daemon made of this session, by code, however the carrier says it. */
  closeCodes(): number[];
  until(condition: () => boolean): Promise<void>;
  /** The records, once at least this many have arrived. */
  recordsAfter(count: number): Promise<{ readonly message: Record<string, unknown>; readonly bytes: number }[]>;
}

function peerOver(
  wire: Wire,
  sessionId: SessionId,
  deliver: (bytes: Uint8Array) => Promise<void>,
  keys: { readonly transcriptHash: Uint8Array },
  channel: ChannelState,
): Peer {
  let sending = channel;
  const dataFrames = (): number =>
    wire.frames.filter(frame => frame.kind === FRAME_KINDS.data && frame.sessionId.text === sessionId.text).length;
  const records = async () => {
    let receiving = channel;
    const out: { message: Record<string, unknown>; bytes: number }[] = [];
    for (const frame of wire.frames.filter(
      candidate => candidate.kind === FRAME_KINDS.data && candidate.sessionId.text === sessionId.text,
    )) {
      const opened = await openRecord(relayCrypto, receiving, frame);
      if (!opened.ok) throw new Error(opened.reason);
      receiving = opened.state;
      out.push({
        message: JSON.parse(utf8Text(opened.plaintext) ?? 'null') as Record<string, unknown>,
        bytes: opened.plaintext.byteLength,
      });
    }
    return out;
  };
  return {
    transcript: keys.transcriptHash,
    send: async message => {
      const sealed = await sealRecord(relayCrypto, sending, utf8Bytes(JSON.stringify(message)));
      if (!sealed.ok) throw new Error(sealed.reason);
      sending = sealed.state;
      await deliver(encodeFrame(sealed.frame));
    },
    records,
    closeCodes: () => [
      ...wire.closes,
      ...wire.frames.flatMap(frame => {
        if (frame.kind !== FRAME_KINDS.control) return [];
        const decoded = decodeControlMessage(frame.payload);
        return decoded?.t === 'closed' && frame.sessionId.text === sessionId.text ? [decoded.code] : [];
      }),
    ],
    until,
    recordsAfter: async count => {
      await until(() => dataFrames() >= count);
      return await records();
    },
  };
}

/** The publisher's carriers, built once per case, each opening sessions the browser's way. */
interface Carrier {
  readonly name: 'direct' | 'relay';
  open(): Promise<Peer>;
}

function directCarrier(rig: Publisher): Carrier {
  const route = directCarrierSocketRoute({
    crypto: relayCrypto,
    identity,
    dispatch: rig.deviceDispatch,
    sockets: { upgrade: async () => ({ outcome: 'unclaimed' }), reauthorize: () => true },
    devices: { deviceKey: async () => undefined, seen: () => undefined },
    pairing: { redeemInSession: async () => ({ kind: 'refused' }) },
    members: rig.gateway,
    scheduler: {
      after: (milliseconds, action) => {
        const timer = setTimeout(action, milliseconds);
        return { cancel: () => clearTimeout(timer) };
      },
    },
    clock: { now: () => Date.now() },
    connections: new LiveDeviceConnections(),
  });
  return {
    name: 'direct',
    open: async () => {
      const attach = await route.accept({
        request: request({ path: `/v1/rendezvous/${identity.daemonId}/client`, clientAddress: '203.0.113.9' }),
        params: new Map([['daemonId', identity.daemonId]]),
      });
      const wire: Wire = { frames: [], closes: [] };
      const downstream: SocketDownstream = {
        send: frame => {
          if (typeof frame !== 'string') {
            const decoded = decodeFrame(frame);
            if (!decoded.ok) throw new Error(decoded.reason);
            wire.frames.push(decoded.frame);
          }
          return 0;
        },
        close: code => {
          wire.closes.push(code);
        },
        bufferedBytes: () => 0,
      };
      const handler: SocketHandler = await attach(downstream);
      await handler.open();
      const ready = wire.frames[0];
      if (ready === undefined) throw new Error('the daemon announced no session');
      const keyed = await handshake(wire, ready.sessionId, async bytes => handler.fromClient(bytes));
      return peerOver(wire, ready.sessionId, async bytes => handler.fromClient(bytes), keyed.keys, keyed.channel);
    },
  };
}

function relayCarrier(rig: Publisher): Carrier {
  const wire: Wire = { frames: [], closes: [] };
  const socket: RelayLinkSocket = {
    send: bytes => {
      const decoded = decodeFrame(bytes);
      if (!decoded.ok) throw new Error(`the daemon sent an undecodable frame: ${decoded.reason}`);
      wire.frames.push(decoded.frame);
    },
    sendText: () => undefined,
    close: () => undefined,
  };
  const link = new RelayLink({
    crypto: relayCrypto,
    identity,
    relayHost: 'relay.example',
    socket,
    dispatch: rig.deviceDispatch,
    sockets: { upgrade: async () => ({ outcome: 'unclaimed' }), reauthorize: () => true },
    devices: { deviceKey: async () => undefined, seen: () => undefined },
    connections: new LiveDeviceConnections(),
    pairing: { redeemInSession: async () => ({ kind: 'refused' }) },
    members: rig.gateway,
    clock: { now: () => Date.now() },
    scheduler: {
      after: (milliseconds, action) => {
        const timer = setTimeout(action, milliseconds);
        return { cancel: () => clearTimeout(timer) };
      },
    },
  });
  const control = (message: Parameters<typeof encodeControlMessage>[0], sessionId: SessionId = RENDEZVOUS_SESSION_ID) =>
    encodeFrame({ kind: FRAME_KINDS.control, sessionId, sequence: 0, payload: encodeControlMessage(message) });
  let claimed: Promise<void> | undefined;
  let opened = 0;
  return {
    name: 'relay',
    open: async () => {
      claimed ??= (async () => {
        await link.receiveBinary(
          control({
            t: 'challenge',
            protocol: RELAY_PROTOCOL_ID,
            nonce: toBase64Url(relayCrypto.randomBytes(NONCE_BYTES)),
            host: 'relay.example',
            deadlineSeconds: 10,
          }),
        );
        await link.receiveBinary(
          control({
            t: 'claimed',
            protocol: RELAY_PROTOCOL_ID,
            limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
          }),
        );
      })();
      await claimed;
      opened += 1;
      const sessionId = sessionIdFromBytes(new Uint8Array([4, 4, 4, opened, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
      if (sessionId === null) throw new Error('unreachable: 16 bytes');
      await link.receiveBinary(control({ t: 'open' }, sessionId));
      const keyed = await handshake(wire, sessionId, async bytes => await link.receiveBinary(bytes));
      return peerOver(wire, sessionId, async bytes => await link.receiveBinary(bytes), keyed.keys, keyed.channel);
    },
  };
}

/** The client half of the handshake, over whichever carrier delivers the bytes. */
async function handshake(wire: Wire, sessionId: SessionId, deliver: (bytes: Uint8Array) => Promise<void>) {
  const pending = await startClientHandshake(relayCrypto, sessionId, identity.daemonId);
  await deliver(
    encodeFrame({
      kind: FRAME_KINDS.handshake,
      sessionId,
      sequence: HANDSHAKE_FRAME_SEQUENCE,
      payload: encodeHandshakeMessage(pending.hello),
    }),
  );
  await until(() =>
    wire.frames.some(frame => frame.kind === FRAME_KINDS.handshake && frame.sessionId.text === sessionId.text),
  );
  const answer = wire.frames.find(
    frame => frame.kind === FRAME_KINDS.handshake && frame.sessionId.text === sessionId.text,
  );
  const hello = answer === undefined ? null : decodeDaemonHello(answer.payload);
  if (hello === null) throw new Error('the daemon hello did not parse');
  const completed = await completeClientHandshake(relayCrypto, pending, hello);
  if (!completed.ok) throw new Error(completed.reason);
  return { keys: completed.keys, channel: openChannel(sessionId, completed.keys, 'client') };
}

// ─── what a browser says ────────────────────────────────────────────────────────────────────────

async function sendJoin(peer: Peer, who: Browser, code: string): Promise<void> {
  const proof = await signDeviceProof(
    relayCrypto,
    who.handle,
    memberJoinMessage(peer.transcript, who.memberKey, BOX_KEY),
  );
  await peer.send({
    t: 'join',
    protocol: SESSION_PROTOCOL_ID,
    code,
    clientName: CLIENT_NAME,
    memberKey: who.memberKey,
    boxKey: BOX_KEY,
    proof,
  });
}

async function sendMember(peer: Peer, who: Browser, keyId: string): Promise<void> {
  const proof = await signDeviceProof(relayCrypto, who.handle, memberAuthMessage(peer.transcript, keyId, APP_SESSION));
  await peer.send({ t: 'member', protocol: SESSION_PROTOCOL_ID, keyId, appSession: APP_SESSION, proof });
}

/** One request on a member session and its parsed answer. */
async function ask(peer: Peer, id: number, method: string, path: string, body?: unknown) {
  await peer.send({
    t: 'req',
    id,
    method,
    path,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  await peer.until(() => false || true);
  let answer: Record<string, unknown> | undefined;
  await peer.until(() => {
    void peer.records().then(all => {
      answer = all.find(entry => entry.message.t === 'res' && entry.message.id === id)?.message;
    });
    return answer !== undefined;
  });
  const res = answer as { status: number; body: string };
  return { status: res.status, body: JSON.parse(res.body) as { code?: string } & Record<string, unknown> };
}

/** Registers the key's one passkey inside its window and unlocks it, as the app does, on an open member session. */
async function unlock(peer: Peer): Promise<void> {
  const text = (value: Uint8Array | string) => Buffer.from(value).toString('base64url');
  const credentialId = text(CREDENTIAL);
  await ask(peer, 101, 'POST', '/v1/shared/passkeys/options', { origin: APP_ORIGIN });
  const registered = await ask(peer, 102, 'POST', '/v1/shared/passkeys', {
    credentialId,
    clientDataJSON: text('client'),
    attestationObject: text('attestation'),
  });
  should(registered.status).equal(201);
  await ask(peer, 103, 'POST', '/v1/shared/unlock/options', { origin: APP_ORIGIN });
  const unlocked = await ask(peer, 104, 'POST', '/v1/shared/unlock', {
    credentialId,
    clientDataJSON: text('client'),
    authenticatorData: text('authenticator'),
    signature: text('signature'),
  });
  should(unlocked.status).equal(200);
}

/** Joins with a fresh code and answers who the publisher made. */
async function joined(carrier: Carrier, rig: Publisher, who: Browser) {
  const minted = await rig.members.mint(MINT);
  const peer = await carrier.open();
  await sendJoin(peer, who, minted.code);
  const [outcome] = await peer.recordsAfter(1);
  const response = MemberJoinedResponseSchema.parse(field(outcome, 'response'));
  await peer.until(() => peer.closeCodes().includes(RELAY_SESSION_CONCLUDED_CLOSE_CODE));
  return { code: minted.code, response };
}

// ─── the cases, once per carrier ────────────────────────────────────────────────────────────────

for (const build of [directCarrier, relayCarrier]) {
  describe(`a catalog member on the publisher, over the ${build === directCarrier ? 'direct' : 'relay'} carrier`, () => {
    it('should seal a padded joined, file the member and key, close with 4440, and keep the code out of every record', async () => {
      // Arrange
      const rig = await publisher();
      const carrier = build(rig);
      const who = await browser();
      const minted = await rig.members.mint(MINT);
      const peer = await carrier.open();

      // Act
      await sendJoin(peer, who, minted.code);
      const [outcome] = await peer.recordsAfter(1);
      await peer.until(() => peer.closeCodes().includes(RELAY_SESSION_CONCLUDED_CLOSE_CODE));

      // Assert — the answer, padded to the one size every outcome has
      should(outcome?.message.t).equal('joined');
      should(outcome?.bytes).equal(MEMBER_JOIN_OUTCOME_BYTES);
      const response = MemberJoinedResponseSchema.parse(field(outcome, 'response'));
      should(response).containDeep({ label: 'Alice', daemonId: identity.daemonId, catalogCount: 1 });

      // Assert — the person and the key are on the publisher, the code is spent, and nothing wrote the code down
      const listed = await rig.members.listMembers();
      should(listed.members).have.length(1);
      should(listed.members[0]?.keys.map(key => key.keyId)).deepEqual([response.keyId]);
      const onDisk = await readFile(rig.paths.catalogShares, 'utf8');
      should(onDisk).not.containEql(minted.code);
      should(JSON.stringify(rig.audited)).not.containEql(minted.code);
      should(rig.audited.find(entry => entry.event === 'catalog.member.joined')).containDeep({
        detail: { memberLabel: 'Alice', keyId: response.keyId, clientName: CLIENT_NAME },
      });
    });

    it('should refuse a wrong code with the same padded size and the same close, and file nobody', async () => {
      // Arrange
      const rig = await publisher();
      const carrier = build(rig);
      const peer = await carrier.open();

      // Act
      await sendJoin(peer, await browser(), `fy_share_${'A'.repeat(22)}`);
      const [outcome] = await peer.recordsAfter(1);
      await peer.until(() => peer.closeCodes().includes(RELAY_SESSION_CONCLUDED_CLOSE_CODE));

      // Assert
      should(outcome?.message).containDeep({ t: 'join-refused', reason: 'join_refused' });
      should(outcome?.bytes).equal(MEMBER_JOIN_OUTCOME_BYTES);
      should((await rig.members.listMembers()).members).have.length(0);
      should(rig.audited.find(entry => entry.event === 'catalog.member.join-refused')).containDeep({
        outcome: 'refused',
      });
    });

    it('should refuse a join whose proof was signed by a different key, and leave the code live', async () => {
      // Arrange
      const rig = await publisher();
      const carrier = build(rig);
      const minted = await rig.members.mint(MINT);
      const claimant = await browser();
      const forger = await browser();
      const peer = await carrier.open();
      const proof = await signDeviceProof(
        relayCrypto,
        forger.handle,
        memberJoinMessage(peer.transcript, claimant.memberKey, BOX_KEY),
      );

      // Act
      await peer.send({
        t: 'join',
        protocol: SESSION_PROTOCOL_ID,
        code: minted.code,
        clientName: CLIENT_NAME,
        memberKey: claimant.memberKey,
        boxKey: BOX_KEY,
        proof,
      });
      const [outcome] = await peer.recordsAfter(1);

      // Assert — refused, nobody filed, and the same code still joins on a fresh session
      should(outcome?.message.t).equal('join-refused');
      should((await rig.members.listMembers()).members).have.length(0);
      const again = await build(rig).open();
      await sendJoin(again, claimant, minted.code);
      should((await again.recordsAfter(1))[0]?.message.t).equal('joined');
    });

    it('should serve a joined key a member session that reaches only the unlock and, in its window, passkeys', async () => {
      // Arrange
      const rig = await publisher();
      const carrier = build(rig);
      const who = await browser();
      const { response } = await joined(carrier, rig, who);

      // Act
      const peer = await carrier.open();
      await sendMember(peer, who, response.keyId);
      const [authenticated] = await peer.recordsAfter(1);

      // Assert — admitted, with a lease
      should(authenticated?.message).containDeep({ t: 'authenticated' });
      should(field(authenticated, 'accessExpiresAt')).be.a.String();

      // Assert — before the unlock, what a member reads is locked, even its own name
      const me = await ask(peer, 1, 'GET', '/v1/shared/me');
      should(me.status).equal(403);
      should(me.body.code).equal('member_locked');

      // Assert — the passkey ceremony opens inside the key's window
      const options = await ask(peer, 2, 'POST', '/v1/shared/passkeys/options', { origin: APP_ORIGIN });
      should(options.status).equal(200);
      should(options.body).have.property('challenge');

      // Assert — an unlock without a passkey is refused, and a route of the device table is simply not there
      const unlock = await ask(peer, 3, 'POST', '/v1/shared/unlock/options', { origin: APP_ORIGIN });
      should(unlock.status).equal(404);
      should(unlock.body.code).equal('member_no_passkey');
      const device = await ask(peer, 4, 'GET', '/v1/sessions');
      should(device.status).equal(404);
      should(rig.deviceRequests).have.length(0);
    });

    it('should close the passkey window ten minutes after the join', async () => {
      // Arrange
      const rig = await publisher();
      const carrier = build(rig);
      const who = await browser();
      const { response } = await joined(carrier, rig, who);
      const peer = await carrier.open();
      await sendMember(peer, who, response.keyId);
      await peer.recordsAfter(1);

      // Act — the window the join reported has passed, with no passkey made
      rig.clock.now = Date.parse(response.passkeyWindowEndsAt) + MINUTE;
      const options = await ask(peer, 1, 'POST', '/v1/shared/passkeys/options', { origin: APP_ORIGIN });

      // Assert — a key with no passkey whose window has closed is over: the request is refused as a
      // browser that is no longer here, and the same key cannot open another session
      should(options.status).equal(401);
      const again = await carrier.open();
      await sendMember(again, who, response.keyId);
      await again.until(() => again.closeCodes().includes(RELAY_CLOSE_CODES.authRejected));
    });

    it('should refuse a key idle for 91 days at the door, and not let opening a session revive it', async () => {
      // Arrange — a key that registered its passkey, so only idleness can end it
      const rig = await publisher();
      const carrier = build(rig);
      const who = await browser();
      const { response } = await joined(carrier, rig, who);
      const first = await carrier.open();
      await sendMember(first, who, response.keyId);
      await first.recordsAfter(1);
      await unlock(first);

      // Act — 91 days later, before any sweep has run
      rig.clock.now += 91 * 24 * 60 * MINUTE;
      const late = await carrier.open();
      await sendMember(late, who, response.keyId);
      await late.until(() => late.closeCodes().includes(RELAY_CLOSE_CODES.authRejected));
      const retry = await carrier.open();
      await sendMember(retry, who, response.keyId);
      await retry.until(() => retry.closeCodes().includes(RELAY_CLOSE_CODES.authRejected));

      // Assert — nothing was answered, and the refusals did not refresh the key's last use
      should((await late.records()).length).equal(0);
      should((await retry.records()).length).equal(0);
    });

    it("should answer a leave with its 200 and then conclude with 4440, never 4403, ending the key's other tab", async () => {
      // Arrange — one key, two tabs, the first one unlocked
      const rig = await publisher();
      const carrier = build(rig);
      const who = await browser();
      const { response } = await joined(carrier, rig, who);
      const leaving = await carrier.open();
      await sendMember(leaving, who, response.keyId);
      await leaving.recordsAfter(1);
      await unlock(leaving);
      const otherTab = await carrier.open();
      await sendMember(otherTab, who, response.keyId);
      await otherTab.recordsAfter(1);

      // Act
      const left = await ask(leaving, 201, 'DELETE', '/v1/shared/me/keys/self');

      // Assert — the browser got its 200 and then a conclusion: it can tell "I left" from "I was refused"
      should(left.status).equal(200);
      should(left.body).containDeep({ keyId: response.keyId });
      await leaving.until(() => leaving.closeCodes().includes(RELAY_SESSION_CONCLUDED_CLOSE_CODE));
      should(leaving.closeCodes()).not.containEql(RELAY_CLOSE_CODES.authRejected);

      // Assert — the key is gone, so its other tab is refused the ordinary way
      await otherTab.until(() => otherTab.closeCodes().includes(RELAY_CLOSE_CODES.authRejected));
      should(rig.live.size).equal(0);
      should((await rig.members.listMembers()).members[0]?.keys).deepEqual([]);
    });

    it('should end an unknown key and a bad proof with the same 4403', async () => {
      // Arrange
      const rig = await publisher();
      const carrier = build(rig);
      const who = await browser();
      const { response } = await joined(carrier, rig, who);

      // Act — a key id nobody filed
      const unknown = await carrier.open();
      await sendMember(unknown, who, `mk_${'Z'.repeat(22)}`);
      await unknown.until(() => unknown.closeCodes().length > 0);

      // Act — a real key id, signed by somebody else
      const forged = await carrier.open();
      await sendMember(forged, await browser(), response.keyId);
      await forged.until(() => forged.closeCodes().length > 0);

      // Assert
      should(unknown.closeCodes()).containEql(RELAY_CLOSE_CODES.authRejected);
      should(forged.closeCodes()).containEql(RELAY_CLOSE_CODES.authRejected);
      should((await unknown.records()).length).equal(0);
      should((await forged.records()).length).equal(0);
    });

    it('should end a live member session at once when the member is revoked, and refuse the request in flight', async () => {
      // Arrange — a member with a session open and a request in hand
      const rig = await publisher();
      const carrier = build(rig);
      const who = await browser();
      const { response } = await joined(carrier, rig, who);
      const peer = await carrier.open();
      await sendMember(peer, who, response.keyId);
      await peer.recordsAfter(1);
      const inFlight = tunnelMemberRequest(
        { method: 'POST', path: '/v1/shared/passkeys/options', body: JSON.stringify({ origin: APP_ORIGIN }) },
        { memberId: response.memberId, keyId: response.keyId, appSession: APP_SESSION, sessionId: 'in-flight' },
        'in-flight',
      );
      should(rig.live.size).equal(1);

      // Act — the owner revokes: written first, then the session is closed
      await rig.members.revokeMember(response.memberId);

      // Assert — the session ended with the one close an unknown key gets
      await peer.until(() => peer.closeCodes().includes(RELAY_CLOSE_CODES.authRejected));
      should(rig.live.size).equal(0);

      // Assert — the request that was already on its way is refused at the boundary, not served
      const refused = await rig.gateway.dispatch(inFlight);
      should(refused.status).equal(401);

      // Assert — and the same key cannot open another session
      const again = await carrier.open();
      await sendMember(again, who, response.keyId);
      await again.until(() => again.closeCodes().includes(RELAY_CLOSE_CODES.authRejected));
    });

    it('should end only the one browser removed, not the member`s other session', async () => {
      // Arrange — one member, two browsers, each with a live session
      const rig = await publisher();
      const carrier = build(rig);
      const first = await browser();
      const second = await browser();
      const { response } = await joined(carrier, rig, first);
      const minted = await rig.members.mint({
        ...MINT,
        member: { kind: 'existing', memberId: response.memberId },
      });
      const joiner = await carrier.open();
      await sendJoin(joiner, second, minted.code);
      const [secondOutcome] = await joiner.recordsAfter(1);
      const secondKey = MemberJoinedResponseSchema.parse(field(secondOutcome, 'response'));
      const one = await carrier.open();
      await sendMember(one, first, response.keyId);
      await one.recordsAfter(1);
      const two = await carrier.open();
      await sendMember(two, second, secondKey.keyId);
      await two.recordsAfter(1);

      // Act
      await rig.members.removeKey(response.memberId, response.keyId);

      // Assert
      await one.until(() => one.closeCodes().includes(RELAY_CLOSE_CODES.authRejected));
      should(two.closeCodes()).not.containEql(RELAY_CLOSE_CODES.authRejected);
      should(rig.live.size).equal(1);
    });
  });
}
