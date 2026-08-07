/**
 * THE BROWSER'S HALF OF A RENDEZVOUS SESSION.
 *
 * `docs/relay-protocol.md` is the contract; this is the client end of it, and
 * `packages/daemon/src/lib/relay/link.ts` is the other end. Read that file beside
 * this one: everything here is the mirror of something there, and where the two
 * disagree the document wins.
 *
 * THE BROWSER NEVER DIALS THE DAEMON HERE. It dials the rendezvous, which is
 * already holding a socket the daemon opened outbound from behind its NAT. That
 * is the entire reason a phone can reach a laptop it has no route to.
 *
 * WHAT THIS MODULE REFUSES TO DO, in every case where the alternative is a
 * session that looks healthy and is not:
 *
 * - **It will not key a channel to a key the pairing did not pin.**
 *   `completeClientHandshake` checks the presented SPKI against the fingerprint
 *   the QR carried BEFORE it checks the signature and before it derives anything,
 *   so a rendezvous that introduced the wrong daemon never reaches a state where
 *   this side holds usable keys — and above all never reaches the device token.
 * - **It will not send the device token outside the encrypted channel.** The
 *   credential is one §14 record at sequence 1, after keying. A relay operator
 *   sees a session open; it never sees what opened it.
 * - **It will not repair a stream.** A bad tag, a sequence that is not the next
 *   one, a record for another session: the session is over and every request
 *   waiting on it is rejected with the reason. There is no resume in this
 *   protocol, and a carrier that quietly lost frames would otherwise produce a
 *   conversation that is missing data and says so nowhere.
 * - **It will not answer a request it did not get an answer to.** A session that
 *   ends rejects everything outstanding. Nothing here resolves on absent
 *   evidence: damaged state is not empty state.
 */

import {
  type PairingResponse,
  PairingResponseSchema,
  RELAY_SESSION_CONCLUDED_CLOSE_CODE,
  relayDataByteBudget,
} from '@ferretry/protocol';
import {
  type ChannelState,
  CREDIT_WINDOW_FRAMES,
  completeClientHandshake,
  creditToReturn,
  decodeControlMessage,
  decodeCreditPayload,
  decodeDaemonHello,
  decodeFrame,
  encodeCreditPayload,
  encodeFrame,
  encodeHandshakeMessage,
  fromBase64Url,
  FRAME_KINDS,
  grantCredit,
  HANDSHAKE_FRAME_SEQUENCE,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  MAX_PLAINTEXT_BYTES,
  maySend,
  newReceiveWindow,
  newSendWindow,
  openChannel,
  openRecord,
  type PendingClientHandshake,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  type ReceiveWindow,
  type RelayCrypto,
  type RelayFrame,
  recordConsumed,
  recordCredited,
  recordSent,
  type SendWindow,
  type SessionId,
  sealRecord,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
  utf8Text,
} from '@ferretry/relay';
import { z } from 'zod';

/** The one socket surface this session needs. Injected, so no suite opens a real one. */
export interface RelayClientSocket {
  send(bytes: Uint8Array): void;
  sendText(text: string): void;
  close(code: number, reason: string): void;
}

/* ---------- §14, the client's half of the tunnel above the channel --------- */

/** The widest request identifier §14 allows, and the same bound the daemon enforces. */
export const MAX_TUNNEL_REQUEST_ID = 0xffff_ffff;

/**
 * The ONE reason a pairing may be refused with, and the absence of any other is the security property.
 *
 * §14: one machine reason "for every cause — no active code, a wrong code, an expired one, a spent
 * budget, a body the schema refused". A pre-auth surface the whole internet can reach must not be an
 * oracle, so there is deliberately nothing here for a screen to branch on. Adding a second value
 * would delete the property, not improve the message.
 */
export const PAIRING_REFUSED_REASON = 'pairing_refused' as const;

/**
 * How many raw bytes fit in one `data` record, derived rather than declared.
 *
 * §14: "not a constant to hard-code, because it moves if the envelope does". Both ends must agree
 * exactly or a split write becomes a `4400`, so this is the protocol package's own derivation called
 * with the protocol's own plaintext ceiling — one source, one number, no second opinion here.
 */
export const RELAY_DATA_BYTE_BUDGET = relayDataByteBudget(MAX_PLAINTEXT_BYTES);

/**
 * What the daemon may say back.
 *
 * `headers` and `body` are optional here even though the reference daemon always
 * sends both. An ABSENT field is unambiguous — no headers, empty body — and §14's
 * discipline is aimed at what cannot be read, not at what was plainly not there.
 * A field of the wrong TYPE is still a refusal, which is the part that matters.
 */
/**
 * `data` IS THE ONE MESSAGE WITH NO `protocol` FIELD, and it is the one that repeats most.
 *
 * §14 shows every other record carrying `ferretry-relay/1` and shows `data` without it. That is not
 * an omission to tidy up: a stream sends these continuously, and a version tag on every keystroke
 * would spend the record budget restating something the session settled at sequence 1. Adding it
 * here would make every conforming daemon's stream `4400` on arrival.
 *
 * EXACTLY ONE OF `text` OR `bytes`, never both and never neither — which is why this is two strict
 * objects in a union rather than one object with two optional fields. `strictObject` refuses the
 * pair, and neither member matches when both are absent.
 */
const DataTextSchema = z.strictObject({ t: z.literal('data'), text: z.string().max(MAX_PLAINTEXT_BYTES) });
const DataBytesSchema = z.strictObject({ t: z.literal('data'), bytes: z.string().max(MAX_PLAINTEXT_BYTES) });

/** The close taxonomy a direct socket carries, travelling inside the channel because it is content. */
const StreamCloseSchema = z.strictObject({
  t: z.literal('stream-close'),
  protocol: z.literal(RELAY_PROTOCOL_ID),
  code: z.number().int().min(1_000).max(4_999),
  reason: z.string().max(200),
});

