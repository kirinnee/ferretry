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

import {
  OLDER_APP_SENTENCE,
  RELAY_SESSION_CONCLUDED_CLOSE_CODE,
  RELAY_SESSION_CONCLUDED_CLOSE_REASON,
} from '@ferretry/protocol';
import {
  answerClientHandshake,
  type ChannelState,
  type ControlMessage,
  concatBytes,
  type DaemonIdentity,
  decodeClientHello,
  decodeFrame,
  deviceAuthMessage,
  devicePairMessage,
  deviceRenewMessage,
  deviceRotateMessage,
  encodeControlMessage,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  HANDSHAKE_FRAME_SEQUENCE,
  HANDSHAKE_SIGNATURE_LABEL,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  handshakeTranscriptHash,
  type MemberJoinOutcomeContent,
  memberAuthMessage,
  memberJoinMessage,
  memberRenewMessage,
  NONCE_BYTES,
  openChannel,
  openRecord,
  padJoinOutcome,
  RELAY_CLOSE_CODES,
  RELAY_LIMITS,
  RELAY_PROTOCOL_ID,
  SESSION_PROTOCOL_ID,
  type SessionId,
  sealRecord,
  sessionIdFromBytes,
  toBase64Url,
  utf8Bytes,
  verifyDeviceProof,
} from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import { type CarrierPreference, CarrierPreferenceStore } from '../../src/lib/carrier-preference.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { RelayCarrierSocket } from '../../src/lib/relay-carrier.ts';
import type { SessionDeviceClaim } from '../../src/lib/relay-session.ts';
import { MemoryDeviceKeyStore } from './device-keys.ts';

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
export interface AutoDaemonAnswer {
  readonly status?: number;
  readonly body?: string;
  /** Answer every request with this body split across `res` + `res-more` parts, in this order. */
  readonly parts?: readonly string[];
  /** When set, every credential record's proof is checked against this public key and refused if wrong. */
  readonly devicePublicKey?: string;
  /** Refuse the device grant, the way a daemon refuses a credential it does not know. */
  readonly rejectDevice?: boolean;
  /** The redemption response a `pair` record is answered with, embedded verbatim as §14 requires. */
  readonly paired?: unknown;
  /** Answer a `pair` record with the one generic sealed refusal instead. */
  readonly pairRefused?: boolean;
  /** Take a `pair` record and never answer it: a daemon that may have redeemed the code, unheard. */
  readonly pairSilently?: boolean;
  /** The `joined` response a `join` record is answered with (a `MemberJoinedResponse`), padded as the daemon pads it. */
  readonly joined?: unknown;
  /** Answer a `join` record with the one generic sealed refusal instead. */
  readonly joinRefused?: boolean;
  /** Take a `join` record and never answer it: the share may have been spent, unheard. */
  readonly joinSilently?: boolean;
  /** When set, every `member` record's proof is checked against this public key and refused if wrong. */
  readonly memberPublicKey?: string;
  /** Refuse a member key with `4403`, as a daemon refuses a key it does not hold. */
  readonly rejectMember?: boolean;
  /** Refuse a `stream` record with the status the direct upgrade would have carried. */
  readonly streamRefused?: { readonly status: number; readonly body: string };
  /** Records to push down an opened stream, in order. */
  readonly streamFrames?: readonly unknown[];
  /**
   * End the session instead of answering the request numbered `index` (from 0, across every socket
   * this dial made) — a lease that ran out, or a carrier that died after the request left.
   */
  readonly closeOnRequest?: (index: number) => { readonly code: number; readonly reason: string } | undefined;
  /** Answer each request by what it asked for, the way a real daemon's route table would. */
  readonly respond?: (request: ScriptedRequest) => ScriptedAnswer | Promise<ScriptedAnswer>;
  /** Answers every `fy-ping` with `fy-pong`, as the rendezvous auto-responder does, so a session outlives its keepalive. */
  readonly answersHeartbeats?: boolean;
}

