/**
 * The daemon's half of a rendezvous, as a state machine over one socket.
 *
 * **THE DAEMON DIALS OUT.** This is the first thing a reader doubts, so it is stated before anything
 * else: the rendezvous never connects inward. A daemon bound to `127.0.0.1` has no inbound route by
 * definition, and the only reason a relay can make it reachable is that the socket is opened from
 * behind the NAT, outbound, by the daemon itself. Everything below is what the daemon says on a
 * connection it made.
 *
 * The sequence, once: the rendezvous issues a challenge; the daemon signs it and claims the slot its
 * own fingerprint addresses; each client that arrives becomes a session with its own ephemeral keys;
 * and the records inside each session are the tunnel in `tunnel.ts`, dispatched into the daemon's own
 * route table.
 *
 * WHAT THIS MODULE REFUSES TO DO, deliberately, in every case where the alternative is a session that
 * looks healthy and is not:
 *
 * - **It will not sign a host it did not configure.** The claim transcript covers the host, and a
 *   challenge naming another one is either a misconfiguration or a hostile relay collecting a
 *   signature to squat the slot elsewhere. Both are worth stopping.
 * - **It will not answer a hello addressed to another daemon.** On a correct carrier that cannot
 *   happen, which is exactly why it is checked: on an incorrect one it is a misrouted session, and
 *   answering would key a channel to a peer that thinks it reached somebody else.
 * - **It will not accept a host token.** A relayed client authenticates with the device grant pairing
 *   gave it. The admin token is a host-local secret, and a daemon that honoured it over the internet
 *   would turn a leaked file into remote authority.
 * - **It will not repair a stream.** A bad tag, a sequence that is not the next one, a record for
 *   another session: the session ends. There is no resume in this protocol, and a carrier that
 *   silently lost frames would otherwise produce a conversation that is missing data and says so
 *   nowhere.
 *
 * The link holds no keys of its own beyond the session it is running: the durable identity is
 * supplied, and every session's record keys are derived per session and die with it.
 */

import {
  answerClientHandshake,
  type ChannelState,
  type ControlMessage,
  CREDIT_WINDOW_FRAMES,
  claimContextForChallenge,
  creditToReturn,
  type DaemonIdentity,
  decodeClientHello,
  decodeControlMessage,
  decodeCreditPayload,
  decodeFrame,
  encodeClaim,
  encodeControlMessage,
  encodeCreditPayload,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  fromBase64UrlFixed,
  grantCredit,
  HANDSHAKE_FRAME_SEQUENCE,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  MAX_PLAINTEXT_BYTES,
  maySend,
  NONCE_BYTES,
  newReceiveWindow,
  newSendWindow,
  openChannel,
  openRecord,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type ReceiveWindow,
  type RelayCloseCode,
  type RelayCrypto,
  type RelayFrame,
  recordConsumed,
  recordCredited,
  recordSent,
  type SendWindow,
  type SessionId,
  sealRecord,
  signRendezvousClaim,
} from '@ferretry/relay';
import type { ApiRequest, ApiResponse } from '../api/http.ts';
import {
  decodeTunnelClientMessage,
  encodeTunnelMessage,
  type RelayTunnelClientMessage,
  type RelayTunnelDaemonMessage,
  type RelayTunnelRequest,
  tunnelApiRequest,
  tunnelResponseMessage,
} from './tunnel.ts';

/** The socket the link talks through. One method per thing a WebSocket can be asked to do. */
export interface RelayLinkSocket {
  send(bytes: Uint8Array): void;
  sendText(text: string): void;
  close(code: number, reason: string): void;
}

/** The daemon's own route table, as the one function a relayed request needs from it. */
export type RelayApiDispatch = (request: ApiRequest) => Promise<ApiResponse>;

/**
 * Who a device token belongs to.
 *
 * A device, or nobody. The host's own tokens are deliberately not resolvable through this port: a
 * relayed peer presenting one is refused like any stranger.
 */
export interface RelayDeviceDirectory {
  identifyDevice(token: string): string | undefined;
}

export interface RelayLinkDependencies {
  readonly crypto: RelayCrypto;
  readonly identity: DaemonIdentity;
  /** The host of the configured rendezvous URL, exactly as that URL spells it. In the signature. */
  readonly relayHost: string;
  readonly socket: RelayLinkSocket;
  readonly dispatch: RelayApiDispatch;
  readonly devices: RelayDeviceDirectory;
}

/** What the link is doing, for a surface that has to say whether this daemon is reachable at all. */
export interface RelayLinkReport {
  readonly claimed: boolean;
  readonly sessions: number;
  /** The last refusal this link made or was told about. Absent is "nothing has gone wrong yet". */
  readonly lastRefusal?: string;
}