export const RelayTunnelDaemonMessageSchema = z.union([
  z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('authenticated'), protocol: z.literal(RELAY_PROTOCOL_ID) }),
    z.strictObject({
      t: z.literal('res'),
      id: z.number().int().min(1).max(MAX_TUNNEL_REQUEST_ID),
      status: z.number().int().min(100).max(599),
      headers: z.record(z.string().max(64), z.string().max(4_096)).optional(),
      body: z.string().max(MAX_PLAINTEXT_BYTES).optional(),
    }),
    z.strictObject({
      t: z.literal('oversize'),
      id: z.number().int().min(1).max(MAX_TUNNEL_REQUEST_ID),
      status: z.number().int().min(100).max(599),
      byteLength: z.number().int().nonnegative(),
    }),
    // `response` is the pairing API's own redemption response, validated by the pairing API's own
    // schema. §14 embeds it verbatim so "the next field the pairing API adds crosses the relay the
    // day it ships"; re-listing the fields here would be the copy that silently drops it.
    z.strictObject({
      t: z.literal('paired'),
      protocol: z.literal(RELAY_PROTOCOL_ID),
      response: PairingResponseSchema,
    }),
    // One reason for every cause. A pre-auth surface the whole internet can reach must not be an
    // oracle, so there is deliberately nothing here to tell "no code exists" from "wrong guess".
    z.strictObject({
      t: z.literal('pair-refused'),
      protocol: z.literal(RELAY_PROTOCOL_ID),
      reason: z.literal(PAIRING_REFUSED_REASON),
    }),
    z.strictObject({ t: z.literal('stream-opened'), protocol: z.literal(RELAY_PROTOCOL_ID) }),
    // `status` and `body` are both REQUIRED: the daemon always has an `ApiResponse` body to send,
    // and an optional one would let a refusal cross with no explanation of itself.
    z.strictObject({
      t: z.literal('stream-refused'),
      protocol: z.literal(RELAY_PROTOCOL_ID),
      status: z.number().int().min(100).max(599),
      body: z.string().max(MAX_PLAINTEXT_BYTES),
    }),
    StreamCloseSchema,
  ]),
  DataTextSchema,
  DataBytesSchema,
]);
export type RelayTunnelDaemonMessage = z.infer<typeof RelayTunnelDaemonMessageSchema>;

/** What this side sends. Exactly the shapes §14 defines for a client, across all three modes. */
export type RelayTunnelClientMessage =
  | { readonly t: 'auth'; readonly protocol: typeof RELAY_PROTOCOL_ID; readonly deviceToken: string }
  | {
      readonly t: 'pair';
      readonly protocol: typeof RELAY_PROTOCOL_ID;
      readonly code: string;
      readonly deviceName: string;
    }
  | {
      readonly t: 'stream';
      readonly protocol: typeof RELAY_PROTOCOL_ID;
      readonly deviceToken: string;
      readonly path: string;
      readonly query?: readonly (readonly [string, string])[];
    }
  | {
      readonly t: 'req';
      readonly id: number;
      readonly method: string;
      readonly path: string;
      readonly query?: readonly (readonly [string, string])[];
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    }
  | { readonly t: 'data'; readonly text: string }
  | { readonly t: 'data'; readonly bytes: string }
  | {
      readonly t: 'stream-close';
      readonly protocol: typeof RELAY_PROTOCOL_ID;
      readonly code: number;
      readonly reason: string;
    };

export function encodeTunnelClientMessage(message: RelayTunnelClientMessage): Uint8Array {
  return utf8Bytes(JSON.stringify(message));
}

/** Decode one daemon record. Null covers bad UTF-8, bad JSON and every shape outside the union. */
export function decodeTunnelDaemonMessage(plaintext: Uint8Array): RelayTunnelDaemonMessage | null {
  const text = utf8Text(plaintext);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = RelayTunnelDaemonMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The answer to one relayed request, as this side sees it.
 *
 * `oversize` is kept as its own shape rather than flattened into a status,
 * because §14 made it a typed refusal for a reason: a client that turned "the
 * answer does not fit one record" into a 200 with an empty body would render a
 * fleet that does not exist.
 */
export type RelayTunnelAnswer =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }
  | { readonly kind: 'oversize'; readonly status: number; readonly byteLength: number };

/* ---------- the session ---------------------------------------------------- */

/**
 * WHAT THIS SESSION IS FOR, decided before it is opened and never afterwards.
 *
 * §14: "The record at sequence `1` is the client's credential, and it is a strict union of three.
 * Each one commits the session to a mode, the mode is decided by that record's own shape rather than
 * by any later negotiation, and each mode's terminal state is unreachable from the others."
 *
 * IT IS A UNION RATHER THAN OPTIONAL FIELDS ON PURPOSE, and §14 gives the reason in its own words:
 * "a session that 'should not' send requests is a rule nothing checks, while a session whose message
 * schema has no request in it is a rule nothing can break." So a pairing session has no
 * `deviceToken` field to accidentally acquire one in, and a stream session has no request path.
 */
export type RelaySessionMode =
  /** A request session: any number of `req`, each answered by its own `id`. */
  | { readonly kind: 'auth'; readonly deviceToken: string }
  /** A pairing session: one redemption attempt, one sealed outcome, then the session closes. */
  | { readonly kind: 'pair'; readonly code: string; readonly deviceName: string }
  /** A stream session: exactly one protocol-switching stream, opened by the credential record itself. */
  | {
      readonly kind: 'stream';
      readonly deviceToken: string;
      readonly path: string;
      readonly query?: readonly (readonly [string, string])[];
    };

export interface RelayClientSessionDependencies {
  readonly crypto: RelayCrypto;
  /** The fingerprint the pairing QR carried. Nothing else is ever accepted in its place. */
  readonly daemonId: string;
  /** What this session is for. Sent once, at sequence 1, inside the channel. */
  readonly mode: RelaySessionMode;
  readonly socket: RelayClientSocket;
  /**
   * The largest request identifier this session will mint.
   *
   * §14's bound by default. It is a parameter rather than a constant because the
   * exhaustion path — the one that ends the session instead of wrapping — is
   * otherwise four billion requests away from anything a test can reach, and an
   * unprovable refusal is a refusal nobody can be sure of.
   */
  readonly maxRequestId?: number;
  /** One arrived stream frame. Only a stream session ever calls it. */
  readonly onData?: (frame: RelayStreamFrame) => void;
  /** Observe a faulty close listener without coupling this pure domain module to browser IO. */
  readonly onStreamListenerFailure?: (reason: unknown) => void;
}

