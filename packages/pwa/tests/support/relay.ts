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

import { RELAY_SESSION_CONCLUDED_CLOSE_CODE, RELAY_SESSION_CONCLUDED_CLOSE_REASON } from '@ferretry/protocol';
import {
  answerClientHandshake,
  type ChannelState,
  concatBytes,
  type ControlMessage,
  type DaemonIdentity,
  decodeClientHello,
  decodeFrame,
  encodeControlMessage,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  HANDSHAKE_FRAME_SEQUENCE,
  HANDSHAKE_SIGNATURE_LABEL,
  handshakeTranscriptHash,
  NONCE_BYTES,
  openChannel,
  openRecord,
  RELAY_CLOSE_CODES,
  RELAY_LIMITS,
  RELAY_PROTOCOL_ID,
  sealRecord,
  type SessionId,
  sessionIdFromBytes,
  toBase64Url,
  utf8Bytes,
} from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import type { RelayCarrierSocket } from '../../src/lib/relay-carrier.ts';

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
export const testSessionId = (fill = 7): SessionId => {
  const id = sessionIdFromBytes(new Uint8Array(16).fill(fill));
  if (id === null) throw new Error('the session identifier width changed');
  return id;
};

/** The socket the session under test talks through, with everything it said kept. */
export class ScriptedSocket implements RelayCarrierSocket {
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
      protocol: RELAY_PROTOCOL_ID,
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
export interface AutoDaemonAnswer {
  readonly status?: number;
  readonly body?: string;
  /** Answer every request with §14's `oversize` refusal instead of a body. */
  readonly oversize?: boolean;
  /** Refuse the device grant, the way a daemon refuses a credential it does not know. */
  readonly rejectDevice?: boolean;
  /** The redemption response a `pair` record is answered with, embedded verbatim as §14 requires. */
  readonly paired?: unknown;
  /** Answer a `pair` record with the one generic sealed refusal instead. */
  readonly pairRefused?: boolean;
  /** Refuse a `stream` record with the status the direct upgrade would have carried. */
  readonly streamRefused?: { readonly status: number; readonly body: string };
  /** Records to push down an opened stream, in order. */
  readonly streamFrames?: readonly unknown[];
}

/**
 * A dial that plays a CORRECT daemon, automatically.
 *
 * The refusal cases are driven frame by frame elsewhere; this exists for the tests
 * above the session — the carrier router — where the session working is the premise
 * rather than the subject, and scripting six frames per case would bury it.
 */
export const autoDial = (
  identity: DaemonIdentity,
  answer: AutoDaemonAnswer = {},
): { dial: () => ScriptedSocket; sockets: ScriptedSocket[]; requests: unknown[] } => {
  const sockets: ScriptedSocket[] = [];
  const requests: unknown[] = [];
  const dial = (): ScriptedSocket => {
    const sessionId = testSessionId(sockets.length + 1);
    const daemon = new ScriptedDaemon(identity, sessionId);
    const socket = new ScriptedSocket();
    let queue: Promise<void> = Promise.resolve();
    const original = socket.send.bind(socket);
    socket.send = (bytes: Uint8Array): void => {
      original(bytes);
      queue = queue.then(async () => {
        const decoded = decodeFrame(bytes);
        if (!decoded.ok) return;
        if (decoded.frame.kind === FRAME_KINDS.handshake) {
          socket.onBinary?.(await daemon.answer(bytes));
          return;
        }
        if (decoded.frame.kind !== FRAME_KINDS.data) return;
        const message = (await daemon.receive(bytes)) as { t: string; id?: number };
        // §14's other two credential records. A daemon answers each with its own sealed outcome and
        // no other; answering them here is what lets a suite drive a pairing or a stream end to end
        // without the whole rendezvous, which the integration tier already proves.
        if (message.t === 'pair') {
          requests.push(message);
          socket.onBinary?.(
            await daemon.record(
              answer.pairRefused === true
                ? { t: 'pair-refused', protocol: RELAY_PROTOCOL_ID, reason: 'pairing_refused' }
                : { t: 'paired', protocol: RELAY_PROTOCOL_ID, response: answer.paired },
            ),
          );
          // THE CLOSE IS THE PROTOCOL'S, NOT THIS FIXTURE'S. It used to spell `4440` as a literal and
          // give it the reason `'the pairing exchange is complete'` — a sentence that told an observer
          // OUTSIDE the channel which of the two outcomes had just happened, and `d599f510` removed the
          // daemon's ability to send anything of the kind. A scripted daemon that can still produce it
          // is a fixture the shipped one cannot match: a client proved against it would be proved
          // against a frame no rendezvous will ever forward, and reading this file would suggest a
          // per-outcome reason is legal. Both constants come from the one module that owns them.
          socket.onBinary?.(
            controlFrame(sessionId, {
              t: 'closed',
              code: RELAY_SESSION_CONCLUDED_CLOSE_CODE,
              reason: RELAY_SESSION_CONCLUDED_CLOSE_REASON,
            }),
          );
          return;
        }
        if (message.t === 'stream') {
          requests.push(message);
          socket.onBinary?.(
            await daemon.record(
              answer.streamRefused === undefined
                ? { t: 'stream-opened', protocol: RELAY_PROTOCOL_ID }
                : { t: 'stream-refused', protocol: RELAY_PROTOCOL_ID, ...answer.streamRefused },
            ),
          );
          for (const frame of answer.streamFrames ?? []) socket.onBinary?.(await daemon.record(frame));
          return;
        }
        if (message.t === 'data' || message.t === 'stream-close') {
          requests.push(message);
          return;
        }
        if (message.t === 'auth') {
          if (answer.rejectDevice === true) {
            socket.onBinary?.(
              controlFrame(sessionId, {
                t: 'closed',
                code: RELAY_CLOSE_CODES.authRejected,
                reason: 'unknown device credential',
              }),
            );
            return;
          }
          socket.onBinary?.(await daemon.record({ t: 'authenticated', protocol: RELAY_PROTOCOL_ID }));
          return;
        }
        requests.push(message);
        const id = message.id ?? 1;
        const status = answer.status ?? 200;
        socket.onBinary?.(
          await daemon.record(
            answer.oversize === true
              ? { t: 'oversize', id, status, byteLength: 402_641 }
              : { t: 'res', id, status, headers: { 'content-type': 'application/json' }, body: answer.body ?? '{}' },
          ),
        );
      });
    };
    sockets.push(socket);
    // The rendezvous names the session as soon as the socket is up.
    queue = queue.then(async () => {
      await Promise.resolve();
      socket.onOpen?.();
      socket.onBinary?.(readyFrame(sessionId));
    });
    return socket;
  };
  return { dial, sockets, requests };
};

/** Let every queued frame land. Real WebCrypto resolves on the task queue, not the microtask one. */
export const settle = async (times = 40): Promise<void> => {
  for (let spin = 0; spin < times; spin += 1) await new Promise(resolve => setTimeout(resolve, 0));
};