/** One `req` as a scripted daemon reads it. */
interface ScriptedRequest {
  readonly method: string;
  readonly path: string;
  readonly query?: readonly (readonly [string, string])[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** What a scripted route answers: a status and a body, JSON-encoded unless it is already a string. */
interface ScriptedAnswer {
  readonly status?: number;
  readonly body?: unknown;
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
    if (answer.answersHeartbeats === true) {
      const text = socket.sendText.bind(socket);
      socket.sendText = (sent: string): void => {
        text(sent);
        if (sent === HEARTBEAT_REQUEST) queueMicrotask(() => socket.onText?.(HEARTBEAT_RESPONSE));
      };
    }
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
        const refuseUnproven = async (): Promise<boolean> => {
          if (answer.devicePublicKey === undefined) return false;
          if (await daemon.proves(message, answer.devicePublicKey)) return false;
          socket.onBinary?.(
            controlFrame(sessionId, {
              t: 'closed',
              code: RELAY_CLOSE_CODES.authRejected,
              reason: 'device proof refused',
            }),
          );
          return true;
        };
        // §14's other two credential records. A daemon answers each with its own sealed outcome and
        // no other; answering them here is what lets a suite drive a pairing or a stream end to end
        // without the whole rendezvous, which the integration tier already proves.
        if (message.t === 'pair') {
          requests.push(message);
          if (await refuseUnproven()) return;
          if (answer.pairSilently === true) return;
          socket.onBinary?.(
            await daemon.record(
              answer.pairRefused === true
                ? { t: 'pair-refused', protocol: SESSION_PROTOCOL_ID, reason: 'pairing_refused' }
                : { t: 'paired', protocol: SESSION_PROTOCOL_ID, response: answer.paired },
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
        if (message.t === 'join') {
          requests.push(message);
          if (answer.joinSilently === true) return;
          const outcome =
            answer.joinRefused === true
              ? ({ t: 'join-refused', protocol: SESSION_PROTOCOL_ID, reason: 'join_refused' } as const)
              : ({ t: 'joined', protocol: SESSION_PROTOCOL_ID, response: answer.joined } as const);
          // The same padding the daemon applies, so the size of the record says nothing about which it is.
          const padded = padJoinOutcome(outcome as unknown as MemberJoinOutcomeContent);
          socket.onBinary?.(await daemon.record(outcome, padded ?? undefined));
          socket.onBinary?.(
            controlFrame(sessionId, {
              t: 'closed',
              code: RELAY_SESSION_CONCLUDED_CLOSE_CODE,
              reason: RELAY_SESSION_CONCLUDED_CLOSE_REASON,
            }),
          );
          return;
        }
        if (message.t === 'member') {
          if (answer.memberPublicKey !== undefined && !(await daemon.proves(message, answer.memberPublicKey))) {
            socket.onBinary?.(
              controlFrame(sessionId, {
                t: 'closed',
                code: RELAY_CLOSE_CODES.authRejected,
                reason: 'unknown device credential',
              }),
            );
            return;
          }
          if (answer.rejectMember === true) {
            socket.onBinary?.(
              controlFrame(sessionId, {
                t: 'closed',
                code: RELAY_CLOSE_CODES.authRejected,
                reason: 'unknown device credential',
              }),
            );
            return;
          }
          socket.onBinary?.(
            await daemon.record({ t: 'authenticated', protocol: SESSION_PROTOCOL_ID, accessExpiresAt: LEASE_ENDS }),
          );
          return;
        }
        if (message.t === 'stream') {
          requests.push(message);
          if (await refuseUnproven()) return;
          socket.onBinary?.(
            await daemon.record(
              answer.streamRefused === undefined
                ? { t: 'stream-opened', protocol: SESSION_PROTOCOL_ID, accessExpiresAt: LEASE_ENDS }
                : { t: 'stream-refused', protocol: SESSION_PROTOCOL_ID, ...answer.streamRefused },
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
          if (await refuseUnproven()) return;
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
          socket.onBinary?.(
            await daemon.record({ t: 'authenticated', protocol: SESSION_PROTOCOL_ID, accessExpiresAt: LEASE_ENDS }),
          );
          return;
        }
        const ended = answer.closeOnRequest?.(requests.length);
        requests.push(message);
        if (ended !== undefined) {
          socket.onBinary?.(controlFrame(sessionId, { t: 'closed', ...ended }));
          return;
        }
        const id = message.id ?? 1;
        if (answer.respond !== undefined) {
          let routed: ScriptedAnswer;
          try {
            routed = await answer.respond(message as unknown as ScriptedRequest);
          } catch (reason) {
            // A route that THROWS is a carrier that died under the request, not a daemon that answered:
            // the socket goes, exactly as a dropped connection would take it.
            socket.onClose?.(1006, reason instanceof Error ? reason.message : String(reason));
            return;
          }
          const body = typeof routed.body === 'string' ? routed.body : JSON.stringify(routed.body ?? {});
          socket.onBinary?.(
            await daemon.record({
              t: 'res',
              id,
              status: routed.status ?? 200,
              headers: { 'content-type': 'application/json' },
              body,
            }),
          );
          return;
        }
        const status = answer.status ?? 200;
        const parts = answer.parts;
        if (parts !== undefined && parts.length > 1) {
          const headers = { 'content-type': 'application/json' };
          socket.onBinary?.(await daemon.record({ t: 'res', id, status, headers, body: parts[0], more: true }));
          for (const [index, body] of parts.slice(1).entries()) {
            const last = index === parts.length - 2;
            socket.onBinary?.(await daemon.record({ t: 'res-more', id, body, ...(last ? {} : { more: true }) }));
          }
          return;
        }
        socket.onBinary?.(
          await daemon.record({
            t: 'res',
            id,
            status,
            headers: { 'content-type': 'application/json' },
            body: answer.body ?? '{}',
          }),
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

/** One scripted daemon per address, chosen by the host the browser dialled; every other host refuses. */
export const dialByHost = (routes: Readonly<Record<string, () => ScriptedSocket>>) => {
  const dialled: string[] = [];
  const dial = (url: string): ScriptedSocket => {
    dialled.push(url);
    const route = routes[new URL(url).hostname];
    if (route !== undefined) return route();
    const refused = new ScriptedSocket();
    queueMicrotask(() => refused.onClose?.(1006, 'the address did not answer'));
    return refused;
  };
  return { dial, dialled };
};

/** A daemon this browser is paired with: a real identity, and the device key held for it. */
export const keyedDaemon = async (baseUrl: string, carriers?: Parameters<typeof daemonConnection>[0]['carriers']) => {
  const identity = await newDaemonIdentity();
  const device = await testDevice();
  const deviceKeys = new MemoryDeviceKeyStore();
  await deviceKeys.save(identity.daemonId, device.privateKey);
  const daemon = daemonConnection({
    daemonId: identity.daemonId,
    baseUrl,
    deviceId: 'fy_device_id_keyedDevice00000000001',
    ...(carriers === undefined ? {} : { carriers }),
  });
  return { identity, daemon, deviceKeys };
};

/** One daemon a {@link fetcherDaemons} network serves, on the host its direct address names. */
export interface FetcherDaemon {
  readonly host: string;
  readonly identity: DaemonIdentity;
  /** What a `pair` record on this daemon is answered with. */
  readonly paired?: unknown;
  /** Answers keepalives, for a suite that holds sessions longer than the browser's keepalive interval. */
  readonly answersHeartbeats?: boolean;
}

/**
 * A network of scripted daemons whose ROUTE TABLE IS AN ORDINARY FETCH FIXTURE.
 *
 * A suite that already describes a daemon as `(url, init) => Response` keeps doing so: each `req` a
 * session carries is turned back into that URL and init and answered with what the fixture returns.
 * The session in front of it is entirely real — handshake against the pinned fingerprint, the device
 * proof, sealed records — so a page under test reaches its daemon exactly as it does in production,
 * and a suite need not restate every route as a session script.
 *
 * `reachable` refuses every socket while it answers false: a carrier that is down, not a daemon that
 * answered with an error.
 */
export const fetcherDaemons = (
  daemons: readonly FetcherDaemon[],
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  reachable: () => boolean = () => true,
): {
  readonly dial: (url: string) => ScriptedSocket;
  readonly dialled: string[];
  /** Every credential and request record each daemon received, by host. */
  readonly requests: (host: string) => readonly unknown[];
} => {
  const routes = new Map(
    daemons.map(daemon => [
      daemon.host,
      autoDial(daemon.identity, {
        ...(daemon.paired === undefined ? {} : { paired: daemon.paired }),
        ...(daemon.answersHeartbeats === true ? { answersHeartbeats: true } : {}),
        respond: async request => {
          const url = new URL(request.path, `https://${daemon.host}`);
          for (const [name, value] of request.query ?? []) url.searchParams.append(name, value);
          const response = await fetcher(url.toString(), {
            method: request.method,
            ...(request.headers === undefined ? {} : { headers: request.headers }),
            ...(request.body === undefined ? {} : { body: request.body }),
          });
          return { status: response.status, body: await response.text() };
        },
      }),
    ]),
  );
  const dialled: string[] = [];
  const dial = (url: string): ScriptedSocket => {
    dialled.push(url);
    const route = routes.get(new URL(url).hostname);
    if (route !== undefined && reachable()) return route.dial();
    const refused = new ScriptedSocket();
    queueMicrotask(() => refused.onClose?.(1006, 'the address did not answer'));
    return refused;
  };
  return { dial, dialled, requests: host => routes.get(host)?.requests ?? [] };
};

/**
 * A daemon NEWER than this app, reached through a rendezvous: it refuses this app's hello in the sentence
 * every surface shares for an app that needs updating.
 */
export const newerDaemonDial = (): { readonly dial: () => ScriptedSocket; readonly sockets: ScriptedSocket[] } =>
  olderDaemonDial({ code: RELAY_CLOSE_CODES.versionUnsupported, reason: OLDER_APP_SENTENCE });

/**
 * A daemon from before device keys, reached through a rendezvous: it reads this app's `/2` hello as
 * garbage and ends the session in the exact words a `/1` daemon uses. Every dial is one such session.
 */
export const olderDaemonDial = (
  closed: { readonly code: number; readonly reason: string } = {
    code: RELAY_CLOSE_CODES.protocolError,
    reason: 'unparseable client hello',
  },
): { readonly dial: () => ScriptedSocket; readonly sockets: ScriptedSocket[] } => {
  const sockets: ScriptedSocket[] = [];
  const dial = (): ScriptedSocket => {
    const sessionId = testSessionId(sockets.length + 1);
    const socket = new ScriptedSocket();
    const original = socket.send.bind(socket);
    socket.send = (bytes: Uint8Array): void => {
      original(bytes);
      const decoded = decodeFrame(bytes);
      if (!decoded.ok || decoded.frame.kind !== FRAME_KINDS.handshake) return;
      queueMicrotask(() => socket.onBinary?.(controlFrame(sessionId, { t: 'closed', ...closed })));
    };
    sockets.push(socket);
    queueMicrotask(() => {
      socket.onOpen?.();
      socket.onBinary?.(readyFrame(sessionId));
    });
    return socket;
  };
  return { dial, sockets };
};

/** A preference store that walks Auto for every machine: these suites prove the walk, and Relay is the app default. */
export class AutoCarrierPreferences extends CarrierPreferenceStore {
  override preference = (): CarrierPreference => 'auto';
}
