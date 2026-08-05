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
 * What the daemon may say back.
 *
 * `headers` and `body` are optional here even though the reference daemon always
 * sends both. An ABSENT field is unambiguous — no headers, empty body — and §14's
 * discipline is aimed at what cannot be read, not at what was plainly not there.
 * A field of the wrong TYPE is still a refusal, which is the part that matters.
 */
export const RelayTunnelDaemonMessageSchema = z.discriminatedUnion('t', [
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
]);
export type RelayTunnelDaemonMessage = z.infer<typeof RelayTunnelDaemonMessageSchema>;

/** What this side sends. Exactly the two shapes §14 defines for a client. */
export type RelayTunnelClientMessage =
  | { readonly t: 'auth'; readonly protocol: typeof RELAY_PROTOCOL_ID; readonly deviceToken: string }
  | {
      readonly t: 'req';
      readonly id: number;
      readonly method: string;
      readonly path: string;
      readonly query?: readonly (readonly [string, string])[];
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
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

export interface RelayClientSessionDependencies {
  readonly crypto: RelayCrypto;
  /** The fingerprint the pairing QR carried. Nothing else is ever accepted in its place. */
  readonly daemonId: string;
  /** The device grant pairing issued. Sent once, at sequence 1, inside the channel. */
  readonly deviceToken: string;
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
}

type SessionPhase = 'awaiting-ready' | 'awaiting-hello' | 'awaiting-auth' | 'serving' | 'ended';

interface PendingRequest {
  readonly resolve: (answer: RelayTunnelAnswer) => void;
  readonly reject: (reason: Error) => void;
}

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

  constructor(private readonly deps: RelayClientSessionDependencies) {
    this.#ready = new Promise<RelayClientSession>((resolve, reject) => {
      this.#authenticated = resolve;
      this.#refused = reject;
    });
    // A rejection nobody has awaited yet is not an unhandled rejection: the caller
    // always awaits `ready()`, and this keeps a refusal that arrives first quiet.
    this.#ready.catch(() => undefined);
  }

  /** Resolves when the daemon has accepted this browser's device grant, and not before. */
  ready(): Promise<RelayClientSession> {
    return this.#ready;
  }

  /** True only while the session is keyed, authenticated and has not been refused. */
  live(): boolean {
    return this.#phase === 'serving';
  }

  /** The heartbeat this side owes: text, so the edge answers it without waking anything. */
  heartbeat(): void {
    if (this.#phase === 'ended') return;
    this.deps.socket.sendText(HEARTBEAT_REQUEST);
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
    if (this.#phase === 'ended') return;
    this.#fail(RELAY_CLOSE_CODES.protocolError, reason);
    this.deps.socket.close(1000, 'session closed');
  }

  /** The carrier dropped the socket. Every session on it is gone, which is what §9 says. */
  carrierClosed(code: number, reason: string): void {
    if (this.#phase === 'ended') return;
    this.#fail(code, reason === '' ? 'the carrier closed this session' : reason);
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
    this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, 'the carrier sent an unknown text message');
  }

  /**
   * One binary message from the carrier: exactly one frame, or the end of it.
   *
   * Resolves once everything this frame caused has been written, so an adapter can
   * hand frames over one at a time and be sure the second is never handled before
   * the first has finished.
   */
  async receiveBinary(bytes: Uint8Array): Promise<void> {
    await this.#handle(bytes);
    await this.#outbox;
  }

  async #handle(bytes: Uint8Array): Promise<void> {
    if (this.#phase === 'ended') return;
    const decoded = decodeFrame(bytes);
    if (!decoded.ok) {
      this.#refuseSocket(decoded.code, decoded.reason);
      return;
    }
    const frame = decoded.frame;
    if (frame.kind === FRAME_KINDS.control) {
      await this.#onControl(frame);
      return;
    }
    const sessionId = this.#sessionId;
    if (sessionId === undefined || frame.sessionId.text !== sessionId.text) {
      this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, 'a frame named a session this browser does not hold');
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
      this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, 'unparseable rendezvous control');
      return;
    }
    switch (message.t) {
      case 'ready':
        await this.#onReady(frame.sessionId);
        return;
      case 'closed':
        this.#fail(message.code, `the rendezvous ended this session: ${message.code} ${message.reason}`);
        return;
      case 'error':
        // The rendezvous closes the socket immediately after this, so closing from
        // here as well would race its own close frame. The reason is what matters.
        this.#fail(message.code, `the rendezvous refused this browser: ${message.code} ${message.reason}`);
        return;
      default:
        // `challenge`, `claim`, `claimed` and `open` belong to the daemon role.
        // Receiving one means this is not the conversation the browser is in.
        this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, `unexpected rendezvous control: ${message.t}`);
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
      this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, 'a second ready arrived for this socket');
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
    this.#phase = 'awaiting-auth';
    this.#sendRecord({ t: 'auth', protocol: RELAY_PROTOCOL_ID, deviceToken: this.deps.deviceToken });
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
    this.#channel = opened.state;
    this.#consume();
    const message = decodeTunnelDaemonMessage(opened.plaintext);
    if (message === null) {
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'unparseable tunnel record');
      return;
    }
    if (this.#phase === 'awaiting-auth') {
      if (message.t !== 'authenticated') {
        this.#fail(RELAY_CLOSE_CODES.protocolError, 'the daemon did not accept this device before answering');
        return;
      }
      this.#phase = 'serving';
      this.#authenticated?.(this);
      return;
    }
    if (message.t === 'authenticated') {
      this.#fail(RELAY_CLOSE_CODES.protocolError, 'this session is already authenticated');
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
        this.#channel = sealed.state;
        this.#send = recordSent(this.#send);
        this.deps.socket.send(encodeFrame(sealed.frame));
      }
    });
  }

  /**
   * End this session and refuse everything waiting on it.
   *
   * The first refusal is the one that is kept: a later close code caused by the
   * first would otherwise overwrite the reason somebody can act on.
   */
  #fail(code: number, reason: string): void {
    if (this.#phase === 'ended') return;
    this.#phase = 'ended';
    const failure = new RelaySessionError(reason, code);
    this.#failure = failure;
    this.#waiting.length = 0;
    for (const [, waiting] of this.#pending) waiting.reject(failure);
    this.#pending.clear();
    this.#refused?.(failure);
  }

  #refuseSocket(code: number, reason: string): void {
    this.#fail(code, reason);
    this.deps.socket.close(code, reason);
  }
}