type SessionPhase = 'awaiting-hello' | 'awaiting-auth' | 'serving';

interface LinkSession {
  readonly sessionId: SessionId;
  phase: SessionPhase;
  channel: ChannelState | undefined;
  deviceToken: string | undefined;
  send: SendWindow;
  receive: ReceiveWindow;
  /** Request identifiers already answered or in flight. A repeat ends the session. */
  readonly answered: Set<number>;
  /** Answers waiting for the peer to return credit. Bounded by the peer's own send window. */
  readonly waiting: Uint8Array[];
}

export class RelayLink {
  readonly #sessions = new Map<string, LinkSession>();
  #claimed = false;
  #lastRefusal: string | undefined;
  /** Serialises everything that assigns a sequence number, because a record's nonce IS its sequence
   *  and two sealers racing would produce two records under one nonce. */
  #outbox: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RelayLinkDependencies) {}

  report(): RelayLinkReport {
    return {
      claimed: this.#claimed,
      sessions: this.#sessions.size,
      ...(this.#lastRefusal === undefined ? {} : { lastRefusal: this.#lastRefusal }),
    };
  }

  /** The heartbeat this side owes: text, so the edge can answer it without waking anything. */
  heartbeat(): void {
    this.deps.socket.sendText(HEARTBEAT_REQUEST);
  }

  /**
   * A text message from the carrier.
   *
   * Exactly two strings are legal. Anything else is a protocol error rather than a curiosity to log:
   * a carrier improvising on a channel this narrow is not a carrier this daemon can reason about.
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
   * One binary message from the carrier: exactly one frame, or the end of the connection.
   *
   * It resolves once everything this frame caused has been written, including answers that were
   * waiting on credit. A caller that has awaited this has therefore seen the whole effect of the
   * frame, which is what lets the socket adapter hand frames over one at a time and be sure the
   * second is never handled before the first has finished.
   */
  async receiveBinary(bytes: Uint8Array): Promise<void> {
    await this.#handle(bytes);
    await this.#outbox;
  }

  async #handle(bytes: Uint8Array): Promise<void> {
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
    const session = this.#sessions.get(frame.sessionId.text);
    if (session === undefined) {
      this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, 'a frame named no live session');
      return;
    }
    if (frame.kind === FRAME_KINDS.credit) {
      this.#onCredit(session, frame);
      return;
    }
    if (frame.kind === FRAME_KINDS.handshake) {
      await this.#onHandshake(session, frame);
      return;
    }
    await this.#onRecord(session, frame);
  }

  // ─── rendezvous control ─────────────────────────────────────────────────────────────────────

  async #onControl(frame: RelayFrame): Promise<void> {
    const message = decodeControlMessage(frame.payload);
    if (message === null) {
      this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, 'unparseable rendezvous control');
      return;
    }
    switch (message.t) {
      case 'challenge':
        await this.#onChallenge(message);
        return;
      case 'claimed':
        this.#claimed = true;
        return;
      case 'open':
        this.#onOpen(frame.sessionId);
        return;
      case 'closed':
        this.#sessions.delete(frame.sessionId.text);
        this.#lastRefusal = `the rendezvous ended a session: ${message.code} ${message.reason}`;
        return;
      case 'error':
        // The rendezvous closes the socket immediately after this, so there is nothing to do but
        // keep the reason. Closing from here as well would race its own close frame.
        this.#lastRefusal = `the rendezvous refused this daemon: ${message.code} ${message.reason}`;
        return;
      default:
        // `ready` and `claim` belong to the other two roles. Receiving one means this is not the
        // conversation the daemon thinks it is in.
        this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, `unexpected rendezvous control: ${message.t}`);
    }
  }

  /**
   * Answer the challenge, or refuse to.
   *
   * The host in the challenge must be the host this daemon dialled. A signature over somebody else's
   * host is exactly what a hostile relay would like to collect, so the refusal is not politeness — it
   * is the reason the host is in the transcript at all.
   */
  async #onChallenge(message: Extract<ControlMessage, { t: 'challenge' }>): Promise<void> {
    if (this.#claimed) {
      this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, 'a second challenge arrived after the claim');
      return;
    }
    const challenge = fromBase64UrlFixed(message.nonce, NONCE_BYTES);
    if (challenge === null) {
      this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, 'the challenge nonce is malformed');
      return;
    }
    const context = claimContextForChallenge(this.deps.identity.daemonId, this.deps.relayHost, message.host, challenge);
    if (context === null) {
      this.#refuseSocket(
        RELAY_CLOSE_CODES.protocolError,
        `the rendezvous named host ${JSON.stringify(message.host)}, which this daemon did not configure`,
      );
      return;
    }
    const claim = await signRendezvousClaim(this.deps.crypto, this.deps.identity, context);
    this.#sendFrame({
      kind: FRAME_KINDS.control,
      sessionId: RENDEZVOUS_SESSION_ID,
      sequence: 0,
      payload: encodeControlMessage({ t: 'claim', protocol: RELAY_PROTOCOL_ID, ...encodeClaim(claim) }),
    });
  }

  #onOpen(sessionId: SessionId): void {
    if (this.#sessions.has(sessionId.text)) {
      // A second `open` for a live session means the carrier and this daemon disagree about what is
      // running. Ending the session it named is narrower than dropping the socket, and keeping the
      // old one keyed while a new client believes it opened that identifier is not an option.
      this.#endSession(sessionId, RELAY_CLOSE_CODES.protocolError, 'this session identifier is already live');
      return;
    }
    this.#sessions.set(sessionId.text, {
      sessionId,
      phase: 'awaiting-hello',
      channel: undefined,
      deviceToken: undefined,
      send: newSendWindow(),
      receive: newReceiveWindow(),
      answered: new Set(),
      waiting: [],
    });
  }

  // ─── one session ────────────────────────────────────────────────────────────────────────────

  #onCredit(session: LinkSession, frame: RelayFrame): void {
    const frames = decodeCreditPayload(frame.payload);
    if (frames === null) {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.flowViolation, 'malformed credit');
      return;
    }
    const granted = grantCredit(session.send, frames);
    if (granted.allowed === session.send.allowed) {
      // A grant that changes nothing is a violation on this side of the carrier too: the rendezvous
      // refuses to forward one, so a grant that arrives and does nothing means the peer and the
      // carrier disagree about the window, and guessing which is right is not available.
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.flowViolation, 'credit grant had no effect');
      return;
    }
    session.send = granted;
    this.#flush(session);
  }

  async #onHandshake(session: LinkSession, frame: RelayFrame): Promise<void> {
    if (session.phase !== 'awaiting-hello' || frame.sequence !== HANDSHAKE_FRAME_SEQUENCE) {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'a handshake arrived out of turn');
      return;
    }
    const hello = decodeClientHello(frame.payload);
    if (hello === null) {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'unparseable client hello');
      return;
    }
    const answered = await answerClientHandshake(this.deps.crypto, this.deps.identity, session.sessionId, hello);
    if (!answered.ok) {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, answered.reason);
      return;
    }
    this.#consume(session);
    session.channel = openChannel(session.sessionId, answered.keys, 'daemon');
    session.phase = 'awaiting-auth';
    // The answer occupies sequence 0 of this direction, which is why it is sent as a frame rather
    // than through the record path: it is the one end-to-end frame that is not a record.
    this.#sendSessionFrame(session, {
      kind: FRAME_KINDS.handshake,
      sessionId: session.sessionId,
      sequence: HANDSHAKE_FRAME_SEQUENCE,
      payload: encodeHandshakeMessage(answered.hello),
    });
  }

  async #onRecord(session: LinkSession, frame: RelayFrame): Promise<void> {
    const channel = session.channel;
    if (channel === undefined) {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'a record arrived before the handshake');
      return;
    }
    const opened = await openRecord(this.deps.crypto, channel, frame);
    if (!opened.ok) {
      this.#endSession(session.sessionId, opened.code, opened.reason);
      return;
    }
    session.channel = opened.state;
    this.#consume(session);
    const message = decodeTunnelClientMessage(opened.plaintext);
    if (message === null) {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'unparseable tunnel record');
      return;
    }
    if (session.phase === 'awaiting-auth') {
      this.#authenticate(session, message);
      return;
    }
    if (message.t !== 'req') {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'this session is already authenticated');
      return;
    }
    await this.#serve(session, message);
  }

  /**
   * The client's credential, inside the encrypted channel and nowhere else.
   *
   * A device grant, or the session ends. The refusal is `4403` and it is deliberately not
   * distinguishable on the wire from any other close a relay can see: an operator watching the
   * carrier learns that a session ended, not that a token was wrong.
   */
  #authenticate(session: LinkSession, message: RelayTunnelClientMessage): void {
    if (message.t !== 'auth') {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'the first record must authenticate');
      return;
    }
    const device = this.deps.devices.identifyDevice(message.deviceToken)?.trim();
    if (device === undefined || device === '') {
      // An unattributable answer from the directory is a refusal, not a nameless success: a device
      // nobody can name would be journalled as `device` and authorized as an operator.
      this.#lastRefusal = 'a relayed client presented a credential this daemon does not know';
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.authRejected, 'unknown device credential');
      return;
    }
    session.deviceToken = message.deviceToken;
    session.phase = 'serving';
    this.#sendRecord(session, { t: 'authenticated', protocol: RELAY_PROTOCOL_ID });
  }

  async #serve(session: LinkSession, request: RelayTunnelRequest): Promise<void> {
    const deviceToken = session.deviceToken;
    if (deviceToken === undefined) {
      // Unreachable while `serving` implies a token, and checked anyway: the alternative to this
      // branch is a request dispatched with no credential at all.
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'this session holds no credential');
      return;
    }
    if (session.answered.has(request.id)) {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'a request identifier was reused');
      return;
    }
    session.answered.add(request.id);
    const response = await this.deps.dispatch(tunnelApiRequest(request, deviceToken));
    this.#sendRecord(session, tunnelResponseMessage(request.id, response));
  }

  // ─── sending ────────────────────────────────────────────────────────────────────────────────

  /** Count one consumed end-to-end frame and return credit once half a window is owed. */
  #consume(session: LinkSession): void {
    session.receive = recordConsumed(session.receive);
    const owed = creditToReturn(session.receive);
    if (owed === 0) return;
    session.receive = recordCredited(session.receive, owed);
    this.#sendSessionFrame(session, {
      kind: FRAME_KINDS.credit,
      sessionId: session.sessionId,
      sequence: 0,
      payload: encodeCreditPayload(owed),
    });
  }

  #sendRecord(session: LinkSession, message: RelayTunnelDaemonMessage): void {
    const plaintext = encodeTunnelMessage(message);
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES || session.waiting.length >= CREDIT_WINDOW_FRAMES) {
      // Neither is reachable through a peer that honours the protocol — `tunnelResponseMessage`
      // refuses an oversized answer and the carrier bounds how many requests can be outstanding —
      // and both would otherwise become an unbounded buffer or a record the carrier drops. Ending
      // the session is the fail-closed reading.
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'this session cannot carry its own answer');
      return;
    }
    session.waiting.push(plaintext);
    this.#flush(session);
  }

  /**
   * Seal and send whatever the window now allows.
   *
   * Queued on the link's outbox rather than run inline, because sealing is asynchronous and the
   * record nonce IS the sequence number: two flushes in flight would hand the same nonce to two
   * records under one key, which is the one arithmetic mistake AES-GCM does not survive.
   */
  #flush(session: LinkSession): void {
    this.#outbox = this.#outbox.then(async () => {
      while (session.waiting.length > 0 && maySend(session.send)) {
        const channel = session.channel;
        const plaintext = session.waiting[0];
        if (channel === undefined || plaintext === undefined) return;
        const sealed = await sealRecord(this.deps.crypto, channel, plaintext);
        if (!sealed.ok) {
          this.#endSession(session.sessionId, sealed.code, sealed.reason);
          return;
        }
        session.waiting.shift();
        session.channel = sealed.state;
        session.send = recordSent(session.send);
        this.deps.socket.send(encodeFrame(sealed.frame));
      }
    });
  }

  /** A session-scoped frame that is not a record: the handshake answer, and credit. */
  #sendSessionFrame(session: LinkSession, frame: RelayFrame): void {
    if (frame.kind === FRAME_KINDS.credit) {
      this.#sendFrame(frame);
      return;
    }
    if (!maySend(session.send)) {
      // The handshake answer is the first frame of a fresh window, so this cannot happen against a
      // carrier that granted the window it published. It is refused rather than sent anyway: a frame
      // over the allowance is `4430` from the rendezvous, which ends the session either way.
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.flowViolation, 'no credit for the handshake answer');
      return;
    }
    session.send = recordSent(session.send);
    this.#sendFrame(frame);
  }

  #sendFrame(frame: RelayFrame): void {
    this.deps.socket.send(encodeFrame(frame));
  }

  /** End one session without dropping the socket. The other sessions on this link are unaffected. */
  #endSession(sessionId: SessionId, code: RelayCloseCode, reason: string): void {
    this.#sessions.delete(sessionId.text);
    this.#lastRefusal = `session ${code}: ${reason}`;
    this.#sendFrame({
      kind: FRAME_KINDS.control,
      sessionId,
      sequence: 0,
      payload: encodeControlMessage({ t: 'closed', code, reason }),
    });
  }

  /** End the whole link. Every session on it is gone with the socket, which is what §9 says. */
  #refuseSocket(code: RelayCloseCode, reason: string): void {
    this.#lastRefusal = `link ${code}: ${reason}`;
    this.#sessions.clear();
    this.deps.socket.close(code, reason);
  }
}
