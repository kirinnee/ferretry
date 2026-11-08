/**
 * The REAL kernel session layer, for Connections' carrier-boundary fixtures: real WebCrypto, a real daemon
 * identity, the kernel's own handshake, proofs and records — and the browser's half of them — so a test proves
 * what a carrier hands the kernel rather than what a fake layer pretends to do with it. Only the session modes
 * (an in-memory device table, a pair mode that records every attempt), the dispatcher and the clock are fakes.
 */

import {
  type ApiRequest,
  type ApiResponse,
  type CarrierLink,
  type HolderId,
  type HolderWatch,
  isSessionEnd,
  jsonResponse,
  type ModeProof,
  type ModeRedeemed,
  type ModeRedemption,
  type SessionEnd,
  type SessionMode,
  type SocketDownstream,
} from '@ferretry/kernel/contract';
import { session } from '@ferretry/kernel/host';

export const kernelCrypto = new session.WebCryptoSessionCrypto();

const settle = async (rounds = 30): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) await new Promise(resolve => setImmediate(resolve));
};

/** A clock the test drives: `after` timers fire only on `advance`. */
class DrivenKernelClock {
  #now = Date.parse('2026-11-07T09:00:00.000Z');
  readonly #timers = new Map<number, { at: number; fn: () => void }>();
  #next = 0;

  nowMs(): number {
    return this.#now;
  }

  after(delay: number, fn: () => void): () => void {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + delay, fn });
    return () => this.#timers.delete(id);
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

class DeviceTable implements SessionMode {
  readonly principalKind = 'device' as const;
  readonly keys = new Map<string, string>();

  async holder(proof: ModeProof): Promise<{ holder: HolderId; key: string } | undefined> {
    const deviceId = (proof.body as { deviceId: string }).deviceId;
    const key = this.keys.get(deviceId);
    return key === undefined ? undefined : { holder: deviceId as HolderId, key };
  }

  watch(_holder: HolderId, _watch: HolderWatch): () => void {
    return () => undefined;
  }
}

/** Records every attempt: a carrier that must never carry a pairing is proved by this staying empty. */
class RecordingPairMode implements SessionMode {
  readonly principalKind = 'none' as const;
  readonly attempts: ModeRedemption[] = [];

  async redeem(attempt: ModeRedemption): Promise<ModeRedeemed | 'refused'> {
    this.attempts.push(attempt);
    if (!(await attempt.prove())) return 'refused';
    return { outcome: 'paired', fields: { response: { deviceId: 'fy_device_id_new' } } };
  }
}

export interface PairedTestDevice {
  readonly deviceId: string;
  readonly appSession: string;
  readonly privateKey: CryptoKey;
}

export interface KernelFixture {
  readonly layer: session.SessionLayerHost;
  readonly clock: DrivenKernelClock;
  readonly daemonId: string;
  readonly pair: RecordingPairMode;
  readonly requests: ApiRequest[];
  /** What the kernel's dispatcher answers a carried request with. Defaults to echoing its path. */
  route: (request: ApiRequest) => Promise<ApiResponse>;
  paired(suffix?: string): Promise<PairedTestDevice>;
}

function toPem(der: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n');
}

export async function kernelFixture(): Promise<KernelFixture> {
  const pairKey = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const identity = await kernelCrypto.importDaemonIdentity(
    toPem(await crypto.subtle.exportKey('pkcs8', pairKey.privateKey)),
  );
  const devices = new DeviceTable();
  const pair = new RecordingPairMode();
  const clock = new DrivenKernelClock();
  const requests: ApiRequest[] = [];
  const fixture: KernelFixture = {
    layer: undefined as unknown as session.SessionLayerHost,
    clock,
    daemonId: identity.daemonId,
    pair,
    requests,
    route: async request => jsonResponse({ path: request.path }),
    paired: async (suffix = 'A') => {
      const key = await kernelCrypto.generateDeviceKey();
      const deviceId = `fy_device_id_${suffix.padEnd(22, 'x')}`;
      devices.keys.set(deviceId, session.toBase64Url(key.publicKeySpki));
      return {
        deviceId,
        appSession: session.toBase64Url(kernelCrypto.randomBytes(16)),
        privateKey: key.privateKey,
      };
    },
  };
  (fixture as { layer: session.SessionLayerHost }).layer = session.createSessionLayer({
    crypto: kernelCrypto,
    identity: { ...identity, sign: session.signingKey(kernelCrypto, identity).sign },
    modes: key => (key === 'device' ? devices : key === 'pair' ? pair : undefined),
    dispatch: async request => {
      requests.push(request);
      return await fixture.route(request);
    },
    sockets: { upgrade: async () => ({ outcome: 'unclaimed' }), reauthorize: () => true },
    clock: clock as never,
  });
  return fixture;
}

