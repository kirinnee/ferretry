/**
 * A test client for the session layer: the browser's half of the handshake and the records, over real
 * WebCrypto, plus fake modes, a fake clock and fake route tables. Nothing here loosens what the layer asks.
 */

import type { ApiRequest, ApiResponse } from '../../../contract/http.ts';
import { jsonResponse } from '../../../contract/http.ts';
import type { CarrierKey, HolderId } from '../../../contract/ids.ts';
import type {
  CarrierLink,
  CarrierConnection,
  CarrierPeer,
  HolderWatch,
  ModeProof,
  ModeRedeemed,
  ModeRedemption,
  SessionEnd,
  SessionMode,
} from '../../../contract/session.ts';
import { isSessionEnd } from '../../../contract/session.ts';
import type { SocketUpgradeDecision } from '../../../contract/socket.ts';
import type { Duration } from '@ferretry/std';
import {
  type AccessLeasePolicy,
  type ChannelState,
  completeClientHandshake,
  createSessionLayer,
  decodeCreditPayload,
  decodeDaemonHello,
  decodeFrame,
  deviceAuthMessage,
  deviceRenewMessage,
  encodeCreditPayload,
  encodeFrame,
  FRAME_KINDS,
  openChannel,
  openRecord,
  SESSION_PROTOCOL_ID,
  type SessionFrame,
  type SessionCrypto,
  type SessionId,
  type SessionLayerHost,
  sealRecord,
  sessionIdFromBytes,
  signDeviceProof,
  startClientHandshake,
  type StreamDispatch,
  toBase64Url,
  utf8Bytes,
  utf8Text,
} from '../../../host/session/index.ts';
import { newDaemonIdentity, relayCrypto } from './identities.ts';

/** A clock the test drives: `after` timers fire only on `advance`. */
class FakeClock {
  #now = Date.parse('2026-11-07T09:00:00.000Z');
  readonly #timers = new Map<number, { at: number; fn: () => void }>();
  #next = 0;

  nowMs(): number {
    return this.#now;
  }

  after(delay: Duration, fn: () => void): () => void {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + delay, fn });
    return () => this.#timers.delete(id);
  }

  /** Moves the clock WITHOUT firing anything: a timer that fires late (R245). */
  skew(ms: number): void {
    this.#now += ms;
  }

  advance(ms: number): void {
    this.#now += ms;
    for (const [id, timer] of [...this.#timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.#now || !this.#timers.has(id)) continue;
      this.#timers.delete(id);
      timer.fn();
    }
  }
}

/** A `device` mode over an in-memory key table. */
export class FakeDeviceMode implements SessionMode {
  readonly principalKind = 'device' as const;
  readonly keys = new Map<string, string>();
  readonly watches = new Map<string, HolderWatch[]>();
  readonly seenHolders: string[] = [];
  asked = 0;

  async holder(proof: ModeProof): Promise<{ holder: HolderId; key: string } | undefined> {
    this.asked += 1;
    const deviceId = (proof.body as { deviceId: string }).deviceId;
    const key = this.keys.get(deviceId);
    return key === undefined ? undefined : { holder: deviceId as HolderId, key };
  }

  watch(holder: HolderId, watch: HolderWatch): () => void {
    const list = this.watches.get(holder) ?? [];
    list.push(watch);
    this.watches.set(holder, list);
    return () =>
      this.watches.set(
        holder,
        (this.watches.get(holder) ?? []).filter(item => item !== watch),
      );
  }

  seen(holder: HolderId): void {
    this.seenHolders.push(holder);
  }
}

/** A `pair` mode that records every attempt and runs the kernel's proof check. */
class FakePairMode implements SessionMode {
  readonly principalKind = 'none' as const;
  readonly attempts: ModeRedemption[] = [];
  answer: 'paired' | 'refused' = 'paired';

  async redeem(attempt: ModeRedemption): Promise<ModeRedeemed | 'refused'> {
    this.attempts.push(attempt);
    if (!(await attempt.prove())) return 'refused';
    return this.answer === 'paired'
      ? { outcome: 'paired', fields: { response: { deviceId: 'fy_device_id_new' } } }
      : 'refused';
  }
}

export interface Fixture {
  readonly layer: SessionLayerHost;
  readonly clock: FakeClock;
  readonly device: FakeDeviceMode;
  readonly pair: FakePairMode;
  readonly daemonId: string;
  readonly requests: ApiRequest[];
  readonly streams: ApiRequest[];
  dispatch: (request: ApiRequest) => Promise<ApiResponse>;
  sockets: StreamDispatch;
  modesOff: Set<string>;
}

