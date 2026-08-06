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

import { RELAY_SESSION_CONCLUDED_CLOSE_CODE, RELAY_SESSION_CONCLUDED_CLOSE_REASON } from '@ferretry/protocol';
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
import { SOCKET_CLOSES, type SocketDownstream, type SocketHandler, type SocketUpgradeDecision } from '../api/socket.ts';
import type { PairingRedemption, RelayPairingAttempt } from '../pairing/index.ts';
import {
  decodeTunnelClientMessage,
  encodeTunnelMessage,
  type RelaySessionCloseCode,
  type RelayTunnelClientMessage,
  type RelayTunnelDaemonMessage,
  type RelayTunnelData,
  type RelayTunnelPair,
  type RelayTunnelRequest,
  type RelayTunnelStream,
  tunnelApiRequest,
  tunnelDataFrame,
  tunnelDataMessage,
  tunnelResponseMessage,
  tunnelStreamRequest,
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

/**
 * The daemon's own SOCKET route table, as the one function a relayed stream needs from it.
 *
 * It is the dispatcher the bound address already serves, handed over rather than rebuilt: the same
 * routes, the same authorization boundary, the same per-capability guard. A second table here would
 * be a second privilege model, and the one thing worse than a stream a relay cannot carry is a stream
 * it carries past a check the direct surface makes.
 */
export type RelayStreamDispatch = (request: ApiRequest) => Promise<SocketUpgradeDecision>;

/**
 * Redeeming a pairing code, and nothing else.
 *
 * Deliberately NOT the API dispatch. A pre-credential session must reach the pairing state machine
 * without constructing a request, because a relayed session that could build one would be an
 * anonymous caller at a route table — and `POST /v1/pair` is public on that table. This port is how
 * the exchange happens with no route involved at all.
 */
export interface RelayPairingRedeemer {
  redeemOverRelay(attempt: RelayPairingAttempt): Promise<PairingRedemption>;
}

/** A cancellable one-shot timer, so the link never holds a runtime timer handle of its own. */
export interface RelayLinkTimer {
  cancel(): void;
}

export interface RelayLinkScheduler {
  after(milliseconds: number, action: () => void): RelayLinkTimer;
}

/**
 * How long a session may sit without presenting a credential, counted from the moment it OPENED.
 *
 * That window is the one an internet stranger can hold open against a fingerprint that is public by
 * design — it is in the pairing QR. A session that occupies a slot and then says nothing is either a
 * client that failed or somebody squatting, and neither is worth waiting on.
 *
 * IT IS ARMED BY THE `open`, NOT BY THE HANDSHAKE, and that is the correction rather than a
 * preference. It used to start at the handshake answer, so `awaiting-hello` had no deadline at all:
 * a peer could open a session, send no hello, answer heartbeats and hold pre-auth capacity FOREVER.
 * Two such sockets denied every honest session on the link — requests, streams and pairing alike —
 * with `4429`, for the price of two idle connections and a fingerprint anybody who saw a QR knows.
 * One window covering open-through-credential closes that and is also the tighter reading: the
 * handshake is part of what a client owes before it has said who it is, not a reason to be granted a
 * second ten seconds.
 */
export const RELAY_CREDENTIAL_DEADLINE_MS = 10_000;

/**
 * Sessions per link that may be pre-credential at once, before a further arrival is refused `4429`.
 *
 * IT WAS TWO, AND TWO WAS SIZED FOR A WORLD §14 REPLACED. The reasoning was "one honest arrival plus
 * one overlapping retry", which is exactly right for a link whose clients open one session each —
 * and §14 gives every live feed and every terminal a session of ITS OWN. An ordinary tab now opens a
 * request session, an event stream and a terminal stream, and a second device does the same, so a
 * bound of two refuses honest work that did nothing wrong. The refusal is retryable, but this branch
 * renders it nowhere and the event feed swallows it, so what an owner sees is a live feed that
 * silently never opens.
 *
 * SIX, AND THE ARITHMETIC RATHER THAN A FEELING. The ordinary burst is three per device, and §9
 * names two devices — "a phone and a laptop, say" — so six is what two honest devices arriving
 * together actually ask for, under the `maxSessions: 8` §5 publishes so this never promises capacity
 * the rendezvous will refuse anyway.
 *
 * RESERVING SLOTS FOR ESTABLISHED SESSIONS RESERVES NOTHING, and an earlier draft of this comment
 * chose four on exactly that mistake — "half of eight, so a squatter cannot reach the other half".
 * There is no other half: EVERY session begins pre-credential, so a bound that refuses new arrivals
 * protects established sessions only in the sense that it cannot create any.
 *
 * RAISING IT NARROWS THE SQUAT RATHER THAN WIDENING IT. With {@link RELAY_CREDENTIAL_DEADLINE_MS}
 * armed from the `open`, holding every slot costs one fresh arrival per slot per window — six per ten
 * seconds, 36 per minute, against §9's sliding 30-per-minute admission. So full occupancy is not
 * sustainable at six and is comfortably sustainable at four (24 per minute), which is the whole
 * reason this is not the smaller number.
 *
 * WHAT IT STILL DOES NOT BUY, said here because the arithmetic above invites the stronger claim: the
 * arrival limiter is per-RENDEZVOUS and shared, and it refuses whoever arrives when the window is
 * full. An attacker willing to spend all 30 arrivals holds five of these six and denies honest
 * clients at the rendezvous instead of here — the refusal moves, the outcome does not. No value
 * chosen in this file fixes that; it is `packages/relay`'s admission accounting, which has no
 * per-peer identity to charge. What six does buy is that the ordinary squatter — the one spending
 * the 24 per minute that fully denied a bound of four — now leaves two slots and six arrivals free,
 * and the maximal one has to consume the entire budget, which is loud enough to notice.
 */
export const MAX_PRE_CREDENTIAL_SESSIONS = 6;

/**
 * The most un-sent stream backlog one session may hold before its overflow policy decides.
 *
 * It sits ABOVE the one-mebibyte policy every mounted stream already applies to its own buffered
 * bytes, so an honest handler always trips its own rule first and this never fires. It exists for the
 * handler that has no rule: a bound that only the domain enforces is a bound one new subsystem can
 * forget, and the failure mode is daemon memory growing with a viewer that stopped reading.
 */
export const RELAY_STREAM_MAX_BUFFERED_BYTES = 2 * 1_024 * 1_024;

/**
 * What this link's own overflow policies close a stream with.
 *
 * They are WebSocket close codes from §14's stream taxonomy, not daemon constants, and they are
 * spelled here rather than borrowed from a mounted subsystem: the relay must not import the event
 * feed's vocabulary to describe a rule it applies to every stream. A relayed viewer reads the same
 * codes a direct one does, and the code travels INSIDE the channel because a reason a viewer left is
 * content — a relay that could read close reasons could read why people stop watching.
 */
const RELAY_STREAM_CLOSES = {
  /** One frame is larger than a record can carry, and its stream may neither drop nor split it. */
  oversize: { code: 1009, reason: 'a stream frame exceeds one relay record' },
  /** The viewer stopped keeping up and the stream may not lose what it would have to drop. */
  slowReader: { code: 1013, reason: 'stream reader fell behind' },
} as const;

export interface RelayLinkDependencies {
  readonly crypto: RelayCrypto;
  readonly identity: DaemonIdentity;
  /** The host of the configured rendezvous URL, exactly as that URL spells it. In the signature. */
  readonly relayHost: string;
  readonly socket: RelayLinkSocket;
  readonly dispatch: RelayApiDispatch;
  readonly sockets: RelayStreamDispatch;
  readonly devices: RelayDeviceDirectory;
  readonly pairing: RelayPairingRedeemer;
  readonly scheduler: RelayLinkScheduler;
}

/** What the link is doing, for a surface that has to say whether this daemon is reachable at all. */
export interface RelayLinkReport {
  readonly claimed: boolean;
  readonly sessions: number;
  /** The last refusal this link made or was told about. Absent is "nothing has gone wrong yet". */
  readonly lastRefusal?: string;
}

/**
 * WHAT A SESSION IS DOING, and the fact that it can only ever be doing one thing.
 *
 * `awaiting-credential` is the fork: the record that arrives there decides whether this session
 * serves requests, carries one stream, or redeems one pairing code — and none of the three terminal
 * states has an edge to another. "A stream session should not issue requests" is a rule somebody has
 * to remember; a session that cannot leave `streaming` is a rule nothing can break.
 *
 * `concluding` is the moment between an outcome being decided and the close that follows it, and it
 * exists so a record arriving in that window is refused rather than racing a session that is already
 * over.
 */
type SessionPhase = 'awaiting-hello' | 'awaiting-credential' | 'serving' | 'streaming' | 'concluding';

/**
 * One record waiting for credit, and whether it is a stream's PAYLOAD.
 *
 * The flag exists for one decision and is worth the field. When a stream closes because its viewer
 * fell behind, whatever payload is still queued is already known-lost — the close is what says so —
 * and holding it would make the sealed close wait for credit to drain records nobody will ever read.
 * So payload is discarded there and the close is not. Nothing else in this module may drop a record:
 * an answer, an acceptance or a sealed outcome that vanished would be a session that ended saying
 * something different from what happened.
 */
interface PendingRecord {
  readonly plaintext: Uint8Array;
  readonly payload: boolean;
}

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
  readonly waiting: PendingRecord[];
  /**
   * The record a seal on the outbox has already captured, while it is still sealing it.
   *
   * It stays in {@link waiting} — `#buffered` must keep counting it and `#flush` still removes it
   * from the front — and it is the one record `#discardStreamPayload` may not take away, because
   * removing it would leave a produced ciphertext with nothing to remove and a sealed sequence
   * number with nothing on the wire. `#flush` owns both writes and clears it in the same breath as
   * the await it spans.
   */
  sealing: PendingRecord | undefined;
  /** The one live stream this session carries, once it carries one. */
  stream: SocketHandler | undefined;
  /** Armed when the channel is keyed, cancelled by the credential record that beats it. */
  credentialDeadline: RelayLinkTimer | undefined;
  /**
   * That this session is ending, held until the sealed outcome has ACTUALLY crossed.
   *
   * Set when an outcome is decided and cleared by the close that follows it. It exists because
   * "decided" and "delivered" are not the same moment: the outcome is a queued record and a queue
   * only drains while the peer's credit allows.
   *
   * A FLAG RATHER THAN THE REASON, and the difference is a disclosure. It held the sentence that went
   * into the `closed` control — an UNSEALED frame — so a client's own close text and this daemon's
   * own close taxonomy both reached the carrier in the clear. There is nothing here to leak now; see
   * {@link RelayLink.conclude}.
   */
  owesConclusion: boolean;
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
      case 'closed': {
        // Whatever this session was carrying goes with it. A stream handler holds a redraw timer and
        // a viewer slot armed against a peer the rendezvous has just told us is gone, and forgetting
        // the session without releasing it would leave both firing at nothing.
        const ended = this.#sessions.get(frame.sessionId.text);
        if (ended !== undefined) this.#forget(ended);
        this.#sessions.delete(frame.sessionId.text);
        this.#lastRefusal = `the rendezvous ended a session: ${message.code} ${message.reason}`;
        return;
      }
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
    // A session that has not presented a credential yet costs this daemon a slot, and anybody who saw
    // a QR knows the fingerprint that addresses this rendezvous. The bound is above; an arrival past
    // it is refused as BUSY rather than as an error, because a client opening several at once did
    // nothing wrong and should retry.
    if (this.#preCredentialSessions() >= MAX_PRE_CREDENTIAL_SESSIONS) {
      this.#endSession(sessionId, RELAY_CLOSE_CODES.rendezvousBusy, 'too many sessions are awaiting a credential');
      return;
    }
    const session: LinkSession = {
      sessionId,
      phase: 'awaiting-hello',
      channel: undefined,
      deviceToken: undefined,
      send: newSendWindow(),
      receive: newReceiveWindow(),
      answered: new Set(),
      waiting: [],
      sealing: undefined,
      stream: undefined,
      credentialDeadline: undefined,
      owesConclusion: false,
    };
    this.#sessions.set(sessionId.text, session);
    // ARMED HERE, WHICH IS THE WHOLE POINT OF THE SLOT ABOVE HAVING A BOUND. A slot with no deadline
    // on it is a slot somebody can hold for as long as they keep a socket open.
    session.credentialDeadline = this.#armCredentialDeadline(session);
  }

  /**
   * The one window a session has to say what it is for, from `open` to its credential record.
   *
   * The session is RE-READ rather than closed over: by the time this fires it may have presented a
   * credential, been ended by the rendezvous, or been replaced by a new one under the same
   * identifier, and only the live one still occupying a pre-credential slot is this timer's to end.
   */
  #armCredentialDeadline(session: LinkSession): RelayLinkTimer {
    return this.deps.scheduler.after(RELAY_CREDENTIAL_DEADLINE_MS, () => {
      const live = this.#sessions.get(session.sessionId.text);
      if (live !== session || (live.phase !== 'awaiting-hello' && live.phase !== 'awaiting-credential')) return;
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'no credential arrived before the deadline');
    });
  }

  #preCredentialSessions(): number {
    let pending = 0;
    for (const session of this.#sessions.values())
      if (session.phase === 'awaiting-hello' || session.phase === 'awaiting-credential') pending += 1;
    return pending;
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
    // THE CREDENTIAL DEADLINE COVERS THIS AWAIT NOW, so it can end the session inside it. Arming at
    // the `open` is what made that reachable — the timer used to be armed AFTER this line, so nothing
    // could expire during a handshake — and the resumed continuation would otherwise key a channel,
    // set a phase over the `concluding` that `#forget` wrote, and put the handshake ANSWER on the wire
    // behind the `closed` control the timer already sent. That frame names no live session, and the
    // rendezvous answers one of those by closing the daemon's whole socket.
    //
    // Checked BEFORE `answered.ok`, deliberately: refusing a dead session with `#endSession` would
    // send a SECOND `closed` for it, which is the same violation reached politely.
    if (!this.#live(session)) return;
    if (!answered.ok) {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, answered.reason);
      return;
    }
    this.#consume(session);
    session.channel = openChannel(session.sessionId, answered.keys, 'daemon');
    session.phase = 'awaiting-credential';
    // NOTHING IS RE-ARMED HERE. The deadline this session is running against was armed by its `open`
    // and covers the handshake as well as the credential, so answering a hello buys no second window.
    // The record that presents a credential is what cancels it — see `#credential`.
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
    // The mirror of the check in `#onHandshake`, and for the same reason: this await is inside the
    // credential window too, so the deadline can end and delete the session while a record is being
    // decrypted. The continuation would then credit the peer, dispatch a credential against a session
    // the rendezvous has been told is over, or — because `#forget` left the phase `concluding` rather
    // than a mode this method serves — fall through and send a SECOND `closed` for it. Every one of
    // those puts a frame on the wire for a session that is not there.
    if (!this.#live(session)) return;
    if (!opened.ok) {
      this.#endSession(session.sessionId, opened.code, opened.reason);
      return;
    }
    // ONLY THIS DIRECTION'S COUNTER, and re-read rather than written from the copy captured above.
    // `ChannelState` carries BOTH sequences, and sealing runs on its own queue while this await is
    // suspended — so writing the whole value back would silently rewind whatever the sender advanced
    // in the meantime. A rewound RECEIVE counter is an intermittent `4420`; a rewound SEND counter is
    // silent and is a nonce reuse, because a record's sequence number IS its AEAD nonce.
    session.channel = { ...(session.channel ?? channel), receiveSequence: opened.state.receiveSequence };
    this.#consume(session);
    const message = decodeTunnelClientMessage(opened.plaintext);
    if (message === null) {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'unparseable tunnel record');
      return;
    }
    if (session.phase === 'awaiting-credential') {
      await this.#credential(session, message);
      return;
    }
    if (session.phase === 'streaming') {
      this.#onStreamRecord(session, message);
      return;
    }
    if (session.phase !== 'serving' || message.t !== 'req') {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'this session does not carry that message');
      return;
    }
    await this.#serve(session, message);
  }

  /**
   * The fork: one record, and the session is committed for life.
   *
   * Whichever of the three arrives, the deadline that was waiting for it is cancelled first — the
   * session has answered the only question that window was open for.
   */
  async #credential(session: LinkSession, message: RelayTunnelClientMessage): Promise<void> {
    session.credentialDeadline?.cancel();
    session.credentialDeadline = undefined;
    switch (message.t) {
      case 'auth':
        this.#authenticate(session, message.deviceToken);
        return;
      case 'stream':
        await this.#openStream(session, message);
        return;
      case 'pair':
        await this.#redeemPairing(session, message);
        return;
      default:
        this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'the first record must be a credential');
    }
  }

  /**
   * The client's credential, inside the encrypted channel and nowhere else.
   *
   * A device grant, or the session ends. The refusal is `4403` and it is deliberately not
   * distinguishable on the wire from any other close a relay can see: an operator watching the
   * carrier learns that a session ended, not that a token was wrong.
   */
  #authenticate(session: LinkSession, deviceToken: string): void {
    if (!this.#identify(session, deviceToken)) return;
    session.deviceToken = deviceToken;
    session.phase = 'serving';
    this.#sendRecord(session, { t: 'authenticated', protocol: RELAY_PROTOCOL_ID });
  }

  /**
   * Resolve a device grant, or end the session having said nothing about which one it was.
   *
   * Shared by the request and stream modes so a stream cannot acquire a softer answer than a request:
   * an unknown token is `4403` in both, and a host admin token resolves in neither, because the
   * directory this asks holds device grants only.
   */
  #identify(session: LinkSession, deviceToken: string): boolean {
    const device = this.deps.devices.identifyDevice(deviceToken)?.trim();
    if (device !== undefined && device !== '') return true;
    // An unattributable answer from the directory is a refusal, not a nameless success: a device
    // nobody can name would be journalled as `device` and authorized as an operator.
    this.#lastRefusal = 'a relayed client presented a credential this daemon does not know';
    this.#endSession(session.sessionId, RELAY_CLOSE_CODES.authRejected, 'unknown device credential');
    return false;
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
    const response = await this.deps.dispatch(tunnelApiRequest(request, deviceToken, session.sessionId.text));
    this.#sendRecord(session, tunnelResponseMessage(request.id, response));
  }

  // ─── one pairing exchange ───────────────────────────────────────────────────────────────────

  /**
   * First contact, redeemed through a port and never through a route.
   *
   * ONE ATTEMPT, ONE SEALED OUTCOME, THEN THE SESSION CLOSES — success and failure alike, and with
   * the same number of records, so a relay operator counting frames learns nothing the exchange did
   * not intend to tell them. There is no edge from here to `serving`: a device that paired reconnects
   * as an ordinary request session with the token it was just issued.
   *
   * The session is marked `concluding` BEFORE the redemption is awaited, so a second record arriving
   * during it is refused rather than racing an exchange that is already spent.
   */
  async #redeemPairing(session: LinkSession, request: RelayTunnelPair): Promise<void> {
    session.phase = 'concluding';
    const result = await this.deps.pairing.redeemOverRelay({ code: request.code, deviceName: request.deviceName });
    this.#queue(
      session,
      result.kind === 'paired'
        ? { t: 'paired', protocol: RELAY_PROTOCOL_ID, response: result.response }
        : { t: 'pair-refused', protocol: RELAY_PROTOCOL_ID, reason: 'pairing_refused' },
    );
    this.#conclude(session);
  }

  // ─── one stream ─────────────────────────────────────────────────────────────────────────────

  /**
   * The credential record opens the stream in the same breath, and this is where it lands.
   *
   * It goes through the daemon's OWN socket route table — the dispatcher the bound address serves —
   * so a stream a direct viewer may not open a relayed viewer may not open either, refused by the
   * same guard in the same place. Everything a status can say is said here, BEFORE anything switches:
   * a stream that opened and instantly died could not tell "it is gone" from "the daemon broke".
   */
  async #openStream(session: LinkSession, request: RelayTunnelStream): Promise<void> {
    if (!this.#identify(session, request.deviceToken)) return;
    session.phase = 'concluding';
    const decision = await this.deps
      .sockets(tunnelStreamRequest(request, session.sessionId.text))
      .catch((): SocketUpgradeDecision => ({ outcome: 'unclaimed' }));
    if (decision.outcome !== 'accepted') {
      // `unclaimed` means no socket route serves that path at all, which for a client asking to
      // stream is the same answer as a route that was never there: a 404 it can act on.
      const refusal =
        decision.outcome === 'refused'
          ? { status: decision.response.status, body: decision.response.body }
          : { status: 404, body: 'no stream is served at this path' };
      this.#queue(session, { t: 'stream-refused', protocol: RELAY_PROTOCOL_ID, ...refusal });
      this.#conclude(session);
      return;
    }
    let handler: SocketHandler;
    try {
      handler = await decision.attach(this.#downstream(session));
    } catch {
      // The switch has not happened yet, so unlike the direct transport there is still a status to
      // send. Saying 500 is better than the close code the direct path is reduced to.
      this.#queue(session, {
        t: 'stream-refused',
        protocol: RELAY_PROTOCOL_ID,
        status: 500,
        body: 'the daemon failed to attach this stream',
      });
      this.#conclude(session);
      return;
    }
    session.stream = handler;
    session.deviceToken = request.deviceToken;
    session.phase = 'streaming';
    this.#queue(session, { t: 'stream-opened', protocol: RELAY_PROTOCOL_ID });
    // Queued before `open` runs, so the acceptance is ahead of the first frame the handler produces
    // however eagerly it produces one.
    await handler.open().catch(() => {
      this.#closeStream(session, SOCKET_CLOSES.unavailable.code, SOCKET_CLOSES.unavailable.reason);
    });
  }

  /** Records a stream session accepts once it is open: payload, or the client's own close. */
  #onStreamRecord(session: LinkSession, message: RelayTunnelClientMessage): void {
    if (message.t === 'data') {
      this.#onStreamData(session, message);
      return;
    }
    if (message.t !== 'stream-close') {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'this session carries one stream only');
      return;
    }
    // A deliberate leave is spelled differently from a network failure ON PURPOSE: the taxonomy
    // survives in both directions, so a daemon can tell a viewer that closed from one that vanished.
    //
    // The peer's own outcome has already crossed, so this session owes it no sealed record — and the
    // payload it has stopped reading goes with the same reasoning as above, which is also what keeps
    // this close from waiting on credit a departed viewer will never return.
    //
    // MARKED BEFORE THE HANDLER IS RELEASED, exactly as `#closeStream` marks it, and the asymmetry
    // between the two was a live defect rather than an inconsistency. `#sendStream` reads this phase
    // to decide whether a frame may still be queued, and a handler does not necessarily stop
    // producing the instant it is told to close: `TerminalStreamBridge.redraw` has already awaited a
    // pane capture and calls `downstream.send` when it resumes. Left in `streaming`, that late frame
    // was queued, sealed and put on the wire AFTER `#settle` had deleted this session and told the
    // rendezvous it was closed — and a daemon frame naming no live session does not end a session
    // there, it ends the DAEMON's SOCKET. So closing one relayed terminal tab tore down the whole
    // link: every other stream, the request session and the rendezvous claim with it.
    session.phase = 'concluding';
    this.#releaseStream(session);
    this.#discardStreamPayload(session);
    this.#conclude(session);
  }

  #onStreamData(session: LinkSession, message: RelayTunnelData): void {
    const frame = tunnelDataFrame(message);
    if (frame === null) {
      this.#endSession(session.sessionId, RELAY_CLOSE_CODES.protocolError, 'a stream record carried unusable bytes');
      return;
    }
    session.stream?.fromClient(frame);
  }

  /**
   * The live socket, as the domain's stream handlers already understand one.
   *
   * This is the whole bridge: the mounted event feed and the terminal bridge were written against
   * `SocketDownstream` and know nothing about transports, so a relay that can answer these three
   * questions carries them unmodified.
   */
  #downstream(session: LinkSession): SocketDownstream {
    return {
      send: frame => this.#sendStream(session, frame),
      close: (code, reason) => this.#closeStream(session, code, reason),
      // HONESTLY, and this is the load-bearing one. Every stream policy in this daemon reads this
      // number to decide whether a viewer is behind; a relay that answered `0` would report a viewer
      // as caught up forever and make every one of those policies vacuous over a carrier.
      bufferedBytes: () => this.#buffered(session),
    };
  }

  #buffered(session: LinkSession): number {
    let total = 0;
    for (const record of session.waiting) total += record.plaintext.byteLength;
    return total;
  }

  /**
   * One frame out, under the policy its own stream deserves.
   *
   * THE TWO POLICIES ARE NOT INTERCHANGEABLE and the frame's own shape chooses between them. Terminal
   * output is bytes and every frame is a complete redraw that the next one supersedes, so an
   * over-budget or backed-up frame is DROPPED and nothing is lost but latency. An event is text and a
   * unique journal record, so it may be neither dropped nor split, and the stream closes instead —
   * `1009` when the single frame is too large for a record, `1013` when the viewer has fallen behind.
   */
  #sendStream(session: LinkSession, frame: string | Uint8Array): number | undefined {
    if (session.phase !== 'streaming') return -1;
    const droppable = typeof frame !== 'string';
    const size = droppable ? frame.byteLength : frame.length;
    if (this.#buffered(session) > RELAY_STREAM_MAX_BUFFERED_BYTES) {
      if (droppable) return size;
      this.#closeStream(session, RELAY_STREAM_CLOSES.slowReader.code, RELAY_STREAM_CLOSES.slowReader.reason);
      return -1;
    }
    const message = tunnelDataMessage(frame);
    if (message === null) {
      if (droppable) return size;
      this.#closeStream(session, RELAY_STREAM_CLOSES.oversize.code, RELAY_STREAM_CLOSES.oversize.reason);
      return -1;
    }
    this.#queue(session, message, true);
    return size;
  }

  /** End one stream: release the handler, seal the taxonomy, then conclude the session it owned. */
  #closeStream(session: LinkSession, code: number, reason: string): void {
    if (session.phase !== 'streaming') return;
    // Marked first, so a handler whose own `close` calls back into this returns immediately instead
    // of sealing a second close for the same stream.
    session.phase = 'concluding';
    this.#releaseStream(session);
    // The close is what makes this loss explicit, so the frames it supersedes go before it is queued
    // — otherwise the record that says "you missed some" would itself wait behind the ones missed.
    this.#discardStreamPayload(session);
    this.#queue(session, { t: 'stream-close', protocol: RELAY_PROTOCOL_ID, code, reason });
    this.#conclude(session);
  }

  /** Tell whatever this session was driving that it is over. Idempotent by construction: the handler
   *  is forgotten before it is told, so a re-entrant close finds nothing to release. */
  #releaseStream(session: LinkSession): void {
    const stream = session.stream;
    session.stream = undefined;
    stream?.close();
  }

  /**
   * Everything a session holds beyond its own record state: a stream, a deadline, a pending
   * conclusion nothing will deliver now, and a send queue nothing will drain.
   *
   * THE PHASE GOES FIRST, and it is what makes the rest safe rather than merely tidy. Every send path
   * reads it — `#sendStream` refuses, `#closeStream` returns — so a handler that emits a frame from
   * inside the `close()` below finds a session that will not queue for it. Without that, releasing a
   * handler could put a record back on a queue this method has just emptied, for a session the
   * caller is about to tell the rendezvous has ended.
   */
  #forget(session: LinkSession): void {
    session.phase = 'concluding';
    session.credentialDeadline?.cancel();
    session.credentialDeadline = undefined;
    session.owesConclusion = false;
    // Nothing queued can be delivered now. Emptying it is not what makes a late send impossible —
    // `#flush` may already hold a record under a suspended seal, and the liveness gate there is what
    // stops that one — but a queue kept past the end of its session is memory held for a peer that
    // will never read it.
    session.waiting.length = 0;
    this.#releaseStream(session);
  }

  /**
   * Whether this exact session object is still the live one under its identifier.
   *
   * IDENTITY, NOT PRESENCE. A session that ended and one that was replaced by a fresh `open` under
   * the same 16 bytes are both "not this session", and only an identity check says so — a lookup by
   * key alone would hand an ended session's suspended seal a socket write against its successor.
   */
  #live(session: LinkSession): boolean {
    return this.#sessions.get(session.sessionId.text) === session;
  }

  /**
   * The session has an outcome, and will end as soon as that outcome has been DELIVERED.
   *
   * `4440` means "the outcome was stated inside the encrypted channel before this close", and a
   * `4440` with no sealed outcome before it is a protocol violation rather than a quiet end. Making
   * that true takes more than ordering the two behind the outbox, and this is the correction: the
   * sealed record is QUEUED, and a queue only drains while the peer's credit allows. On the one path
   * that reaches this naturally — an event stream closing `1013` because the viewer stopped reading —
   * the window is by definition exhausted, so a close sent as soon as the flush returned would
   * overtake the record it claims has already crossed, and every such close would be the violation.
   *
   * So the intent is recorded and {@link RelayLink.settle} performs it, from whichever flush finally
   * empties the queue. A peer that never returns credit therefore keeps a session that is over but
   * undelivered — bounded by liveness rather than by this, which is the right owner: a socket with no
   * evidence of life is dropped and redialled, and `close()` releases everything on it.
   *
   * IT TAKES NO REASON, AND THAT IS THE FIX RATHER THAN AN ECONOMY. It used to take one and put it
   * straight into the `closed` control below — a frame the rendezvous must be able to read to route
   * it, so every byte of that string was PLAINTEXT to the carrier. Two call sites made it a real
   * disclosure: a client's own `stream-close` text is reader-supplied content ("the viewer left this
   * stream" crossed the wire verbatim), and `#closeStream` sent this daemon's own taxonomy
   * ("stream reader fell behind"), which tells a relay operator exactly why people stop watching —
   * the disclosure {@link RELAY_STREAM_CLOSES} above says the sealed record exists to prevent, and
   * the oracle §14's "same close for every conclusion" property forbids. Removing the parameter is
   * what makes it unrepeatable: there is no longer anywhere for a caller to put one.
   *
   * Nothing is lost. The real code and reason crossed a moment earlier inside the sealed
   * `stream-close`, `paired`, `pair-refused` or `stream-refused` record — which is the entire meaning
   * of `4440`, and the only reason a client is allowed to treat this close as expected teardown.
   */
  #conclude(session: LinkSession): void {
    session.owesConclusion = true;
    this.#outbox = this.#outbox.then(() => this.#settle(session));
  }

  /** Send the concluding close, but only once nothing is still waiting to be sealed. */
  #settle(session: LinkSession): void {
    if (!session.owesConclusion || session.waiting.length > 0) return;
    session.owesConclusion = false;
    this.#forget(session);
    this.#sessions.delete(session.sessionId.text);
    this.#sendFrame({
      kind: FRAME_KINDS.control,
      sessionId: session.sessionId,
      sequence: 0,
      payload: encodeControlMessage({
        t: 'closed',
        code: RELAY_SESSION_CONCLUDED_CLOSE_CODE,
        // The shared constant, never a description of this session. See `#conclude` above.
        reason: RELAY_SESSION_CONCLUDED_CLOSE_REASON,
      }),
    });
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
    session.waiting.push({ plaintext, payload: false });
    this.#flush(session);
  }

  /**
   * Queue a record whose backlog its own caller has already decided about.
   *
   * SEPARATE FROM {@link RelayLink.sendRecord} because the depth guard there is a REQUEST rule with a
   * request's justification — the carrier bounds how many requests can be outstanding, so a queue
   * deeper than one credit window means the peer is not honouring the protocol. A stream's producer
   * is this daemon, not the peer, so the same depth carries no such meaning: a busy pane can legally
   * outrun a viewer's credit, and ending the session for it would kill a stream over a reader that is
   * merely slow. What bounds a stream is its own overflow policy above, reading honest buffered bytes.
   *
   * Oversize is not re-checked here. A plaintext over the cap is refused by `sealRecord` with `4413`
   * and ends the session in {@link RelayLink.flush} — one owner for that fact, in the layer that
   * knows it.
   */
  #queue(session: LinkSession, message: RelayTunnelDaemonMessage, payload = false): void {
    session.waiting.push({ plaintext: encodeTunnelMessage(message), payload });
    this.#flush(session);
  }

  /**
   * Drop the stream payload this session will never deliver, and nothing else.
   *
   * Called only where a close has just made that loss EXPLICIT. Every queued frame behind an
   * exhausted window is already lost to a viewer that stopped reading; keeping them would make the
   * sealed close wait for credit to drain records nobody will read, which is the same stall as
   * dropping the close, arrived at politely. The close itself, an acceptance and an answer are never
   * dropped here: a session that ended saying something other than what happened is the failure this
   * whole module is written against.
   *
   * IT RUNS ON THE INBOUND PATH AND SPLICES A QUEUE A SEAL MAY BE HALFWAY THROUGH, so the one record
   * it may not touch is the one already captured by that seal — see `sealing` in {@link RelayLink.flush},
   * which is what makes the removal there true. Exempting it costs this policy nothing: the exemption
   * exists so a close does not wait for credit to drain frames nobody will read, and a record that is
   * already sealed already holds its credit.
   */
  #discardStreamPayload(session: LinkSession): void {
    for (let index = session.waiting.length - 1; index >= 0; index -= 1) {
      const record = session.waiting[index];
      if (record?.payload === true && record !== session.sealing) session.waiting.splice(index, 1);
    }
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
        const pending = session.waiting[0];
        if (channel === undefined || pending === undefined) return;
        // CAPTURING A RECORD PINS IT, and the `shift()` below is only true because of this line.
        // `#discardStreamPayload` splices this queue from the INBOUND path while the await here is
        // suspended, index `0` included, so without the pin the head can change identity mid-seal.
        // The interleave that bit: a pane's payload frame is being sealed, its handler closes, the
        // discard drops that payload and queues the sealed `stream-close` in its place — and the
        // `shift()` then deleted the CLOSE and put the superseded payload on the wire instead.
        // `#settle` sent `4440` behind it with no outcome stated inside the channel, which §14 makes
        // a protocol violation, so an ordinary pane exit reached the viewer as a broken daemon with
        // the `1000`/`1009`/`1013` taxonomy the close carries lost.
        //
        // PINNING RATHER THAN DROPPING THE CIPHERTEXT, deliberately. Honouring the discard for a
        // record already sealed would mean throwing that ciphertext away and sealing the next one
        // under the same sequence number — two AEAD invocations under one key and one nonce. Only
        // one of them could ever reach a socket, so it is not an exposure; it is still an invariant
        // worth keeping literal rather than conditional, because "one nonce, one seal" is auditable
        // by reading and "one nonce, one ciphertext anybody kept" is not. Below this line one seal
        // produces at most one frame on the wire and advances the sequence at most once — never
        // twice, which is the half that matters. The liveness gate is the "at most": a session that
        // ended under its own seal sends nothing and advances nothing, and its channel dies with it.
        session.sealing = pending;
        const sealed = await sealRecord(this.deps.crypto, channel, pending.plaintext);
        session.sealing = undefined;
        if (!sealed.ok) {
          // No ciphertext was produced: both refusals are checked ahead of the AEAD, and the session
          // is over, so this sequence number is never spent and never reused.
          this.#endSession(session.sessionId, sealed.code, sealed.reason);
          return;
        }
        // THE SESSION MAY HAVE ENDED UNDER THAT SEAL, and this is the one check between a produced
        // ciphertext and a socket. `#endSession` runs from the INBOUND path — a malformed credit, a
        // stream record carrying unusable bytes, a repeated request identifier — and the inbound path
        // suspends on `openRecord` exactly where this one suspends on `sealRecord`, so the two
        // interleave. It sends the session's `closed` control immediately; a frame put on the wire
        // after that names no live session at the rendezvous, and the rendezvous answers THAT by
        // closing the daemon's whole socket rather than one session.
        //
        // The ciphertext is dropped rather than sent, and the counters are not advanced with it. That
        // does not spend a sequence number twice: this channel dies with its session, a reconnection
        // is a NEW session with new keys (§9), and nothing can seal under this nonce again.
        if (!this.#live(session)) return;
        session.waiting.shift();
        // The mirror of the write-back in `#onRecord`, and for the same reason: a record arriving
        // while this seal was suspended has already advanced the receive counter, and assigning the
        // whole channel here would put it back. Each direction owns exactly one number.
        session.channel = { ...(session.channel ?? channel), sendSequence: sealed.state.sendSequence };
        session.send = recordSent(session.send);
        this.deps.socket.send(encodeFrame(sealed.frame));
      }
      // A session with an outcome ends HERE, from whichever flush finally empties its queue, rather
      // than at the moment the outcome was decided — see `#conclude`. Reached only on the normal
      // path: the returns above have already ended the session for a reason of their own.
      this.#settle(session);
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
  #endSession(sessionId: SessionId, code: RelaySessionCloseCode, reason: string): void {
    const session = this.#sessions.get(sessionId.text);
    if (session !== undefined) this.#forget(session);
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
    this.close();
    this.deps.socket.close(code, reason);
  }

  /**
   * Release everything this link is holding, without saying anything on a socket.
   *
   * The carrier calls it when the daemon is going away and when a dropped socket is about to be
   * redialled, and both matter for the same reason: a stream handler owns a redraw timer and a viewer
   * slot armed against a peer that no longer exists, and the transport's own `closeSockets` reaches
   * only the sockets it accepted — never these. Nothing is sent because there is nothing left to send
   * it on; §9 already says every session dies with its socket, and reconnection is a NEW session
   * rather than a resumption, so there is nothing here worth carrying across one.
   */
  close(): void {
    for (const session of this.#sessions.values()) this.#forget(session);
    this.#sessions.clear();
  }
}