/**
 * The browser's end of one session: it speaks the kernel's client half of §6 over whatever the carrier gives
 * it — bytes to deliver, and bytes (or an end) it receives — and keeps every frame that crossed the wire.
 */
export class BrowserEnd {
  readonly wire: Uint8Array[] = [];
  readonly records: Record<string, unknown>[] = [];
  readonly controls: { readonly sessionId: session.SessionId; readonly message: Record<string, unknown> }[] = [];
  end: SessionEnd | undefined;
  #channel: session.ChannelState | undefined;
  #transcript: Uint8Array | undefined;
  #hello: session.SessionFrame | undefined;
  #sessionId: session.SessionId | undefined;
  #inbox: Promise<void> = Promise.resolve();

  /** The kernel link this end pulls from while it settles, when its carrier is pull-shaped (a relay, direct). */
  #link: CarrierLink | undefined;

  constructor(private readonly deliver: (bytes: Uint8Array) => void) {}

  /** Read a pull-shaped carrier: every {@link settled} pulls what the kernel has queued for this end. */
  pullFrom(link: CarrierLink): this {
    this.#link = link;
    return this;
  }

  #pull(): void {
    const link = this.#link;
    if (link === undefined || this.end !== undefined) return;
    for (let next = link.outbound.next(); next !== undefined; next = link.outbound.next()) {
      if (isSessionEnd(next)) {
        this.end = next;
        return;
      }
      this.receive(next.bytes);
    }
  }

  /** The downstream a socket-shaped carrier (a WebRTC channel, the tunnel's socket) writes to. */
  downstream(): SocketDownstream {
    return {
      send: frame => {
        if (typeof frame === 'string') return frame.length;
        this.receive(frame);
        return frame.length;
      },
      close: (code, reason) => {
        this.end ??= { code, reason };
      },
      bufferedBytes: () => 0,
    };
  }

  receive(bytes: Uint8Array): void {
    const copy = Uint8Array.from(bytes);
    this.wire.push(copy);
    this.#inbox = this.#inbox.then(async () => await this.#read(copy));
  }

  /** Let the carrier and the layer settle, and this end read everything they sent. */
  async settled(): Promise<void> {
    for (let round = 0; round < 6; round += 1) {
      await settle(4);
      this.#pull();
      await this.#inbox;
      await new Promise(resolve => setTimeout(resolve, 3));
    }
  }

  get keyed(): boolean {
    return this.#channel !== undefined;
  }

  /** hs1 → hs2 against the daemon fingerprint this end PINS. Answers whether it keyed. */
  async handshake(sessionId: session.SessionId, pinnedDaemonId: string): Promise<boolean> {
    this.#sessionId = sessionId;
    const pending = await session.startClientHandshake(kernelCrypto, sessionId, pinnedDaemonId);
    this.deliver(
      session.encodeFrame({
        kind: session.FRAME_KINDS.handshake,
        sessionId,
        sequence: 0,
        payload: session.utf8Bytes(JSON.stringify(pending.hello)),
      }),
    );
    await this.settled();
    const frame = this.#hello;
    if (frame === undefined) return false;
    const hello = session.decodeDaemonHello(frame.payload);
    if (hello === null) return false;
    const done = await session.completeClientHandshake(kernelCrypto, pending, hello);
    if (!done.ok) return false;
    this.#channel = session.openChannel(sessionId, done.keys, 'client');
    this.#transcript = done.keys.transcriptHash;
    return true;
  }

  async send(record: Record<string, unknown>): Promise<void> {
    const channel = this.#channel;
    if (channel === undefined) throw new Error('not keyed');
    const sealed = await session.sealRecord(kernelCrypto, channel, session.utf8Bytes(JSON.stringify(record)));
    if (!sealed.ok) throw new Error(sealed.reason);
    this.#channel = sealed.state;
    this.deliver(session.encodeFrame(sealed.frame));
  }

  async auth(device: PairedTestDevice): Promise<void> {
    const transcript = this.#transcript;
    if (transcript === undefined) throw new Error('not keyed');
    const proof = await session.signDeviceProof(
      kernelCrypto,
      kernelCrypto.deviceKeyHandle(device.privateKey),
      session.deviceAuthMessage(transcript, 'auth', device.deviceId, device.appSession),
    );
    await this.send({
      t: 'auth',
      protocol: session.SESSION_PROTOCOL_ID,
      deviceId: device.deviceId,
      appSession: device.appSession,
      proof,
    });
  }

  /** A well-formed first-contact pairing, its proof bound to this session's transcript. */
  async pair(): Promise<void> {
    const transcript = this.#transcript;
    if (transcript === undefined) throw new Error('not keyed');
    const key = await kernelCrypto.generateDeviceKey();
    const deviceKey = session.toBase64Url(key.publicKeySpki);
    const proof = await session.signDeviceProof(
      kernelCrypto,
      kernelCrypto.deviceKeyHandle(key.privateKey),
      session.devicePairMessage(transcript, deviceKey),
    );
    await this.send({
      t: 'pair',
      protocol: session.SESSION_PROTOCOL_ID,
      code: 'ABCD-1234',
      deviceName: 'phone',
      deviceKey,
      proof,
    });
  }

  last(t: string): Record<string, unknown> | undefined {
    return [...this.records].reverse().find(record => record.t === t);
  }

  async #read(bytes: Uint8Array): Promise<void> {
    const decoded = session.decodeFrame(bytes);
    if (!decoded.ok) throw new Error(decoded.reason);
    const frame = decoded.frame;
    if (frame.kind === session.FRAME_KINDS.control) {
      const text = session.utf8Text(frame.payload) ?? '';
      this.controls.push({ sessionId: frame.sessionId, message: JSON.parse(text) as Record<string, unknown> });
      return;
    }
    if (frame.kind === session.FRAME_KINDS.handshake) {
      this.#hello = frame;
      return;
    }
    if (frame.kind === session.FRAME_KINDS.credit) return;
    const channel = this.#channel;
    if (channel === undefined || this.#sessionId === undefined) throw new Error('record before keys');
    const opened = await session.openRecord(kernelCrypto, channel, frame);
    if (!opened.ok) throw new Error(opened.reason);
    this.#channel = opened.state;
    this.records.push(JSON.parse(session.utf8Text(opened.plaintext) ?? '') as Record<string, unknown>);
  }
}