export async function fixture(options: { lease?: AccessLeasePolicy; crypto?: SessionCrypto } = {}): Promise<Fixture> {
  const identity = await newDaemonIdentity();
  const clock = new FakeClock();
  const device = new FakeDeviceMode();
  const pair = new FakePairMode();
  const requests: ApiRequest[] = [];
  const streams: ApiRequest[] = [];
  const state: Fixture = {
    layer: undefined as unknown as SessionLayerHost,
    clock,
    device,
    pair,
    daemonId: identity.daemonId,
    requests,
    streams,
    dispatch: async request => {
      requests.push(request);
      return jsonResponse({ path: request.path });
    },
    sockets: {
      upgrade: async request => {
        streams.push(request);
        return { outcome: 'unclaimed' } satisfies SocketUpgradeDecision;
      },
      reauthorize: () => true,
    },
    modesOff: new Set(),
  };
  const layer = createSessionLayer({
    crypto: options.crypto ?? relayCrypto,
    identity,
    modes: key => {
      if (state.modesOff.has(key)) return undefined;
      return key === 'device' ? device : key === 'pair' ? pair : undefined;
    },
    dispatch: request => state.dispatch(request),
    sockets: {
      upgrade: request => state.sockets.upgrade(request),
      reauthorize: request => state.sockets.reauthorize(request),
    },
    clock,
    ...(options.lease === undefined ? {} : { lease: options.lease }),
  });
  (state as { layer: SessionLayerHost }).layer = layer;
  return state;
}

/** Let every pending seal, open and dispatch settle. */
export async function settle(rounds = 30): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await new Promise(resolve => setImmediate(resolve));
}

function freshSessionId(): SessionId {
  const id = sessionIdFromBytes(relayCrypto.randomBytes(16));
  if (id === null) throw new Error('fixture session id');
  return id;
}

/** A paired device: its id, its key pair, registered with the fake mode. */
export interface TestDevice {
  readonly deviceId: string;
  readonly appSession: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: string;
}

export async function pairedDevice(mode: FakeDeviceMode, suffix = 'A'): Promise<TestDevice> {
  const key = await relayCrypto.generateDeviceKey();
  const deviceId = `fy_device_id_${suffix.padEnd(22, 'x')}`;
  const publicKey = toBase64Url(key.publicKeySpki);
  mode.keys.set(deviceId, publicKey);
  return { deviceId, appSession: toBase64Url(relayCrypto.randomBytes(16)), privateKey: key.privateKey, publicKey };
}

/** The browser's end of one session, over one {@link CarrierLink}. */
export class TestClient {
  readonly records: Record<string, unknown>[] = [];
  readonly wire: Uint8Array[] = [];
  end: SessionEnd | undefined;
  channel: ChannelState | undefined;
  transcript: Uint8Array | undefined;
  creditReceived = 0;
  handshakeSequence: number | undefined;
  readonly sequences: number[] = [];

  constructor(
    readonly link: CarrierLink,
    readonly sessionId: SessionId,
  ) {}

  static open(fx: Fixture, carrier = 'relay', peer?: CarrierPeer): TestClient {
    return new TestClient(fx.layer.open(carrier as CarrierKey, peer), freshSessionId());
  }

  /** A session on a shared connection (one rendezvous socket carrying many sessions). */
  static on(connection: CarrierConnection, peer?: CarrierPeer): TestClient {
    return new TestClient(connection.open(peer), freshSessionId());
  }