/** One frame of a live stream, in the two shapes §14 gives it. */
export type RelayStreamFrame =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array };

/** What a pairing session produced, once the sealed outcome has been latched. */
export type RelayPairingOutcome = { readonly kind: 'paired'; readonly response: PairingResponse };

/**
 * The daemon refused this redemption, inside the channel — a RESULT, not a transport failure.
 *
 * Its own class because §14 requires a client to keep the two apart and says how: "one arrives as a
 * close outside the channel, the other as a record inside it". A walk that read this as a transport
 * failure would try the next carrier with a code the daemon has already judged, spending another
 * attempt from the relay budget to be told the same thing.
 */
export class RelayPairingRefusedError extends Error {
  readonly reason = PAIRING_REFUSED_REASON;
  constructor() {
    // The remedy is the direct route's own, because the cause is deliberately unknowable here.
    super('this pairing code is wrong, expired or already spent');
    this.name = 'RelayPairingRefusedError';
  }
}

/**
 * The daemon refused to open this stream, carrying the status the direct upgrade would have carried.
 *
 * §14: "everything a status can say must be said BEFORE the protocol switches; a stream that opened
 * and then instantly died cannot tell 'it is gone' from 'the daemon broke'." So this is final for
 * this attempt and a caller must not treat it as a reason to reconnect.
 */
export class RelayStreamRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`the daemon refused this stream: ${status}`);
    this.name = 'RelayStreamRefusedError';
  }
}

/**
 * The stream ended, carrying the same close taxonomy a direct socket would have.
 *
 * `1000` a viewer that is done, `1008` a server-only stream written to, `1009` a frame too large to
 * cross, `1011` evidence the daemon could not produce, `1013` a reader that fell behind. The code
 * travels inside the channel because it is content — a relay that could read close reasons could
 * read why viewers leave — and it is THIS code a caller decides to reconnect on, never the session's.
 */
export interface RelayStreamClosed {
  readonly code: number;
  readonly reason: string;
}

type SessionPhase =
  | 'awaiting-ready'
  | 'awaiting-hello'
  /** Keyed, credential sent, waiting for the daemon's sealed acceptance. One phase for all three modes. */
  | 'awaiting-credential'
  | 'serving'
  | 'streaming'
  /**
   * A sealed terminal outcome has been latched and the session is finished with.
   *
   * DISTINCT FROM `ended`, and the distinction is the whole of §14's latch rule. A pairing or a
   * stream states its outcome INSIDE the channel and the daemon then closes with `4440`; a session
   * that treated that close as a failure would discard a pairing that succeeded. So a close arriving
   * here is expected teardown and changes nothing, while a close arriving in any earlier phase is a
   * failure — including a `4440`, which §14 makes "a protocol violation reported as one, never
   * reinterpreted as a quiet end" when no sealed outcome crossed before it.
   */
  | 'concluded'
  | 'ended';

interface PendingRequest {
  readonly resolve: (answer: RelayTunnelAnswer) => void;
  readonly reject: (reason: Error) => void;
}

/** What a thrown value says about itself, without pretending an unknown one is an `Error`. */
const failureReason = (reason: unknown): string =>
  `this session's consumer refused a record: ${reason instanceof Error ? reason.message : String(reason)}`;

/** The record at sequence 1, which is this session's mode expressed on the wire. */
const credentialRecord = (mode: RelaySessionMode): RelayTunnelClientMessage => {
  if (mode.kind === 'auth') return { t: 'auth', protocol: RELAY_PROTOCOL_ID, deviceToken: mode.deviceToken };
  if (mode.kind === 'pair')
    return { t: 'pair', protocol: RELAY_PROTOCOL_ID, code: mode.code, deviceName: mode.deviceName };
  return {
    t: 'stream',
    protocol: RELAY_PROTOCOL_ID,
    deviceToken: mode.deviceToken,
    path: mode.path,
    ...(mode.query === undefined || mode.query.length === 0 ? {} : { query: mode.query }),
  };
};

/**
 * One arrived `data` record as the frame a stream consumer reads.
 *
 * `null` only for bytes that are not base64url. That is not a decoding inconvenience: §7 already
 * authenticated this record, so a value that will not decode means the two ends disagree about the
 * encoding, and writing whatever came out into a terminal would be writing invented bytes.
 */
const streamFrame = (message: { readonly text: string } | { readonly bytes: string }): RelayStreamFrame | null => {
  if ('text' in message) return { kind: 'text', text: message.text };
  const bytes = fromBase64Url(message.bytes);
  return bytes === null ? null : { kind: 'bytes', bytes };
};

/** Thrown for every refusal this side makes or is told about, carrying the close code. */
export class RelaySessionError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'RelaySessionError';
  }
}

/**
 * One end-to-end conversation with one daemon, over one rendezvous socket.
 *
 * The instance is single-use and single-session, deliberately: §9 says a session
 * is bound to its sockets and reconnecting is a NEW session with new keys, not a
 * resumption. A reconnect therefore builds a new one of these rather than
 * reviving this one, which is the only reading that cannot pretend a gap was
 * repaired.
 */
