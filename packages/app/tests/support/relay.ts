/**
 * A rendezvous and a daemon, scripted frame by frame.
 *
 * The end-to-end test drives the REAL rendezvous and the REAL daemon link, which is
 * what proves interoperability. This is the opposite tool and both are needed: here
 * every frame is placed by hand, so the refusals — a forged record, a sequence that
 * is not the next one, an answer to a request nobody sent — can be produced exactly.
 * A carrier that always behaves correctly cannot prove what happens when one does
 * not.
 *
 * Everything cryptographic is still real. The primitives are never faked, because a
 * refusal proved against a fake signature is a refusal proved against nothing.
 */

import type { SessionDeviceClaim } from '../../src/session/session-client.ts';
import { WebCryptoRelayCrypto } from '../../src/session/webcrypto.ts';
import {
  answerClientHandshake,
  type ChannelState,
  concatBytes,
  type DaemonIdentity,
  decodeClientHello,
  decodeFrame,
  deviceAuthMessage,
  devicePairMessage,
  deviceRenewMessage,
  deviceRotateMessage,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  HANDSHAKE_FRAME_SEQUENCE,
  HANDSHAKE_SIGNATURE_LABEL,
  handshakeTranscriptHash,
  memberAuthMessage,
  memberJoinMessage,
  memberJoinOptionsMessage,
  memberRenewMessage,
  NONCE_BYTES,
  openChannel,
  openRecord,
  RELAY_PROTOCOL_ID,
  type RelayLimits,
  SESSION_PROTOCOL_ID,
  type SessionId,
  sealRecord,
  sessionIdFromBytes,
  toBase64Url,
  utf8Bytes,
  verifyDeviceProof,
} from '../../src/session/wire/index.ts';
import { CREDIT_WINDOW_FRAMES, HEARTBEAT_SECONDS, MAX_FRAME_BYTES, MAX_SESSIONS_PER_RENDEZVOUS } from '../../src/session/wire/index.ts';

/** The limits a rendezvous publishes (the daemon-role constant, rebuilt here for the scripted rendezvous). */
export const RELAY_LIMITS: RelayLimits = {
  maxFrameBytes: MAX_FRAME_BYTES,
  creditWindowFrames: CREDIT_WINDOW_FRAMES,
  maxSessions: MAX_SESSIONS_PER_RENDEZVOUS,
  heartbeatSeconds: HEARTBEAT_SECONDS,
};

/** A control message as a scripted rendezvous sends it (the client parses; this side only encodes). */
export type ControlMessage = Readonly<Record<string, unknown>> & { readonly t: string };
const encodeControlMessage = (message: ControlMessage): Uint8Array => utf8Bytes(JSON.stringify(message));


/** One adapter for every test, because the protocol is only ever proved against real primitives. */
export const relayCrypto = new WebCryptoRelayCrypto();

/** A daemon identity, minted the way a daemon mints the one it stores at install. */
export async function newDaemonIdentity(): Promise<DaemonIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return await relayCrypto.importDaemonIdentity(
    ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n'),
  );
}

/** A fixed session identifier, so a transcript is reproducible across a run. */
/**
 * A device key minted exactly as a browser mints one at pairing — non-extractable, real Ed25519 — and
 * the claim a session presents with it. The public half is returned so a scripted daemon can check the
 * proof the session signed, which is the only way a fixture can tell a real proof from a plausible one.
 */
export async function testDevice(deviceId = 'fy_dev_test'): Promise<{
  readonly claim: SessionDeviceClaim;
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
}> {
  const minted = await relayCrypto.generateDeviceKey();
  return {
    claim: {
      deviceId,
      key: relayCrypto.deviceKeyHandle(minted.privateKey),
      appSession: toBase64Url(new Uint8Array(16).fill(5)),
    },
    publicKey: toBase64Url(minted.publicKeySpki),
    privateKey: minted.privateKey,
  };
}

/** When a scripted acceptance says the access lease ends: far enough away that no suite reaches it. */
export const LEASE_ENDS = '2099-01-01T00:00:00.000Z';