  /** hs1 → hs2, keyed. */
  async handshake(
    daemonId: string,
    hello?: (hello: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const pending = await startClientHandshake(relayCrypto, this.sessionId, daemonId);
    const sent = hello === undefined ? pending.hello : hello({ ...pending.hello });
    this.link.inbound(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId: this.sessionId,
        sequence: 0,
        payload: utf8Bytes(JSON.stringify(sent)),
      }),
    );
    await this.pump();
    const frame = this.#handshakeFrame;
    if (frame === undefined) return;
    const daemonHello = decodeDaemonHello(frame.payload);
    if (daemonHello === null) throw new Error('daemon hello unreadable');
    const done = await completeClientHandshake(relayCrypto, pending, daemonHello);
    if (!done.ok) throw new Error(done.reason);
    this.channel = openChannel(this.sessionId, done.keys, 'client');
    this.transcript = done.keys.transcriptHash;
  }

  #handshakeFrame: SessionFrame | undefined;

  /** Seal and deliver one record. */
  async send(record: unknown): Promise<void> {
    await this.sendBytes(utf8Bytes(typeof record === 'string' ? record : JSON.stringify(record)));
  }

  async sendBytes(plaintext: Uint8Array): Promise<SessionFrame> {
    const channel = this.channel;
    if (channel === undefined) throw new Error('not keyed');
    const sealed = await sealRecord(relayCrypto, channel, plaintext);
    if (!sealed.ok) throw new Error(sealed.reason);
    this.channel = sealed.state;
    this.link.inbound(encodeFrame(sealed.frame));
    return sealed.frame;
  }

  /** Deliver raw bytes as one frame. */
  raw(bytes: Uint8Array): void {
    this.link.inbound(bytes);
  }

  /** Give the daemon more credit. */
  credit(frames: number): void {
    this.link.inbound(
      encodeFrame({
        kind: FRAME_KINDS.credit,
        sessionId: this.sessionId,
        sequence: 0,
        payload: encodeCreditPayload(frames),
      }),
    );
  }

  async auth(
    device: TestDevice,
    overrides: Record<string, unknown> = {},
    kind: 'auth' | 'stream' = 'auth',
  ): Promise<void> {
    const transcript = this.transcript;
    if (transcript === undefined) throw new Error('not keyed');
    const proof = await signDeviceProof(
      relayCrypto,
      relayCrypto.deviceKeyHandle(device.privateKey),
      deviceAuthMessage(transcript, kind, device.deviceId, device.appSession),
    );
    await this.send({
      t: kind,
      protocol: SESSION_PROTOCOL_ID,
      deviceId: device.deviceId,
      appSession: device.appSession,
      proof,
      ...overrides,
    });
    await this.pump();
  }

  async renew(device: TestDevice, nonce: string): Promise<void> {
    const transcript = this.transcript;
    if (transcript === undefined) throw new Error('not keyed');
    const proof = await signDeviceProof(
      relayCrypto,
      relayCrypto.deviceKeyHandle(device.privateKey),
      deviceRenewMessage(transcript, nonce),
    );
    await this.send({ t: 'renewed', protocol: SESSION_PROTOCOL_ID, proof });
    await this.pump();
  }

  /** Pull everything the daemon has, opening records, until it has nothing more. */
  async pump(): Promise<void> {
    let idle = 0;
    while (idle < 8) {
      await settle(2);
      let pulled = false;
      for (;;) {
        const next = this.link.outbound.next();
        if (next === undefined) break;
        if (isSessionEnd(next)) {
          this.end = next;
          return;
        }
        pulled = true;
        this.wire.push(next.bytes);
        this.sequences.push(next.sequence);
        await this.#receive(next.bytes);
      }
      if (pulled) idle = 0;
      else {
        idle += 1;
        await new Promise(resolve => setTimeout(resolve, 3));
      }
    }
  }

  async #receive(bytes: Uint8Array): Promise<void> {
    const decoded = decodeFrame(bytes);
    if (!decoded.ok) throw new Error(decoded.reason);
    const frame = decoded.frame;
    if (frame.kind === FRAME_KINDS.handshake) {
      this.#handshakeFrame = frame;
      this.handshakeSequence = frame.sequence;
      return;
    }
    if (frame.kind === FRAME_KINDS.credit) {
      this.creditReceived += decodeCreditPayload(frame.payload) ?? 0;
      return;
    }
    const channel = this.channel;
    if (channel === undefined) throw new Error('record before keys');
    const opened = await openRecord(relayCrypto, channel, frame);
    if (!opened.ok) throw new Error(opened.reason);
    this.channel = opened.state;
    const text = utf8Text(opened.plaintext) ?? '';
    this.records.push(JSON.parse(text) as Record<string, unknown>);
  }

  last(t: string): Record<string, unknown> | undefined {
    return [...this.records].reverse().find(record => record['t'] === t);
  }
}

/** A keyed, authenticated request session. */
export async function serving(
  fx: Fixture,
  carrier = 'relay',
  peer?: CarrierPeer,
): Promise<{ client: TestClient; device: TestDevice }> {
  const device = await pairedDevice(fx.device);
  const client = TestClient.open(fx, carrier, peer);
  await client.handshake(fx.daemonId);
  await client.auth(device);
  return { client, device };
}
