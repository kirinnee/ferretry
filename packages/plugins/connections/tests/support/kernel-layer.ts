/**
 * The REAL Kernel session layer for carrier tests: real WebCrypto, the real pre-credential bound and the real proof
 * check, with an in-memory device table standing in for Access. Nothing here loosens what the layer asks; it exists so
 * a carrier's admission is proved against the layer it ships with rather than against FakeSessions.
 */
import type { CarrierLink, HolderId, ModeProof, SessionMode } from '@ferretry/kernel/contract';
import { jsonResponse } from '@ferretry/kernel/contract';
import { testIdentity } from '../../../../core/kernel/testing/identity.ts';
import {
  completeClientHandshake,
  createSessionLayer,
  decodeDaemonHello,
  decodeFrame,
  deviceAuthMessage,
  encodeFrame,
  FRAME_KINDS,
  openChannel,
  SESSION_PROTOCOL_ID,
  type SessionId,
  type SessionLayerHost,
  sealRecord,
  signDeviceProof,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
  WebCryptoSessionCrypto,
} from '../../../../core/kernel/host/session/index.ts';

const sessionCrypto = new WebCryptoSessionCrypto();

/** A `device` mode over an in-memory key table. */
class MemoryDeviceMode implements SessionMode {
  readonly principalKind = 'device' as const;
  readonly keys = new Map<string, string>();
  async holder(proof: ModeProof) {
    const deviceId = (proof.body as { deviceId: string }).deviceId;
    const key = this.keys.get(deviceId);
    return key === undefined ? undefined : { holder: deviceId as HolderId, key };
  }
  watch(): () => void {
    return () => undefined;
  }
}

/** Let every pending seal, open and dispatch settle. */
export async function settle(rounds = 30): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await new Promise(resolve => setImmediate(resolve));
}

export interface RealSessionLayer {
  readonly layer: SessionLayerHost;
  readonly daemonId: string;
  /** Pairs a device with the mode, then runs hs1 → hs2 and a signed `auth` record over `link`, as a browser would. */
  proveDevice(link: CarrierLink, sessionId: SessionId): Promise<void>;
}

export async function realSessionLayer(): Promise<RealSessionLayer> {
  const identity = await testIdentity();
  const device = new MemoryDeviceMode();
  const layer = createSessionLayer({
    crypto: sessionCrypto,
    identity: identity.key,
    modes: key => (key === 'device' ? device : undefined),
    dispatch: async request => jsonResponse({ path: request.path }),
    sockets: { upgrade: async () => ({ outcome: 'unclaimed' }), reauthorize: () => true },
    // Timers never fire: no deadline, lease or renewal interferes with the admission under test.
    clock: { nowMs: () => Date.parse('2026-11-07T09:00:00.000Z'), after: () => () => undefined },
  });
  let devices = 0;
  const proveDevice = async (link: CarrierLink, sessionId: SessionId): Promise<void> => {
    devices += 1;
    const key = await sessionCrypto.generateDeviceKey();
    const deviceId = `fy_device_id_${String(devices).padEnd(22, 'x')}`;
    device.keys.set(deviceId, toBase64Url(key.publicKeySpki));
    const appSession = toBase64Url(sessionCrypto.randomBytes(16));
    const pending = await startClientHandshake(sessionCrypto, sessionId, identity.daemonId);
    link.inbound(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId,
        sequence: 0,
        payload: utf8Bytes(JSON.stringify(pending.hello)),
      }),
    );
    const hello = await nextHandshake(link);
    const daemonHello = decodeDaemonHello(hello);
    if (daemonHello === null) throw new Error('the daemon hello is unreadable');
    const done = await completeClientHandshake(sessionCrypto, pending, daemonHello);
    if (!done.ok) throw new Error(done.reason);
    const proof = await signDeviceProof(
      sessionCrypto,
      sessionCrypto.deviceKeyHandle(key.privateKey),
      deviceAuthMessage(done.keys.transcriptHash, 'auth', deviceId, appSession),
    );
    const sealed = await sealRecord(
      sessionCrypto,
      openChannel(sessionId, done.keys, 'client'),
      utf8Bytes(JSON.stringify({ t: 'auth', protocol: SESSION_PROTOCOL_ID, deviceId, appSession, proof })),
    );
    if (!sealed.ok) throw new Error(sealed.reason);
    const before = layer.report().preCredential;
    link.inbound(encodeFrame(sealed.frame));
    // The proof check is real WebCrypto: wait for the layer to say the session left the pre-credential set.
    for (let attempt = 0; attempt < 200 && layer.report().preCredential >= before; attempt += 1)
      await new Promise(resolve => setTimeout(resolve, 5));
    if (layer.report().preCredential >= before)
      throw new Error(`the device proof was not accepted: ${layer.report().lastRefusal ?? 'no refusal reported'}`);
    await settle();
  };
  return { layer, daemonId: identity.daemonId, proveDevice };
}

/** Pulls from the browser's side of `link` until the daemon's handshake frame arrives. */
async function nextHandshake(link: CarrierLink): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // The daemon's handshake answer is real WebCrypto, so a few event-loop turns are not a bound: wait real time too.
    await settle(2);
    await new Promise(resolve => setTimeout(resolve, 5));
    for (;;) {
      const next = link.outbound.next();
      if (next === undefined) break;
      if ('code' in next) throw new Error(`the session ended before the handshake: ${next.code} ${next.reason}`);
      const decoded = decodeFrame(next.bytes);
      if (decoded.ok && decoded.frame.kind === FRAME_KINDS.handshake) return decoded.frame.payload;
    }
  }
  throw new Error('the daemon never answered the handshake');
}