export const testSessionId = (fill = 7): SessionId => {
  const id = sessionIdFromBytes(new Uint8Array(16).fill(fill));
  if (id === null) throw new Error('the session identifier width changed');
  return id;
};

/** The socket the session under test talks through, with everything it said kept. */
export class ScriptedSocket {
  onOpen: (() => void) | null = null;
  onText: ((text: string) => void) | null = null;
  onBinary: ((bytes: Uint8Array) => void) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  readonly texts: string[] = [];
  closed: { code: number; reason: string } | null = null;

  send(bytes: Uint8Array): void {
    this.sent.push(Uint8Array.from(bytes));
  }

  sendText(text: string): void {
    this.texts.push(text);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

export const controlFrame = (sessionId: SessionId, message: ControlMessage): Uint8Array =>
  encodeFrame({ kind: FRAME_KINDS.control, sessionId, sequence: 0, payload: encodeControlMessage(message) });

export const readyFrame = (sessionId: SessionId): Uint8Array =>
  controlFrame(sessionId, { t: 'ready', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS });

export const creditFrame = (sessionId: SessionId, payload: Uint8Array): Uint8Array =>
  encodeFrame({ kind: FRAME_KINDS.credit, sessionId, sequence: 0, payload });

/**
 * The daemon's side of one session, as the two things a test needs from it.
 *
 * `answer` produces the `hs2` frame for whatever hello the session sent; `record`
 * seals one JSON message under the daemon-to-client key at the next sequence number.
 * The channel is kept here so a test can deliberately go out of order.
 */
export class ScriptedDaemon {
  #channel: ChannelState | undefined;
  #transcript: Uint8Array | undefined;

  constructor(
    readonly identity: DaemonIdentity,
    readonly sessionId: SessionId,
  ) {}

  /** Answer the hello the session under test just sent, and key this side's channel. */
  async answer(helloFrame: Uint8Array): Promise<Uint8Array> {
    const decoded = decodeClientHello(helloFrame.subarray(28));
    if (decoded === null) throw new Error('the session did not send a client hello');
    const answered = await answerClientHandshake(relayCrypto, this.identity, this.sessionId, decoded);
    if (!answered.ok) throw new Error(answered.reason);
    this.#channel = openChannel(this.sessionId, answered.keys, 'daemon');
    this.#transcript = answered.keys.transcriptHash;
    return encodeFrame({
      kind: FRAME_KINDS.handshake,
      sessionId: this.sessionId,
      sequence: HANDSHAKE_FRAME_SEQUENCE,
      payload: encodeHandshakeMessage(answered.hello),
    });
  }

  /**
   * Answer a hello addressed to SOMEBODY ELSE, signed correctly by this key.
   *
   * A carrier that misroutes a session produces exactly this, and it is the one case
   * the fingerprint check exists for — so it cannot go through
   * `answerClientHandshake`, which refuses a hello naming another daemon and would
   * therefore prove the daemon's check rather than the browser's. The transcript is
   * built by hand from the same helper both real ends use, so the signature here is
   * genuinely valid: what the browser catches is the KEY, not a bad signature.
   */
  async spoof(helloFrame: Uint8Array): Promise<Uint8Array> {
    const hello = decodeClientHello(helloFrame.subarray(28));
    if (hello === null) throw new Error('the session did not send a client hello');
    const ephemeral = await relayCrypto.generateEphemeralKeyPair();
    const unsigned = {
      t: 'hs2',
      protocol: SESSION_PROTOCOL_ID,
      epk: toBase64Url(ephemeral.publicKey),
      nonce: toBase64Url(relayCrypto.randomBytes(NONCE_BYTES)),
      spki: toBase64Url(this.identity.publicKeySpki),
    } as const;
    const transcript = await handshakeTranscriptHash(relayCrypto, this.sessionId, hello, unsigned);
    const signature = await relayCrypto.signEd25519(
      this.identity.privateKey,
      concatBytes([utf8Bytes(HANDSHAKE_SIGNATURE_LABEL), new Uint8Array([0]), transcript]),
    );
    return encodeFrame({
      kind: FRAME_KINDS.handshake,
      sessionId: this.sessionId,
      sequence: HANDSHAKE_FRAME_SEQUENCE,
      payload: encodeHandshakeMessage({ ...unsigned, sig: toBase64Url(signature) }),
    });
  }

  /**
   * Whether a credential or renewal record carries a valid proof by `publicKey` over THIS session.
   *
   * The daemon's own check, run with the same message builders, so a client that signed the wrong
   * transcript, the wrong kind or the wrong identifiers is caught here rather than only end to end.
   */
  async proves(
    record: Readonly<Record<string, unknown>>,
    publicKey: string,
    nonce?: string,
    act: 'device' | 'member' = 'device',
  ): Promise<boolean> {
    const transcript = this.#transcript;
    if (transcript === undefined) throw new Error('this daemon has not keyed a channel');
    const proof = String(record.proof);
    const message =
      record.t === 'join'
        ? memberJoinMessage(transcript, String(record.memberKey), String(record.boxKey))
        : record.t === 'join-options'
          ? memberJoinOptionsMessage(transcript, String(record.memberKey), String(record.origin))
          : record.t === 'member'
            ? memberAuthMessage(transcript, String(record.keyId), String(record.appSession))
            : record.t === 'pair'
              ? devicePairMessage(transcript, String(record.deviceKey))
              : record.t === 'renewed'
                ? act === 'member'
                  ? memberRenewMessage(transcript, String(nonce))
                  : deviceRenewMessage(transcript, String(nonce))
                : deviceAuthMessage(
                    transcript,
                    record.t === 'stream' ? 'stream' : 'auth',
                    String(record.deviceId),
                    String(record.appSession),
                  );
    return await verifyDeviceProof(relayCrypto, publicKey, proof, message);
  }

  /** Whether `rotation` is its own key's signature over THIS session's rotate message for `deviceId`. */
  async provesRotation(
    rotation: { readonly deviceKey: string; readonly proof: string },
    deviceId: string,
  ): Promise<boolean> {
    const transcript = this.#transcript;
    if (transcript === undefined) throw new Error('this daemon has not keyed a channel');
    return await verifyDeviceProof(
      relayCrypto,
      rotation.deviceKey,
      rotation.proof,
      deviceRotateMessage(transcript, deviceId, rotation.deviceKey),
    );
  }

  /** Seal one tunnel message. `text` is sent verbatim so a malformed record is possible. */
  async record(message: unknown, text?: string): Promise<Uint8Array> {
    const channel = this.#channel;
    if (channel === undefined) throw new Error('this daemon has not keyed a channel');
    const sealed = await sealRecord(relayCrypto, channel, utf8Bytes(text ?? JSON.stringify(message)));
    if (!sealed.ok) throw new Error(sealed.reason);
    this.#channel = sealed.state;
    return encodeFrame(sealed.frame);
  }

  /** Seal raw bytes, for a record whose plaintext is not valid UTF-8. */
  async rawRecord(plaintext: Uint8Array): Promise<Uint8Array> {
    const channel = this.#channel;
    if (channel === undefined) throw new Error('this daemon has not keyed a channel');
    const sealed = await sealRecord(relayCrypto, channel, plaintext);
    if (!sealed.ok) throw new Error(sealed.reason);
    this.#channel = sealed.state;
    return encodeFrame(sealed.frame);
  }

  /** Open one record the client sent, so a scripted daemon can answer what it was asked. */
  async receive(frame: Uint8Array): Promise<unknown> {
    const channel = this.#channel;
    if (channel === undefined) throw new Error('this daemon has not keyed a channel');
    const decoded = decodeFrame(frame);
    if (!decoded.ok) throw new Error(decoded.reason);
    const opened = await openRecord(relayCrypto, channel, decoded.frame);
    if (!opened.ok) throw new Error(opened.reason);
    this.#channel = opened.state;
    return JSON.parse(new TextDecoder().decode(opened.plaintext));
  }
}

/** How a scripted daemon answers whatever it is asked. */
/** Let every queued frame land. Real WebCrypto resolves on the task queue, not the microtask one. */
export const settle = async (times = 40): Promise<void> => {
  for (let spin = 0; spin < times; spin += 1) await new Promise(resolve => setTimeout(resolve, 0));
};