export class RelayClientSession {
  #phase: SessionPhase = 'awaiting-ready';
  #sessionId: SessionId | undefined;
  #pendingHandshake: PendingClientHandshake | undefined;
  #channel: ChannelState | undefined;
  #send: SendWindow = newSendWindow();
  #receive: ReceiveWindow = newReceiveWindow();
  #nextRequestId = 1;
  #failure: RelaySessionError | undefined;
  readonly #pending = new Map<number, PendingRequest>();
  /** Records waiting for the peer to return credit. Bounded by one window. */
  readonly #waiting: Uint8Array[] = [];
  /** Serialises everything that assigns a sequence number: a record's nonce IS its sequence, and
   *  two sealers racing would hand one nonce to two records under one key. */
  #outbox: Promise<void> = Promise.resolve();
  #authenticated: ((session: RelayClientSession) => void) | undefined;
  #refused: ((reason: Error) => void) | undefined;
  readonly #ready: Promise<RelayClientSession>;
  #settlePairing: ((outcome: RelayPairingOutcome) => void) | undefined;
  #refusePairing: ((reason: Error) => void) | undefined;
  readonly #pairing: Promise<RelayPairingOutcome>;
  /**
   * How the stream ended, once it has. `undefined` while it is still running.
   *
   * Kept as state rather than only announced, because a caller that subscribes after the close would
   * otherwise wait on a stream that already finished — the "absent evidence read as a pending
   * result" shape this package keeps paying for.
   */
  #streamClosed: RelayStreamClosed | undefined;
  readonly #streamListeners = new Set<(closed: RelayStreamClosed) => void>();
  /**
   * Receives in flight, and the close that is waiting for them to finish.
   *
   * WHY A CLOSE HAS TO WAIT, and it is the sharpest bug this class has had. Opening a record is
   * asynchronous — `openRecord` decrypts — while a socket close arrives synchronously, and the
   * adapter hands frames over without awaiting them. So the sealed record stating a pairing's
   * outcome can still be inside `openRecord` when the daemon's `4440` lands. Applying that close
   * immediately sets the phase to `ended`, and the resumed record handler then finds a session that
   * is over and drops the outcome on the floor: the daemon minted the grant, the browser saw the
   * close, and a SUCCESSFUL pairing is reported as a failure. §14 puts the sealed outcome before the
   * close precisely so that cannot happen, and honouring it means the close is applied only once
   * nothing is still being read.
   *
   * The counter keeps the common path synchronous — nothing in flight, close applied at once, which
   * is what every existing caller and test sees — and defers only in the race it exists for.
   */
  #receiving = 0;
  #deferredClose: { readonly code: number; readonly reason: string } | undefined;
  /** Serialises frame handling, so a later frame never overtakes an earlier one mid-decrypt. */
  #inbox: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RelayClientSessionDependencies) {
    this.#ready = new Promise<RelayClientSession>((resolve, reject) => {
      this.#authenticated = resolve;
      this.#refused = reject;
    });
    this.#pairing = new Promise<RelayPairingOutcome>((resolve, reject) => {
      this.#settlePairing = resolve;
      this.#refusePairing = reject;
    });
    // A rejection nobody has awaited yet is not an unhandled rejection: the caller
    // always awaits `ready()`, and this keeps a refusal that arrives first quiet.
    this.#ready.catch(() => undefined);
    this.#pairing.catch(() => undefined);
  }

  /**
   * Resolves when the daemon has accepted this session's credential, and not before.
   *
   * "Accepted" means `authenticated` for a request session and `stream-opened` for a stream session —
   * the same moment in both, because §14 gives them the same rule: nothing follows the credential
   * record until the sealed acceptance arrives. A PAIRING session never resolves this; it has one
   * outcome and `paired()` is where that outcome is.
   */
  ready(): Promise<RelayClientSession> {
    return this.#ready;
  }

  /**
   * The sealed outcome of a pairing session.
   *
   * Rejects with `RelayPairingRefusedError` when the daemon refused inside the channel, and with a
   * `RelaySessionError` when nothing reached the daemon at all. Those are different facts with
   * different remedies and §14 requires a client to keep them apart, so they are different classes
   * rather than one error with a flag.
   */
  paired(): Promise<RelayPairingOutcome> {
    return this.#pairing;
  }

  /** True only while the session is keyed, authenticated and has not been refused. */
  live(): boolean {
    return this.#phase === 'serving';
  }

  /** True only while a stream session is open and still carrying frames. */
  streaming(): boolean {
    return this.#phase === 'streaming';
  }

  /**
   * How the stream ended, or a subscription to find out.
   *
   * Answers immediately when it has already ended, because a caller arriving late must not be left
   * waiting on something that is over.
   *
   * EVERY LISTENER IS KEPT, and this used to ASSIGN. One session legitimately has two watchers with
   * different jobs — the consumer that wants to know its stream ended, and the router that evicts the
   * session from the structure an unpair walks — and a single holder makes those two silently fight:
   * whichever subscribed second won, so either the consumer was never told the stream closed (a
   * terminal pane stuck on `connecting` forever, an event promise that never settles) or the router
   * never evicted. Two facts, two listeners, no ordering to get wrong.
   */
  onStreamClosed(listener: (closed: RelayStreamClosed) => void): void {
    const already = this.#streamClosed;
    if (already !== undefined) {
      this.#notifyStreamClosed(listener, already);
      return;
    }
    this.#streamListeners.add(listener);
  }

  /** One observer is not part of the protocol state and cannot fail or re-enter its teardown. */
  #notifyStreamClosed(listener: (closed: RelayStreamClosed) => void, closed: RelayStreamClosed): void {
    try {
      listener(closed);
    } catch (reason) {
      try {
        this.deps.onStreamListenerFailure?.(reason);
      } catch {
        // Teardown and the remaining listeners cannot depend on an injected reporting port.
      }
    }
  }

  /** Tell every watcher once, and never twice: `#streamClosed` is latched before this runs. */
  #announceStreamClosed(closed: RelayStreamClosed): void {
    // Snapshot and clear FIRST. A watcher may subscribe re-entrantly (and is then answered from the
    // latched result), while a throwing watcher must neither retain every closure nor skip the rest.
    const listeners = [...this.#streamListeners];
    this.#streamListeners.clear();
    for (const listener of listeners) this.#notifyStreamClosed(listener, closed);
  }

  /** The heartbeat this side owes: text, so the edge answers it without waking anything. */
  heartbeat(): void {
    if (this.#phase === 'ended' || this.#phase === 'concluded') return;
    this.deps.socket.sendText(HEARTBEAT_REQUEST);
  }

  /**
   * One frame into a live stream, split when it does not fit.
   *
   * TEXT IS NEVER SPLIT AND BYTES ALWAYS MAY BE, which is §14's own distinction rather than a
   * convenience: "a text record carries exactly one complete text frame … because a text frame is a
   * message and half a message is corruption", while "a bytes record carries a run of an ordered
   * byte stream … a terminal neither knows nor cares whether a paste arrived as one write or three".
   * So an oversized text frame is a refusal and an oversized write is simply several records.
   */
  sendStream(frame: RelayStreamFrame): void {
    if (this.#phase !== 'streaming') {
      throw new RelaySessionError('this relay session is not carrying a stream', RELAY_CLOSE_CODES.protocolError);
    }
    if (frame.kind === 'text') {
      this.#sendRecord({ t: 'data', text: frame.text });
      return;
    }
    // A ZERO-LENGTH WRITE IS STILL A WRITE, and the loop below runs no iterations for one — so it was
    // dropped with nothing said, in a class whose stated doctrine is that damaged state is never
    // empty state. Harmless for a terminal today; the silent drop is the shape, not the size.
    if (frame.bytes.byteLength === 0) {
      this.#sendRecord({ t: 'data', bytes: '' });
      return;
    }
    for (let offset = 0; offset < frame.bytes.byteLength; offset += RELAY_DATA_BYTE_BUDGET) {
      this.#sendRecord({
        t: 'data',
        bytes: toBase64Url(frame.bytes.subarray(offset, offset + RELAY_DATA_BYTE_BUDGET)),
      });
    }
  }

  /**
   * Leave a stream deliberately, and say so on the wire.
   *
   * §14 makes cancellation an explicit sealed record rather than a dropped socket "so that the
   * taxonomy survives in both directions and a deliberate leave is never spelled the same as a
   * network failure". The daemon tears the handler down and ends the session; this side latches the
   * conclusion now, so the `4440` that follows is the expected teardown it is.
   */
  closeStream(code = 1000, reason = 'the viewer left this stream'): void {
    if (this.#phase !== 'streaming') return;
    this.#sendRecord({ t: 'stream-close', protocol: RELAY_PROTOCOL_ID, code, reason });
    this.#concludeStream({ code, reason });
  }

  /**
   * One relayed request, answered by its own `id`.
   *
   * Rejects rather than resolving on any refusal. A request that resolved with a
   * fabricated answer would be the whole failure this protocol exists to avoid.
   */
  async request(
    message: Omit<Extract<RelayTunnelClientMessage, { t: 'req' }>, 't' | 'id'>,
  ): Promise<RelayTunnelAnswer> {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#phase !== 'serving') {
      throw new RelaySessionError('this relay session is not serving requests', RELAY_CLOSE_CODES.protocolError);
    }
    if (this.#nextRequestId > (this.deps.maxRequestId ?? MAX_TUNNEL_REQUEST_ID)) {
      // §14 requires an identifier unique within the session, so there is no wrap
      // that is not also a reuse. Ending is the option with no failure mode.
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'this session has exhausted its request identifiers');
      throw this.#failure ?? new RelaySessionError('request identifiers exhausted', RELAY_CLOSE_CODES.protocolError);
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const answer = new Promise<RelayTunnelAnswer>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#sendRecord({ ...message, t: 'req', id });
    await this.#outbox;
    return await answer;
  }

  /** End this session from this side, refusing everything still waiting on it. */
  close(reason = 'the browser closed this session'): void {
    if (this.#done()) return;
    this.#fail(RELAY_CLOSE_CODES.protocolError, reason);
    this.deps.socket.close(1000, 'session closed');
  }

  /**
   * The carrier dropped the socket. Every session on it is gone, which is what §9 says.
   *
   * EXCEPT WHEN THIS SESSION ALREADY SAID HOW IT ENDED. A pairing and a stream state their outcome
   * inside the channel and the daemon then closes with `4440`; §14 calls that "expected teardown,
   * not a failure that overwrites a pairing that succeeded". So a close after a latched conclusion
   * changes nothing at all — and a close BEFORE one is still a failure carrying its own code, which
   * is how "a `4440` with no sealed outcome" is reported as the protocol violation §14 says it is
   * rather than smoothed into a quiet end.
   */
  carrierClosed(code: number, reason: string): void {
    if (this.#done()) return;
    // A record may still be decrypting. Applying a close under it would drop the outcome that record
    // carries — see `#receiving`.
    //
    // ONLY FOR THE MODES THAT END WITH A SEALED OUTCOME, deliberately. A request session has no
    // record whose arrival a close could destroy the meaning of: its answers are per-request and a
    // close genuinely ends it, so deferring there would delay every ordinary teardown by a microtask
    // to protect nothing. The hazard §14 legislates against is specific to pairing and streams.
    if (this.#receiving > 0 && this.deps.mode.kind !== 'auth') {
      this.#deferredClose ??= { code, reason };
      return;
    }
    // Quietly: the carrier has already taken this socket away, so there is nothing left to close.
    this.#quietly(code, this.#closedWithoutOutcome(code, reason));
  }

  /** Nothing more will happen to this session, by either route out of it. */
  #done(): boolean {
    return this.#phase === 'ended' || this.#phase === 'concluded';
  }

  /**
   * What to say about a close that arrived where a sealed outcome was owed.
   *
   * Named rather than generic because the two cases read completely differently to somebody holding
   * the resulting error: a session that never got as far as its credential simply lost its carrier,
   * while one that sent a credential and got a bare close was told nothing by a daemon that owed it
   * an answer. §14 requires the second to be reported as a violation.
   *
   * THE VIOLATION SENTENCE DOES NOT DEPEND ON THE CARRIER SAYING NOTHING. It used to be reached only
   * for an EMPTY reason, so a `4440` that arrived carrying any string at all — which a conforming
   * rendezvous forwards from the daemon — was reported in the carrier's words instead of as the
   * violation it is. The phase is what decides this, because the phase is what knows an outcome was
   * owed; the carrier's own words are kept for the cases where nothing was.
   */
  #closedWithoutOutcome(code: number, reason: string): string {
    if (this.#phase !== 'awaiting-credential' && this.#phase !== 'streaming') {
      return reason === '' ? 'the carrier closed this session' : reason;
    }
    return code === RELAY_SESSION_CONCLUDED_CLOSE_CODE
      ? 'the daemon ended this session as concluded without stating an outcome inside the channel, which this protocol does not allow'
      : 'the carrier closed this session before the daemon answered its credential';
  }

  /**
   * A text message from the carrier.
   *
   * Exactly two strings are legal. Anything else is a protocol error rather than a
   * curiosity to log: a carrier improvising on a channel this narrow is not one
   * this browser can reason about.
   */
  receiveText(text: string): void {
    if (text === HEARTBEAT_REQUEST) {
      this.deps.socket.sendText(HEARTBEAT_RESPONSE);
      return;
    }
    if (text === HEARTBEAT_RESPONSE) return;
    this.#fail(RELAY_CLOSE_CODES.protocolError, 'the carrier sent an unknown text message');
  }

  /**
   * One binary message from the carrier: exactly one frame, or the end of it.
   *
   * Resolves once everything this frame caused has been written, so an adapter can
   * hand frames over one at a time and be sure the second is never handled before
   * the first has finished.
   */
  async receiveBinary(bytes: Uint8Array): Promise<void> {
    this.#receiving += 1;
    // STRICTLY IN ORDER, because an adapter hands frames over without awaiting them. Opening a
    // record decrypts, so frame N+1 would otherwise start while frame N was still inside
    // `openRecord` — and the pair that matters is a sealed outcome followed by the rendezvous
    // saying the session closed. Handled out of order, the close wins and the outcome is dropped:
    // the daemon minted a grant and the browser reports a failure. §3 already makes a frame's
    // sequence its nonce; handling them in that order is the same discipline one layer up.
    const previous = this.#inbox;
    let release = (): void => undefined;
    this.#inbox = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      await this.#handle(bytes);
      await this.#outbox;
    } catch (reason) {
      // A CONSUMER THAT THREW HAS LEFT THIS SESSION IN A STATE NOBODY CAN DESCRIBE, and the only
      // thing worse than ending it is not ending it. `onData` runs a caller's code — the typed
      // client parses each event against a strict schema and throws on a frame kind this bundle does
      // not know, which is exactly what an older browser meets against a newer daemon. Without this
      // the throw escapes into `void session.receiveBinary(bytes)`, becomes an unhandled rejection,
      // and leaves the session in `streaming` with no sealed close and no `4440`: the stream's own
      // promise never settles, the abort listener stays registered, and the rendezvous session keeps
      // holding a device grant with nobody watching it. The daemon's own adapter closes the link in
      // this case for the same stated reason; this side was the only one of the four that did not.
      this.#fail(RELAY_CLOSE_CODES.protocolError, failureReason(reason));
    } finally {
      release();
      this.#receiving -= 1;
      const deferred = this.#receiving === 0 ? this.#deferredClose : undefined;
      if (deferred !== undefined) {
        this.#deferredClose = undefined;
        this.carrierClosed(deferred.code, deferred.reason);
      }
    }
  }

  async #handle(bytes: Uint8Array): Promise<void> {
    if (this.#done()) return;
    const decoded = decodeFrame(bytes);
    if (!decoded.ok) {
      this.#fail(decoded.code, decoded.reason);
      return;
    }
    const frame = decoded.frame;
    if (frame.kind === FRAME_KINDS.control) {
      await this.#onControl(frame);
      return;
    }
    const sessionId = this.#sessionId;
    if (sessionId === undefined || frame.sessionId.text !== sessionId.text) {
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'a frame named a session this browser does not hold');
      return;
    }
    if (frame.kind === FRAME_KINDS.credit) {
      this.#onCredit(frame);
      return;
    }
    if (frame.kind === FRAME_KINDS.handshake) {
      await this.#onHandshake(frame);
      return;
    }
    await this.#onRecord(frame);
  }

  // ─── rendezvous control ─────────────────────────────────────────────────────

  async #onControl(frame: RelayFrame): Promise<void> {
    const message = decodeControlMessage(frame.payload);
    if (message === null) {
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'unparseable rendezvous control');
      return;
    }
    switch (message.t) {
      case 'ready':
        await this.#onReady(frame.sessionId);
        return;
      case 'closed':
        this.#quietly(message.code, `the rendezvous ended this session: ${message.code} ${message.reason}`);
        return;
      case 'error':
        // The rendezvous closes the socket immediately after this, so closing from
        // here as well would race its own close frame. The reason is what matters.
        this.#quietly(message.code, `the rendezvous refused this browser: ${message.code} ${message.reason}`);
        return;
      default:
        // `challenge`, `claim`, `claimed` and `open` belong to the daemon role.
        // Receiving one means this is not the conversation the browser is in.
        this.#fail(RELAY_CLOSE_CODES.protocolError, `unexpected rendezvous control: ${message.t}`);
    }
  }

  /**
   * The rendezvous assigned this session's identifier, so the handshake can start.
   *
   * The identifier is the RELAY's to mint (§5) and it is in the handshake
   * transcript (§6), which is what stops a carrier replaying one conversation's
   * opening into another session it also carries.
   */
  async #onReady(sessionId: SessionId): Promise<void> {
    if (this.#phase !== 'awaiting-ready') {
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'a second ready arrived for this socket');
      return;
    }
    const pending = await startClientHandshake(this.deps.crypto, sessionId, this.deps.daemonId);
    this.#sessionId = sessionId;
    this.#pendingHandshake = pending;
    this.#phase = 'awaiting-hello';
    // The hello occupies sequence 0 of this direction, which is why it is sent as a
    // frame rather than through the record path: it is the one end-to-end frame that
    // is not a record. It is also the first frame of a fresh window, so there is
    // nothing to ask about credit — a check here would be a guard nothing can trip,
    // which reads as protection and is not any.
    this.#send = recordSent(this.#send);
    this.deps.socket.send(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId,
        sequence: HANDSHAKE_FRAME_SEQUENCE,
        payload: encodeHandshakeMessage(pending.hello),
      }),
    );
  }

  #onCredit(frame: RelayFrame): void {
    const frames = decodeCreditPayload(frame.payload);
    if (frames === null) {
      this.#fail(RELAY_CLOSE_CODES.flowViolation, 'malformed credit');
      return;
    }
    const granted = grantCredit(this.#send, frames);
    if (granted.allowed === this.#send.allowed) {
      // A grant that changes nothing means the peer and the carrier disagree about
      // the window, and guessing which one is right is not available.
      this.#fail(RELAY_CLOSE_CODES.flowViolation, 'credit grant had no effect');
      return;
    }
    this.#send = granted;
    this.#flush();
  }

  // ─── the handshake, and the credential that follows it ──────────────────────

  async #onHandshake(frame: RelayFrame): Promise<void> {
    const pending = this.#pendingHandshake;
    if (this.#phase !== 'awaiting-hello' || pending === undefined || frame.sequence !== HANDSHAKE_FRAME_SEQUENCE) {
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'a handshake arrived out of turn');
      return;
    }
    const hello = decodeDaemonHello(frame.payload);
    if (hello === null) {
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'unparseable daemon hello');
      return;
    }
    const completed = await completeClientHandshake(this.deps.crypto, pending, hello);
    if (!completed.ok) {
      // The fingerprint check lives inside `completeClientHandshake` and runs first,
      // so a wrong daemon is refused here having never seen the device token.
      this.#fail(RELAY_CLOSE_CODES.protocolError, completed.reason);
      return;
    }
    this.#consume();
    this.#channel = openChannel(pending.sessionId, completed.keys, 'client');
    this.#phase = 'awaiting-credential';
    this.#sendRecord(credentialRecord(this.deps.mode));
  }

  async #onRecord(frame: RelayFrame): Promise<void> {
    const channel = this.#channel;
    if (channel === undefined) {
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'a record arrived before the handshake');
      return;
    }
    const opened = await openRecord(this.deps.crypto, channel, frame);
    if (!opened.ok) {
      this.#fail(opened.code, opened.reason);
      return;
    }
    // ONLY THE RECEIVE COUNTER, and writing the whole state back was a real defect rather than a
    // tidier line. `ChannelState` carries BOTH sequences, and sealing runs concurrently on the
    // outbox: a send that completed while this open was awaiting would have its `sendSequence`
    // overwritten by the stale copy captured before the await. A record's sequence IS its AEAD
    // nonce, so the rewound counter reuses one under the same key — the single arithmetic mistake
    // AES-GCM does not survive — and the peer refuses the session with `4420` if it is lucky.
    this.#channel = { ...(this.#channel ?? channel), receiveSequence: opened.state.receiveSequence };
    this.#consume();
    const message = decodeTunnelDaemonMessage(opened.plaintext);
    if (message === null) {
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'unparseable tunnel record');
      return;
    }
    if (this.#phase === 'awaiting-credential') {
      this.#onAcceptance(message);
      return;
    }
    if (this.#phase === 'streaming') {
      this.#onStreamRecord(message);
      return;
    }
    this.#onAnswer(message);
  }

  /**
   * The daemon's sealed answer to this session's credential, read against THIS session's mode.
   *
   * Each mode accepts exactly one shape and refuses every other, which is how §14's "each mode's
   * terminal state is unreachable from the others" is enforced here rather than assumed: a
   * `stream-opened` on a request session, or an `authenticated` on a pairing session, is a daemon
   * answering a question this session did not ask.
   */
  #onAcceptance(message: RelayTunnelDaemonMessage): void {
    const mode = this.deps.mode.kind;
    if (mode === 'auth') {
      if (message.t !== 'authenticated') {
        this.#fail(RELAY_CLOSE_CODES.protocolError, 'the daemon did not accept this device before answering');
        return;
      }
      this.#phase = 'serving';
      this.#authenticated?.(this);
      return;
    }
    if (mode === 'pair') {
      if (message.t === 'paired') {
        // Latched BEFORE the close that follows, which is the whole of §14's rule.
        this.#conclude();
        this.#settlePairing?.({ kind: 'paired', response: message.response });
        return;
      }
      if (message.t === 'pair-refused') {
        this.#conclude();
        this.#refusePairing?.(new RelayPairingRefusedError());
        return;
      }
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'the daemon did not answer this pairing attempt');
      return;
    }
    if (message.t === 'stream-opened') {
      this.#phase = 'streaming';
      this.#authenticated?.(this);
      return;
    }
    if (message.t === 'stream-refused') {
      // A refusal is a RESULT and the session is over; it is concluded rather than failed so the
      // `4440` that follows does not overwrite the status the daemon took care to send first.
      this.#conclude();
      this.#refused?.(new RelayStreamRefusedError(message.status, message.body));
      return;
    }
    this.#fail(RELAY_CLOSE_CODES.protocolError, 'the daemon did not open this stream before answering');
  }

  /** Frames and the end of a live stream. Nothing else may cross a stream session. */
  #onStreamRecord(message: RelayTunnelDaemonMessage): void {
    if (message.t === 'data') {
      const frame = streamFrame(message);
      if (frame === null) {
        this.#fail(RELAY_CLOSE_CODES.protocolError, 'the daemon sent stream bytes that are not base64url');
        return;
      }
      this.deps.onData?.(frame);
      return;
    }
    if (message.t === 'stream-close') {
      this.#concludeStream({ code: message.code, reason: message.reason });
      return;
    }
    this.#fail(RELAY_CLOSE_CODES.protocolError, 'the daemon sent a request answer on a stream session');
  }

  /** One answer to one outstanding request, on a serving session. */
  #onAnswer(message: RelayTunnelDaemonMessage): void {
    if (message.t === 'authenticated') {
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'this session is already authenticated');
      return;
    }
    if (message.t !== 'res' && message.t !== 'oversize') {
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'the daemon sent a record this request session cannot read');
      return;
    }
    const waiting = this.#pending.get(message.id);
    if (waiting === undefined) {
      // An answer to a request this side never sent means the carrier and the
      // daemon disagree about what is outstanding. There is no benign reading.
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'the daemon answered a request this browser did not send');
      return;
    }
    this.#pending.delete(message.id);
    waiting.resolve(
      message.t === 'res'
        ? { kind: 'response', status: message.status, headers: message.headers ?? {}, body: message.body ?? '' }
        : { kind: 'oversize', status: message.status, byteLength: message.byteLength },
    );
  }

  /**
   * This session stated its outcome and is finished with; a close from here on is expected teardown.
   *
   * WHAT IS QUEUED STILL GOES OUT, and that is not laxity — it is the client-initiated close. §14
   * makes a viewer's leave an explicit sealed `stream-close` record, and `closeStream` queues that
   * record and concludes in the same breath; dropping the queue here would conclude the session and
   * throw away the very record that tells the daemon why. Sealing is asynchronous, so "queued" is
   * where that record is at this instant.
   *
   * Nothing NEW can be queued after this: every method that sends checks the phase first, and none
   * of them accepts `concluded`.
   */
  #conclude(): void {
    this.#phase = 'concluded';
  }

  /** The stream ended, from either side, with the taxonomy the direct socket would have carried. */
  #concludeStream(closed: RelayStreamClosed): void {
    if (this.#streamClosed !== undefined) return;
    this.#streamClosed = closed;
    this.#conclude();
    this.#announceStreamClosed(closed);
  }

  // ─── sending ────────────────────────────────────────────────────────────────

  /** Count one consumed end-to-end frame and return credit once half a window is owed. */
  #consume(): void {
    const sessionId = this.#sessionId;
    if (sessionId === undefined) return;
    this.#receive = recordConsumed(this.#receive);
    const owed = creditToReturn(this.#receive);
    if (owed === 0) return;
    this.#receive = recordCredited(this.#receive, owed);
    // Credit is hop-by-hop and carries sequence 0, so it is not part of the
    // end-to-end stream and never spends this side's send window.
    this.deps.socket.send(
      encodeFrame({ kind: FRAME_KINDS.credit, sessionId, sequence: 0, payload: encodeCreditPayload(owed) }),
    );
  }

  /**
   * Queue one record for sending.
   *
   * The only thing checked here is the QUEUE DEPTH: a queue deeper than one window
   * is an unbounded buffer, and the peer's own window bounds how many answers can be
   * outstanding, so a deeper one means the peer is not honouring the protocol.
   * Whether a record FITS is `sealRecord`'s question and is asked there — checking
   * the same length in two places is how two places come to disagree about the
   * envelope.
   */
  #sendRecord(message: RelayTunnelClientMessage): void {
    if (this.#waiting.length >= CREDIT_WINDOW_FRAMES) {
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'this session has too many records waiting on credit');
      return;
    }
    this.#waiting.push(encodeTunnelClientMessage(message));
    this.#flush();
  }

  /**
   * Seal and send whatever the window now allows.
   *
   * Queued on the session's outbox rather than run inline, because sealing is
   * asynchronous and the record nonce IS the sequence number: two flushes in
   * flight would hand one nonce to two records under one key, which is the single
   * arithmetic mistake AES-GCM does not survive.
   */
  #flush(): void {
    this.#outbox = this.#outbox.then(async () => {
      while (this.#waiting.length > 0 && maySend(this.#send)) {
        const channel = this.#channel;
        const plaintext = this.#waiting[0];
        if (channel === undefined || plaintext === undefined) return;
        const sealed = await sealRecord(this.deps.crypto, channel, plaintext);
        if (!sealed.ok) {
          this.#fail(sealed.code, sealed.reason);
          return;
        }
        this.#waiting.shift();
        // The mirror of the rule in `#onRecord`: this side owns the SEND counter and nothing else.
        // An arriving record may have advanced `receiveSequence` while this seal was awaiting, and
        // writing the whole captured state back would rewind it.
        this.#channel = { ...(this.#channel ?? channel), sendSequence: sealed.state.sendSequence };
        this.#send = recordSent(this.#send);
        this.deps.socket.send(encodeFrame(sealed.frame));
      }
    });
  }

  /**
   * End this session, refuse everything waiting on it, and SAY SO ON THE WIRE.
   *
   * The first refusal is the one that is kept: a later close code caused by the
   * first would otherwise overwrite the reason somebody can act on.
   *
   * THE SOCKET IS CLOSED HERE, and it did not used to be. §14 says a message a party could not read
   * "ends the session with `4400`" — which is a statement about the wire, not about a flag. This side
   * used to mark itself ended and go quiet, and nothing closed the socket afterwards either:
   * `driveRelaySession`'s catch cancels timers and rethrows, and `redeemPairingOverRelay` closes only
   * on its success path. A pairing walk that hit a fingerprint mismatch on its first candidate
   * therefore left that socket open with its heartbeat already cancelled, and §14 bounds a link to
   * TWO sessions awaiting a credential — so the second candidate could be refused `4429` by a slot
   * the first attempt was still holding, and the walk would read that as another dead carrier.
   *
   * `#onControl`'s `closed`/`error` branches are the deliberate exception and call `#quietly`: the
   * rendezvous is already closing, and closing from here would race its own close frame.
   */
  #fail(code: number, reason: string, close = true): void {
    if (this.#done()) return;
    if (close) this.deps.socket.close(code, reason);
    const streaming = this.#phase === 'streaming';
    this.#phase = 'ended';
    const failure = new RelaySessionError(reason, code);
    this.#failure = failure;
    this.#waiting.length = 0;
    for (const [, waiting] of this.#pending) waiting.reject(failure);
    this.#pending.clear();
    this.#refused?.(failure);
    // A pairing session's caller is waiting on `paired()`, not on `ready()`. Settling only the one
    // it is not holding would leave it waiting forever on a session that is already over.
    this.#refusePairing?.(failure);
    // A stream that dies without a sealed close still ENDED, and its consumer is entitled to know
    // in the same shape as an orderly close. `1006` is the browser's own word for "abnormally, with
    // no close frame", which is exactly what this is.
    if (streaming) {
      this.#streamClosed = { code: 1006, reason };
      this.#announceStreamClosed(this.#streamClosed);
    }
  }

  /** End without closing: for the two cases where the far end is already closing this socket. */
  #quietly(code: number, reason: string): void {
    this.#fail(code, reason, false);
  }
}