/**
 * A HOSTILE DAEMON for the pin rows (P24, P135, R570): it answers whatever fingerprint the client hello asks for with
 * a daemon hello correctly signed by ITS OWN identity — the kernel's real `answerClientHandshake`, handed a signing key
 * that claims the requested id. An honest kernel refuses such a hello before presenting anything, so only this reaches
 * the browser's own fingerprint check (today's `ScriptedDaemon.spoof`, relay-session.test.ts). Answers the reply frame
 * to one client handshake frame, or `undefined` for any other frame.
 */
export async function impostorDaemon(): Promise<{
  readonly daemonId: string;
  answer(bytes: Uint8Array): Promise<Uint8Array | undefined>;
}> {
  const key = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const identity = await kernelCrypto.importDaemonIdentity(
    toPem(await crypto.subtle.exportKey('pkcs8', key.privateKey)),
  );
  const signer = session.signingKey(kernelCrypto, identity);
  return {
    daemonId: identity.daemonId,
    answer: async bytes => {
      const decoded = session.decodeFrame(bytes);
      if (!decoded.ok || decoded.frame.kind !== session.FRAME_KINDS.handshake) return undefined;
      const hello = session.decodeClientHello(decoded.frame.payload);
      if (hello === null) return undefined;
      const spoofed = { ...signer, daemonId: hello.daemonId };
      const answered = await session.answerClientHandshake(kernelCrypto, spoofed, decoded.frame.sessionId, hello);
      if (!answered.ok) return undefined;
      return session.encodeFrame({
        kind: session.FRAME_KINDS.handshake,
        sessionId: decoded.frame.sessionId,
        sequence: session.HANDSHAKE_FRAME_SEQUENCE,
        payload: session.encodeHandshakeMessage(answered.hello),
      });
    },
  };
}
