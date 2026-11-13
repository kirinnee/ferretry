/**
 * The daemon's end of a sealed session: the kernel's session layer (§4.8, §4.13, §7.1, §7.3).
 *
 * Ported from today's `packages/daemon/src/lib/relay/link.ts`. What moved out: the rendezvous claim, the
 * `open`/`closed` control, heartbeats and the per-socket demultiplexing are the CARRIER's (Connections), so one
 * {@link CarrierLink} here is ONE session. What stayed, unchanged in behaviour: the handshake, sealing, the
 * strict credential union, the pre-credential limits, the credential deadline, the device proof and its
 * lease, request and stream dispatch, flow control, and the final check of every outbound record.
 *
 * WHAT THIS MODULE REFUSES TO DO, in every case where the alternative is a session that looks healthy and is not:
 *
 * - **It will not answer a hello addressed to another daemon.**
 * - **It will not accept any token.** A client authenticates by signing this session's transcript with the key
 *   its session mode answers for; there is no bearer value to present (R74).
 * - **It will not let a session's authority outlive its lease.** Fifteen minutes after the holder last proved
 *   its key the session ends `4441`, unless the holder signed the renewal challenge sent ahead of that moment,
 *   and every renewal re-asks the mode whether the holder is still accepted.
 * - **It will not repair a stream.** A bad tag, a sequence that is not the next one, a frame for another
 *   session: the session ends (R31, R85). There is no resume (R559).
 * - **It will not mark a call local.** Every request it builds is `arrival: carried` (G15, R625).
 * - **It will not send what changed.** A record's permit is asked inside `next()`, synchronously, after the
 *   seal and immediately before the carrier takes the bytes; a record whose permit changed is dropped, its
 *   sequence number never spent, and the session ends (§7.3).
 */

import { type ApiRequest, type ApiResponse, jsonResponse } from '../../contract/http.ts';
import type { CarrierKey, SessionId } from '../../contract/ids.ts';
import type { Clock, Log } from '../../contract/ports.ts';
import type {
  CarrierLink,
  CarrierPeer,
  HolderWatch,
  ModeHolder,
  ModeProof,
  ModeRedeemed,
  SealedFrame,
  SealedOutbound,
  SessionEnd,
  SessionLayer,
  SessionMode,
  SessionPrincipal,
} from '../../contract/session.ts';
import {
  SOCKET_CLOSES,
  type SocketDownstream,
  type SocketHandler,
  type SocketUpgradeDecision,
} from '../../contract/socket.ts';
import { instantFromEpochMs, milliseconds } from '@ferretry/std';
import {
  answerClientHandshake,
  answerRecords,
  type ChannelState,
  type ClientAuthRecord,
  type ClientDataRecord,
  type ClientJoinOptionsRecord,
  type ClientJoinRecord,
  type ClientMemberRecord,
  type ClientPairRecord,
  type ClientRecord,
  type ClientRequestPartRecord,
  type ClientRequestRecord,
  type ClientStreamRecord,
  type CarriedOrigin,
  carriedRateLimitIdentity,
  CREDIT_WINDOW_FRAMES,
  creditToReturn,
  type DaemonRecord,
  type DaemonSigningKey,
  type DeviceAuthKind,
  decodeClientHello,
  decodeClientRecord,
  decodeCreditPayload,
  decodeFrame,
  describeUnreadableRecord,
  deviceAuthMessage,
  devicePairMessage,
  deviceRenewMessage,
  encodeCreditPayload,
  encodeDaemonRecord,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  grantCredit,
  HANDSHAKE_FRAME_SEQUENCE,
  isRendezvousSessionId,
  type JoinOutcomeContent,
  MAX_PLAINTEXT_BYTES,
  MAX_TUNNEL_BODY_BYTES,
  maySend,
  memberAuthMessage,
  memberJoinMessage,
  memberJoinOptionsMessage,
  memberRenewMessage,
  NONCE_BYTES,
  newReceiveWindow,
  OLDER_APP_SENTENCE,
  newSendWindow,
  openChannel,
  openRecord,
  padJoinOutcome,
  RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE,
  RELAY_SESSION_CONCLUDED_CLOSE_CODE,
  RELAY_SESSION_CONCLUDED_CLOSE_REASON,
  type ReceiveWindow,
  recordConsumed,
  recordCredited,
  recordSent,
  type SendWindow,
  SESSION_CLOSE_CODES,
  SESSION_PROTOCOL_ID,
  type SessionCrypto,
  type SessionFrame,
  type SessionId as WireSessionId,
  sealRecord,
  sessionApiRequest,
  sessionStreamRequest,
  speaksPreviousSessionProtocol,
  streamDataFrame,
  streamDataRecord,
  toBase64Url,
  utf8Bytes,
  verifyDeviceProof,
} from './wire/index.ts';
import {
  ACCESS_LEASE_ENDED_REASON,
  DEFAULT_ACCESS_LEASE_POLICY,
  MAX_CONCURRENT_REQUESTS,
  MAX_INCOMING_BODIES,
  MAX_PRE_CREDENTIAL_SESSIONS,
  SESSION_CREDENTIAL_DEADLINE_MS,
  SESSION_STREAM_CLOSES,
  SESSION_STREAM_MAX_BUFFERED_BYTES,
  UNKNOWN_HOLDER_KEY,
  type AccessLeasePolicy,
} from './limits.ts';
import { createIdentitySigner, signerFor } from './signer.ts';

/** The kernel's route table, as the one function a session's request needs from it. */
export type SessionDispatch = (request: ApiRequest) => Promise<ApiResponse>;

/**
 * The kernel's SOCKET route table, as the two questions a stream session needs from it: the same routes, the
 * same admission, the same per-capability guard as a direct upgrade (R217, R539). `reauthorize` is that
 * boundary asked again about a stream already open, on every renewal and every grant change.
 */
export interface StreamDispatch {
  upgrade(request: ApiRequest): Promise<SocketUpgradeDecision>;
  reauthorize(request: ApiRequest): boolean;
}

/** The session modes the layer may ask, read live: a mode that is off answers `undefined`. */
export type ModeLookup = (mode: 'device' | 'pair' | 'member') => SessionMode | undefined;

/**
 * What the session layer needs. Nothing here is a global: the clock and its timers, crypto and the identity
 * key are all injected, so a suite drives every deadline and lease by hand.
 */
export interface SessionLayerDeps {
  /** The crypto port (X25519, Ed25519 verify, HKDF, AES-256-GCM, randomness). */
  readonly crypto: SessionCrypto;
  /** The daemon identity key: public half, fingerprint and a signer (the kernel's identity-key store). */
  readonly identity: DaemonSigningKey;
  /** The session modes (`session.modes` hook), read on every credential and renewal. */
  readonly modes: ModeLookup;
  /** The kernel's dispatcher (admission, then the route). */
  readonly dispatch: SessionDispatch;
  /** The kernel's socket table, for stream sessions. */
  readonly sockets: StreamDispatch;
  /** `nowMs` for lease arithmetic and `after` for the deadline, lease and renewal timers. */
  readonly clock: Pick<Clock, 'nowMs' | 'after'>;
  /** The lease and its cap. Absent means {@link DEFAULT_ACCESS_LEASE_POLICY}. */
  readonly lease?: AccessLeasePolicy;
  /**
   * Where a session that ends on a record this daemon could not read says so (the kind and the shape of what was
   * wrong, never a value). Absent means silence, as before.
   */
  readonly log?: Log;
}

/** What the layer is doing, for a surface that has to say whether this daemon is reachable at all. */
export interface SessionLayerReport {
  readonly sessions: number;
  readonly preCredential: number;
  /** The last refusal the layer made. Absent is "nothing has gone wrong yet". Never names a holder. */
  readonly lastRefusal?: string;
}

/** The layer as the kernel holds it: the carrier side, plus a report, a mode shutdown and a full close. */
export interface SessionLayerHost extends SessionLayer {
  report(): SessionLayerReport;
  /** A mode went away (turned off, failed): every session it verified ends with the one refusal (§4.13). */
  endMode(mode: 'device' | 'pair' | 'member'): void;
  /** Release every session, saying nothing (the daemon is going away). */
  close(): void;
}

interface ConnectionState {
  /** One link-wide seal queue (R555); credit and pending payload remain on each session. */
  outbox: Promise<void>;
}

/**
 * Build the session layer.
 *
 * `deps`: {@link SessionLayerDeps} — `crypto` (the WebCrypto adapter in production), `identity` (the daemon's
 * identity-key store, as a signer), `modes` (the live `session.modes` providers), `dispatch` and `sockets` (the
 * kernel's route and socket tables), `clock` (the kernel clock port), and `lease` (tests only).
 */
export function createSessionLayer(deps: SessionLayerDeps): SessionLayerHost {
  const shared = new LayerState(deps);
  return {
    open: (carrier, peer) => shared.open(carrier, peer, { outbox: Promise.resolve() }),
    connection: carrier => {
      const connection: ConnectionState = { outbox: Promise.resolve() };
      return { open: peer => shared.open(carrier, peer, connection) };
    },
    signer: signerFor('connections', createIdentitySigner(deps.identity)),
    report: () => shared.report(),
    endMode: mode => shared.endMode(mode),
    close: () => shared.close(),
  };
}

/** What every link of one layer shares: the live set (for the pre-credential bound) and the last refusal. */
class LayerState {
  readonly sessions = new Set<SealedSession>();
  lastRefusal: string | undefined;

  constructor(readonly deps: SessionLayerDeps) {}

  /**
   * `connection` groups the sessions of one transport connection: the pre-credential bound is per connection, as
   * today's was per `RelayLink` (one per direct socket, one per rendezvous socket), never per carrier key.
   */
  open(carrier: CarrierKey, peer: CarrierPeer | undefined, connection: ConnectionState): CarrierLink {
    const session = new SealedSession(this, carrier, peer, connection);
    // A session that has not presented a credential yet costs this daemon a slot, and anybody who saw a QR
    // knows the fingerprint that addresses it. An arrival past the bound is refused as BUSY rather than as an
    // error: a client opening several at once did nothing wrong and should retry (R232, R233).
    if (this.preCredential(connection) >= MAX_PRE_CREDENTIAL_SESSIONS) {
      session.refuseAtOpen(SESSION_CLOSE_CODES.rendezvousBusy, 'too many sessions are awaiting a credential');
      return session;
    }
    this.sessions.add(session);
    session.armCredentialDeadline();
    return session;
  }

  preCredential(connection: ConnectionState): number {
    let pending = 0;
    for (const session of this.sessions) if (session.connection === connection && session.preCredential()) pending += 1;
    return pending;
  }

  report(): SessionLayerReport {
    let preCredential = 0;
    for (const session of this.sessions) if (session.preCredential()) preCredential += 1;
    return {
      sessions: this.sessions.size,
      preCredential,
      ...(this.lastRefusal === undefined ? {} : { lastRefusal: this.lastRefusal }),
    };
  }

  endMode(mode: 'device' | 'pair' | 'member'): void {
    for (const session of [...this.sessions]) session.endIfVerifiedBy(mode);
  }

  close(): void {
    for (const session of [...this.sessions]) session.closed('the daemon is going away');
    this.sessions.clear();
  }
}

/**
 * WHAT A SESSION IS DOING, and the fact that it can only ever be doing one thing.
 *
 * `awaiting-credential` is the fork: the record that arrives there decides whether this session serves
 * requests, carries one stream, or redeems one code — and none of the terminal states has an edge to another
 * (R229, R230). `concluding` is the moment between an outcome being decided and the end that follows it.
 */
type SessionPhase = 'awaiting-hello' | 'awaiting-credential' | 'proving' | 'serving' | 'streaming' | 'concluding';

/** A request whose body is still arriving in parts. */
interface IncomingBody {
  readonly request: ClientRequestRecord;
  readonly parts: string[];
  bytes: number;
  /** Over the body limit: the parts are dropped and the request is answered `413` when it ends. */
  refused: boolean;
}

/**
 * One record waiting for credit. `payload` marks a stream's payload, the one kind a close may discard; `part`
 * a later part of an answer, not counted on its own; `permit` the final check asked inside `next()`.
 */
interface PendingRecord {
  readonly plaintext: Uint8Array;
  readonly payload: boolean;
  readonly part?: true;
  readonly permit?: () => boolean;
}

const wholeRecords = (waiting: readonly PendingRecord[]): number =>
  waiting.reduce((count, record) => (record.payload || record.part === true ? count : count + 1), 0);

/** A whole request waiting for one of its session's {@link MAX_CONCURRENT_REQUESTS} slots. */
interface WaitingRequest {
  readonly request: ClientRequestRecord;
  readonly body: string;
}

/** A record sealed ahead of the pull, still at the head of `waiting`, its sequence not yet spent. */
interface SealedAhead {
  readonly pending: PendingRecord;
  readonly frame: SealedFrame;
  readonly state: ChannelState;
}

/** What a verified session stands on: its mode, the credential it presented, and the principal stamped. */
interface Standing {
  readonly mode: 'device' | 'member';
  readonly proof: ModeProof;
  readonly appSession: string;
  principal: SessionPrincipal;
}

/** The one refusal a join or a join-options gets, for every cause. */
const REFUSED_JOIN_OUTCOME: JoinOutcomeContent = {
  t: 'join-refused',
  protocol: SESSION_PROTOCOL_ID,
  reason: 'join_refused',
};

/** Carriers that never carry a pairing (R662, R675): refused with the uniform outcome, the mode never asked. */
const NO_PAIRING_CARRIERS: ReadonlySet<string> = new Set(['tunnel', 'webrtc']);

class SealedSession implements CarrierLink {
  readonly outbound: SealedOutbound;
  #phase: SessionPhase = 'awaiting-hello';
  #wireId: WireSessionId | undefined;
  #channel: ChannelState | undefined;
  #transcript: Uint8Array | undefined;
  #standing: Standing | undefined;
  #leaseExpiresAtMs = 0;
  #provedAtMs: number | undefined;
  #lease: (() => void) | undefined;
  #renewal: (() => void) | undefined;
  #renewNonce: string | undefined;
  readonly #incoming = new Map<number, IncomingBody>();
  #send: SendWindow = newSendWindow();
  #receive: ReceiveWindow = newReceiveWindow();
  readonly #answered = new Set<number>();
  #running = 0;
  readonly #backlog: WaitingRequest[] = [];
  /** Records waiting for credit, in order. */
  readonly #waiting: PendingRecord[] = [];
  /** The record a seal has captured while it is sealing; it stays at the head of `waiting`. */
  #sealing: PendingRecord | undefined;
  /** At most one record sealed ahead of the pull. Its sequence is spent only when `next()` hands it over. */
  #sealed: SealedAhead | undefined;
  /** Unsealed session frames (the handshake answer, credit), handed over before anything sealed. */
  readonly #plain: SealedFrame[] = [];
  #stream: SocketHandler | undefined;
  #streamRequest: ApiRequest | undefined;
  #release: (() => void) | undefined;
  #credentialDeadline: (() => void) | undefined;
  /** The session has an outcome and ends once that outcome has actually been handed over. */
  #owesConclusion = false;
  #end: SessionEnd | undefined;
  /** The peer went away: nothing more is pulled or delivered. */
  #gone = false;
  /** Serialises inbound frames: frame `n+1` is never opened before frame `n` is handled. */
  #inbox: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly layer: LayerState,
    readonly carrier: CarrierKey,
    private readonly peer: CarrierPeer | undefined,
    /** The transport connection this session rides; it owns the seal queue and pre-credential bound. */
    readonly connection: ConnectionState,
  ) {
    this.outbound = {
      next: () => this.#next(),
      onReady: listener => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
  }

  private get deps(): SessionLayerDeps {
    return this.layer.deps;
  }

  preCredential(): boolean {
    return this.#phase === 'awaiting-hello' || this.#phase === 'awaiting-credential' || this.#phase === 'proving';
  }

  refuseAtOpen(code: number, reason: string): void {
    this.layer.lastRefusal = `session ${code}: ${reason}`;
    this.#phase = 'concluding';
    this.#end = { code, reason };
  }

  /**
   * The one window a session has to say what it is for, from `open` to its credential record (R232). ARMED BY
   * THE OPEN, NOT BY THE HANDSHAKE: a peer that sends no hello cannot hold pre-auth capacity forever.
   */
  armCredentialDeadline(): void {
    this.#credentialDeadline = this.deps.clock.after(milliseconds(SESSION_CREDENTIAL_DEADLINE_MS), () => {
      this.#credentialDeadline = undefined;
      if (!this.#live() || (this.#phase !== 'awaiting-hello' && this.#phase !== 'awaiting-credential')) return;
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'no credential arrived before the deadline');
    });
  }

  endIfVerifiedBy(mode: 'device' | 'pair' | 'member'): void {
    if (this.#live() && (this.#standing?.mode === mode || this.#phase === 'proving'))
      this.#endSession(SESSION_CLOSE_CODES.authRejected, 'unknown device credential');
  }

  // ─── the carrier's side ─────────────────────────────────────────────────────────────────────

  inbound(bytes: Uint8Array): void {
    if (!this.#live()) return;
    this.#inbox = this.#inbox
      .then(() => this.#handle(bytes))
      .catch(() => {
        if (this.#live()) this.#endSession(SESSION_CLOSE_CODES.relayInternal, 'the session failed');
      });
  }

  closed(_reason: string): void {
    if (this.#gone) return;
    this.#gone = true;
    this.#forget();
    this.#end ??= { code: SESSION_CLOSE_CODES.protocolError, reason: 'the peer went away' };
    this.layer.sessions.delete(this);
  }

  /**
   * The pull. The PERMIT of the head record is asked here, synchronously, after its seal and immediately before
   * the bytes are returned (§7.3): a record whose permit changed is dropped unsent, its sequence number is
   * never spent (the channel's send counter advances only here), and the session ends.
   */
  #next(): SealedFrame | SessionEnd | undefined {
    if (this.#gone) return this.#end;
    if (this.#end !== undefined) return this.#end;
    const plain = this.#plain.shift();
    if (plain !== undefined) return plain;
    const sealed = this.#sealed;
    if (sealed === undefined) return undefined;
    this.#sealed = undefined;
    let permitted: boolean;
    try {
      permitted = sealed.pending.permit?.() !== false;
    } catch {
      permitted = false;
    }
    if (!permitted) {
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'what it was about to send changed before it left');
      return this.#end;
    }
    if (this.#waiting[0] === sealed.pending) this.#waiting.shift();
    this.#channel =
      this.#channel === undefined ? undefined : { ...this.#channel, sendSequence: sealed.state.sendSequence };
    this.#send = recordSent(this.#send);
    this.#flush();
    return sealed.frame;
  }

  #ready(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A carrier's listener that throws is the carrier's problem; the session goes on.
      }
    }
  }

  #live(): boolean {
    return this.#end === undefined && !this.#gone;
  }

  // ─── inbound ────────────────────────────────────────────────────────────────────────────────

  async #handle(bytes: Uint8Array): Promise<void> {
    if (!this.#live()) return;
    const decoded = decodeFrame(bytes);
    if (!decoded.ok) {
      this.#endSession(decoded.code, decoded.reason);
      return;
    }
    const frame = decoded.frame;
    // Control frames are hop-by-hop and belong to the carrier (the rendezvous, a direct `ready`), never to a
    // session (R26).
    if (frame.kind === FRAME_KINDS.control) {
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'a carrier control frame reached the session');
      return;
    }
    if (this.#wireId === undefined) {
      if (frame.kind !== FRAME_KINDS.handshake || isRendezvousSessionId(frame.sessionId)) {
        this.#endSession(SESSION_CLOSE_CODES.protocolError, 'a session must open with a handshake');
        return;
      }
      this.#wireId = frame.sessionId;
    } else if (frame.sessionId.text !== this.#wireId.text) {
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'a frame named another session');
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

  #onCredit(frame: SessionFrame): void {
    const frames = decodeCreditPayload(frame.payload);
    if (frames === null) {
      this.#endSession(SESSION_CLOSE_CODES.flowViolation, 'malformed credit');
      return;
    }
    const granted = grantCredit(this.#send, frames);
    if (granted.allowed === this.#send.allowed) {
      // A grant that would change nothing is a protocol violation (R96).
      this.#endSession(SESSION_CLOSE_CODES.flowViolation, 'credit grant had no effect');
      return;
    }
    this.#send = granted;
    this.#flush();
  }

  async #onHandshake(frame: SessionFrame): Promise<void> {
    const wireId = this.#wireId;
    if (this.#phase !== 'awaiting-hello' || frame.sequence !== HANDSHAKE_FRAME_SEQUENCE || wireId === undefined) {
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'a handshake arrived out of turn');
      return;
    }
    const hello = decodeClientHello(frame.payload);
    if (hello === null) {
      // An app from before device keys is not an attacker and not a bug: it is an app nobody updated,
      // and the person holding it can only fix that if they are told which side is old. The sentence
      // is public on purpose — it crosses the carrier unsealed and says nothing about anybody.
      if (speaksPreviousSessionProtocol(frame.payload))
        this.#endSession(SESSION_CLOSE_CODES.versionUnsupported, OLDER_APP_SENTENCE);
      else this.#endSession(SESSION_CLOSE_CODES.protocolError, 'unparseable client hello');
      return;
    }
    const answered = await answerClientHandshake(this.deps.crypto, this.deps.identity, wireId, hello);
    // The credential deadline covers this await and can end the session inside it.
    if (!this.#live()) return;
    if (!answered.ok) {
      this.#endSession(SESSION_CLOSE_CODES.protocolError, answered.reason);
      return;
    }
    if (!this.#consume()) return;
    this.#channel = openChannel(wireId, answered.keys, 'daemon');
    this.#transcript = answered.keys.transcriptHash;
    this.#phase = 'awaiting-credential';
    // The answer is sequence 0 of this direction: the one end-to-end frame that is not a record (R29, R65).
    this.#send = recordSent(this.#send);
    this.#pushPlain({
      kind: FRAME_KINDS.handshake,
      sessionId: wireId,
      sequence: HANDSHAKE_FRAME_SEQUENCE,
      payload: encodeHandshakeMessage(answered.hello),
    });
  }

  async #onRecord(frame: SessionFrame): Promise<void> {
    const channel = this.#channel;
    if (channel === undefined) {
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'a record arrived before the handshake');
      return;
    }
    const opened = await openRecord(this.deps.crypto, channel, frame);
    if (!this.#live()) return;
    if (!opened.ok) {
      this.#endSession(opened.code, opened.reason);
      return;
    }
    // ONLY THIS DIRECTION'S COUNTER: sealing runs on its own queue, and writing the whole channel back would
    // rewind what the sender advanced meanwhile (a rewound send counter is a nonce reuse).
    this.#channel = { ...(this.#channel ?? channel), receiveSequence: opened.state.receiveSequence };
    if (!this.#consume()) return;
    const message = decodeClientRecord(opened.plaintext);
    if (message === null) {
      // A session ended by the daemon on a record it could not read used to leave nothing behind, so an app
      // sending a field the schema refuses looked like a dead rendezvous. Only the record's kind, which phase
      // it arrived in and the zod issue codes/field names are written: see `describeUnreadableRecord`.
      const unreadable = describeUnreadableRecord(opened.plaintext);
      this.deps.log?.warn('a session was ended because its record could not be read', {
        carrier: this.carrier,
        phase: this.#phase,
        kind: unreadable.kind,
        cause: unreadable.cause,
        issues: unreadable.issues.join(' '),
      });
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'unparseable session record');
      return;
    }
    if (this.#phase === 'awaiting-credential') {
      await this.#credential(message);
      return;
    }
    // The lease is checked here too, not only by its timer: a record queued behind a late timer is not served
    // after the authority it needed has ended.
    if (
      (this.#phase === 'serving' || this.#phase === 'streaming') &&
      this.deps.clock.nowMs() >= this.#leaseExpiresAtMs
    ) {
      this.#endSession(RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE, ACCESS_LEASE_ENDED_REASON);
      return;
    }
    if (this.#phase === 'streaming') {
      await this.#onStreamRecord(message);
      return;
    }
    if (this.#phase === 'serving' && message.t === 'req') return this.#serve(message);
    if (this.#phase === 'serving' && message.t === 'req-more') return this.#continueBody(message);
    if (this.#phase === 'serving' && message.t === 'renewed') {
      await this.#renewed(message.proof);
      return;
    }
    // `proving` lands here too: nothing may follow the credential record until it is accepted (R234).
    this.#endSession(SESSION_CLOSE_CODES.protocolError, 'this session does not carry that message');
  }

  /** The fork: one record, and the session is committed for life (R229, R230, R624). */
  async #credential(message: ClientRecord): Promise<void> {
    this.#credentialDeadline?.();
    this.#credentialDeadline = undefined;
    switch (message.t) {
      case 'auth':
        await this.#authenticate(message);
        return;
      case 'stream':
        await this.#openStream(message);
        return;
      case 'pair':
        await this.#redeemPairing(message);
        return;
      case 'join':
        await this.#join(message);
        return;
      case 'join-options':
        await this.#joinOptions(message);
        return;
      case 'member':
        await this.#authenticateMember(message);
        return;
      default:
        this.#endSession(SESSION_CLOSE_CODES.protocolError, 'the first record must be a credential');
    }
  }

  // ─── proving a holder ───────────────────────────────────────────────────────────────────────

  async #authenticate(claim: ClientAuthRecord): Promise<void> {
    if (!(await this.#proveDevice('auth', claim))) return;
    this.#phase = 'serving';
    this.#sendRecord({
      t: 'authenticated',
      protocol: SESSION_PROTOCOL_ID,
      accessExpiresAt: instant(this.#leaseExpiresAtMs),
      ...this.#rotateBy(),
    });
  }

  /** A device's claim to this session, or the end of it having said nothing about why. */
  async #proveDevice(
    kind: DeviceAuthKind,
    claim: { readonly deviceId: string; readonly appSession: string; readonly proof: string },
  ): Promise<boolean> {
    const proof: ModeProof = { mode: 'device', body: { deviceId: claim.deviceId, appSession: claim.appSession } };
    return await this.#prove('device', proof, claim.appSession, claim.proof, transcript =>
      deviceAuthMessage(transcript, kind, claim.deviceId, claim.appSession),
    );
  }

  async #authenticateMember(claim: ClientMemberRecord): Promise<void> {
    const proof: ModeProof = { mode: 'member', body: { keyId: claim.keyId, appSession: claim.appSession } };
    const proved = await this.#prove('member', proof, claim.appSession, claim.proof, transcript =>
      memberAuthMessage(transcript, claim.keyId, claim.appSession),
    );
    if (!proved) return;
    this.#phase = 'serving';
    this.#sendRecord({
      t: 'authenticated',
      protocol: SESSION_PROTOCOL_ID,
      accessExpiresAt: instant(this.#leaseExpiresAtMs),
    });
  }

  /**
   * The shared proof: the mode names the holder and its key, the KERNEL checks the signature over this
   * session's transcript and stamps the principal. Unknown, revoked, expired, a mode that is off or throws, and
   * a bad signature are one refusal (`4403`), and an unknown holder is verified against a key nobody holds so
   * it costs what a known one does. The session is `proving` meanwhile, so a record behind the credential is
   * refused rather than read as a second credential.
   */
  async #prove(
    modeKey: 'device' | 'member',
    proof: ModeProof,
    appSession: string,
    signature: string,
    message: (transcript: Uint8Array) => Uint8Array,
  ): Promise<boolean> {
    this.#phase = 'proving';
    const transcript = this.#transcript;
    const mode = this.deps.modes(modeKey);
    const holder = await askHolder(mode, proof);
    const checked =
      transcript !== undefined &&
      (await verifyDeviceProof(this.deps.crypto, holder?.key ?? UNKNOWN_HOLDER_KEY, signature, message(transcript)));
    if (!this.#live()) return false;
    const kind = mode?.principalKind;
    if (
      mode === undefined ||
      holder === undefined ||
      !checked ||
      transcript === undefined ||
      kind === 'none' ||
      kind === undefined
    ) {
      this.#refuseHolder(modeKey);
      return false;
    }
    const sessionId = transcriptKey(transcript) as SessionId;
    this.#standing = {
      mode: modeKey,
      proof,
      appSession,
      principal: { kind, holder: holder.holder, session: sessionId, leaseUntil: instant(0), appSession },
    };
    const watch: HolderWatch = {
      session: sessionId,
      appSession,
      revoked: () => {
        // Said exactly as an unknown holder is, so the carrier cannot tell a revocation apart.
        if (this.#live()) this.#endSession(SESSION_CLOSE_CODES.authRejected, 'unknown device credential');
      },
      lapsed: () => {
        if (this.#live()) this.#endSession(RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE, ACCESS_LEASE_ENDED_REASON);
      },
      regranted: () => this.#recheckStream(),
    };
    let release: (() => void) | undefined;
    try {
      release = mode.watch === undefined ? () => {} : mode.watch(holder.holder, watch);
    } catch {
      release = undefined;
    }
    // A holder revoked a moment ago is ended before `watch` returns.
    if (!this.#live()) {
      release?.();
      return false;
    }
    if (release === undefined) {
      this.#refuseHolder(modeKey);
      return false;
    }
    this.#release = release;
    // The moment this link stops being an unproven one: a direct carrier frees its unproven slot (today's
    // `connections.track` / member `open` marking `#proved`). A carrier's throw is the carrier's problem.
    try {
      this.peer?.proved?.();
    } catch {
      // nothing: the session is proved either way
    }
    // NOT `seen`: opening a session is something a background tab does by itself (R-presence).
    this.#armLease();
    return true;
  }

  #refuseHolder(modeKey: 'device' | 'member'): void {
    this.layer.lastRefusal = `a client presented a ${modeKey} this daemon does not accept`;
    this.#endSession(SESSION_CLOSE_CODES.authRejected, 'unknown device credential');
  }

  /**
   * Fifteen minutes of authority from now, and the challenge that can extend it, asked from THIS side ahead of
   * the end; CAPPED at twelve hours from the first proof, so silent renewal cannot keep one session forever.
   */
  #armLease(): void {
    this.#lease?.();
    this.#renewal?.();
    this.#renewal = undefined;
    this.#renewNonce = undefined;
    const now = this.deps.clock.nowMs();
    this.#provedAtMs ??= now;
    const lease = this.deps.lease ?? DEFAULT_ACCESS_LEASE_POLICY;
    const capAtMs = this.#provedAtMs + lease.maxSessionMs;
    this.#leaseExpiresAtMs = Math.min(now + lease.leaseMs, capAtMs);
    const standing = this.#standing;
    if (standing !== undefined)
      standing.principal = { ...standing.principal, leaseUntil: instant(this.#leaseExpiresAtMs) };
    const renewInMs = this.#leaseExpiresAtMs - lease.renewLeadMs - now;
    if (this.#leaseExpiresAtMs < capAtMs && renewInMs > 0)
      this.#renewal = this.deps.clock.after(milliseconds(renewInMs), () => this.#askRenewal());
    this.#lease = this.deps.clock.after(milliseconds(this.#leaseExpiresAtMs - now), () => {
      if (this.#live()) this.#endSession(RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE, ACCESS_LEASE_ENDED_REASON);
    });
  }

  #rotateBy(): { readonly rotateBy?: string } {
    const standing = this.#standing;
    if (standing === undefined) return {};
    try {
      const at = this.deps.modes(standing.mode)?.rotateBy?.(standing.principal.holder);
      return at === undefined ? {} : { rotateBy: at };
    } catch {
      return {};
    }
  }

  #askRenewal(): void {
    if (!this.#live() || (this.#phase !== 'serving' && this.#phase !== 'streaming')) return;
    const nonce = toBase64Url(this.deps.crypto.randomBytes(NONCE_BYTES));
    this.#renewNonce = nonce;
    this.#queueFirst({ t: 'renew', protocol: SESSION_PROTOCOL_ID, nonce, expiresAt: instant(this.#leaseExpiresAtMs) });
  }

  /**
   * The holder answered a renewal: the same key, over this transcript and the nonce it was sent. The mode is
   * asked AGAIN, so a holder revoked or expired since the session opened cannot renew; the nonce is spent
   * before anything is awaited, so a second answer is a protocol error, not a second chance.
   */
  async #renewed(signature: string): Promise<void> {
    const nonce = this.#renewNonce;
    this.#renewNonce = undefined;
    const standing = this.#standing;
    const transcript = this.#transcript;
    if (nonce === undefined || standing === undefined || transcript === undefined) {
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'a renewal arrived that nothing asked for');
      return;
    }
    const holder = await askHolder(this.deps.modes(standing.mode), standing.proof);
    const message =
      standing.mode === 'member' ? memberRenewMessage(transcript, nonce) : deviceRenewMessage(transcript, nonce);
    const verified =
      holder !== undefined &&
      holder.holder === standing.principal.holder &&
      (await verifyDeviceProof(this.deps.crypto, holder.key, signature, message));
    if (!this.#live()) return;
    if (!verified) {
      this.#endSession(SESSION_CLOSE_CODES.authRejected, 'unknown device credential');
      return;
    }
    // A renewal is the tab answering by itself, not a person: it never moves the holder's idle clock.
    this.#armLease();
    this.#recheckStream();
  }

  /** Whether the stream this session carries is still allowed; a narrowed grant ends it with a sealed `1008`. */
  #recheckStream(): void {
    if (this.#phase !== 'streaming' || this.#streamRequest === undefined) return;
    let allowed: boolean;
    try {
      allowed = this.deps.sockets.reauthorize(this.#withPrincipal(this.#streamRequest));
    } catch {
      allowed = false;
    }
    if (allowed) return;
    this.#closeStream(SESSION_STREAM_CLOSES.notAllowed.code, SESSION_STREAM_CLOSES.notAllowed.reason);
  }

  // ─── requests ───────────────────────────────────────────────────────────────────────────────

  #origin(): CarriedOrigin {
    return {
      carrier: this.carrier,
      clientAddress: this.peer?.address ?? carriedRateLimitIdentity(this.carrier, this.#wireId?.text ?? ''),
    };
  }

  /** The request as it goes out NOW: the principal is read when it is dispatched, with its current lease. */
  #withPrincipal(request: ApiRequest): ApiRequest {
    const standing = this.#standing;
    return standing === undefined ? request : { ...request, principal: standing.principal };
  }

  #serve(request: ClientRequestRecord): void {
    if (this.#answered.has(request.id)) {
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'a request identifier was reused');
      return;
    }
    this.#answered.add(request.id);
    // The ONE thing that keeps a holder from idling out: a request the page marked as a person's.
    const standing = this.#standing;
    if (request.presence === true && standing !== undefined) {
      try {
        this.deps.modes(standing.mode)?.seen?.(standing.principal.holder);
      } catch {
        // The idle clock is the mode's; a mode that throws does not end the request.
      }
    }
    const first = request.body ?? '';
    if (request.more !== true) {
      this.#dispatch(request, first);
      return;
    }
    if (this.#incoming.size >= MAX_INCOMING_BODIES) {
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'too many request bodies are arriving at once');
      return;
    }
    const bytes = utf8Bytes(first).byteLength;
    this.#incoming.set(request.id, { request, parts: [first], bytes, refused: bytes > MAX_TUNNEL_BODY_BYTES });
  }

  /** The next part of a request body; past 32 MiB the parts are dropped and the request is answered `413`. */
  #continueBody(part: ClientRequestPartRecord): void {
    const pending = this.#incoming.get(part.id);
    if (pending === undefined) {
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'a body part named no request in progress');
      return;
    }
    pending.bytes += utf8Bytes(part.body).byteLength;
    if (pending.bytes > MAX_TUNNEL_BODY_BYTES) pending.refused = true;
    if (pending.refused) pending.parts.length = 0;
    else pending.parts.push(part.body);
    if (part.more === true) return;
    this.#incoming.delete(part.id);
    if (!pending.refused) {
      this.#dispatch(pending.request, pending.parts.join(''));
      return;
    }
    this.#answer(
      pending.request.id,
      jsonResponse(
        {
          error: {
            code: 'request_too_large',
            message: `the request body is over the ${MAX_TUNNEL_BODY_BYTES}-byte limit one session carries`,
          },
        },
        413,
      ),
    );
  }

  /**
   * Start a whole request beside the ones running, or queue it. A request that has to wait KEEPS ITS RECORD'S
   * CREDIT until it starts, so a peer sending past the bound runs out of allowance; a backlog past one window is
   * a peer sending beyond what it was given (R535, R536).
   */
  #dispatch(request: ClientRequestRecord, body: string): void {
    if (this.#running < MAX_CONCURRENT_REQUESTS) {
      void this.#run(request, body);
      return;
    }
    if (this.#backlog.length > CREDIT_WINDOW_FRAMES) {
      this.#endSession(SESSION_CLOSE_CODES.flowViolation, 'more requests than the window allows');
      return;
    }
    this.#backlog.push({ request, body });
  }

  /** One request, run to its answer. A handler that throws is answered `500`; the session goes on. */
  async #run(request: ClientRequestRecord, body: string): Promise<void> {
    this.#running += 1;
    try {
      const standing = this.#standing;
      if (standing === undefined) return;
      let response: ApiResponse;
      try {
        response = await this.deps.dispatch(
          sessionApiRequest({ ...request, body }, standing.principal, this.#origin(), this.#transcript),
        );
      } catch {
        response = jsonResponse(
          { error: { code: 'internal_error', message: 'the daemon failed to handle this request' } },
          500,
        );
      }
      if (this.#live() && this.#phase === 'serving') {
        this.#answer(request.id, response);
        if (response.endsSession === true) {
          // A request racing the close is refused as a record after the end, not served and then cut off.
          this.#phase = 'concluding';
          this.#conclude();
        }
      }
    } finally {
      this.#running -= 1;
      this.#startNext();
    }
  }

  #startNext(): void {
    if (!this.#live()) return;
    const next = this.#backlog.shift();
    if (next === undefined) return;
    if (this.deps.clock.nowMs() >= this.#leaseExpiresAtMs) {
      this.#endSession(RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE, ACCESS_LEASE_ENDED_REASON);
      return;
    }
    this.#returnCredit();
    void this.#run(next.request, next.body);
  }

  /** One answer, as one record or as its ordered parts, each with its permit (R526, R534). */
  #answer(id: number, response: ApiResponse): void {
    let records: ReturnType<typeof answerRecords>;
    try {
      records = answerRecords(id, response);
    } catch {
      // The final check threw while spelling the answer: it withholds (§7.3).
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'what it was about to send changed before it left');
      return;
    }
    const pending = records.map((record): PendingRecord => ({ ...record, payload: false }));
    if (pending.length === 1 && pending[0] !== undefined) {
      this.#sendEncodedRecord(pending[0]);
      return;
    }
    for (const record of pending) this.#waiting.push(record);
    this.#flush();
  }

  // ─── one-time redemptions: pairing, joining ─────────────────────────────────────────────────

  /**
   * First contact, redeemed through the `pair` mode and never through a route. ONE ATTEMPT, ONE SEALED
   * OUTCOME, THEN `4440`, success and failure alike. The proof is checked by the kernel, but only when the mode
   * runs `prove` after its own admission.
   */
  async #redeemPairing(request: ClientPairRecord): Promise<void> {
    this.#phase = 'concluding';
    const refused: DaemonRecord = { t: 'pair-refused', protocol: SESSION_PROTOCOL_ID, reason: 'pairing_refused' };
    // PAIRING IS NEVER CARRIED BY A TUNNEL OR WEBRTC (R662, R675): the uniform refusal, no budget spent.
    if (NO_PAIRING_CARRIERS.has(this.carrier)) {
      this.#queue(refused);
      this.#conclude();
      return;
    }
    const transcript = this.#transcript;
    const redeemed = await this.#redeem(
      'pair',
      { mode: 'pair', body: { code: request.code, deviceName: request.deviceName, deviceKey: request.deviceKey } },
      async () =>
        transcript !== undefined &&
        (await verifyDeviceProof(
          this.deps.crypto,
          request.deviceKey,
          request.proof,
          devicePairMessage(transcript, request.deviceKey),
        )),
    );
    if (!this.#live()) return;
    this.#queue(
      redeemed !== undefined && redeemed.outcome === 'paired'
        ? { t: 'paired', protocol: SESSION_PROTOCOL_ID, response: redeemed.fields['response'] }
        : refused,
    );
    this.#conclude();
  }

  /** A share code, redeemed through the `member` mode: one attempt, one PADDED sealed outcome, then `4440`. */
  async #join(request: ClientJoinRecord): Promise<void> {
    this.#phase = 'concluding';
    const transcript = this.#transcript;
    const redeemed = await this.#redeem(
      'member',
      {
        mode: 'member',
        body: {
          act: 'join',
          code: request.code,
          clientName: request.clientName,
          memberKey: request.memberKey,
          boxKey: request.boxKey,
          ...(request.passkey === undefined ? {} : { passkey: request.passkey }),
        },
      },
      async () =>
        transcript !== undefined &&
        (await verifyDeviceProof(
          this.deps.crypto,
          request.memberKey,
          request.proof,
          memberJoinMessage(transcript, request.memberKey, request.boxKey),
        )),
    );
    this.#concludeJoin(redeemed, ['joined']);
  }

  /** What a join with a code needs, spending nothing; the same one-attempt, padded-outcome, `4440` shape. */
  async #joinOptions(request: ClientJoinOptionsRecord): Promise<void> {
    this.#phase = 'concluding';
    const transcript = this.#transcript;
    const redeemed = await this.#redeem(
      'member',
      {
        mode: 'member',
        body: { act: 'join-options', code: request.code, memberKey: request.memberKey, origin: request.origin },
      },
      async () =>
        transcript !== undefined &&
        (await verifyDeviceProof(
          this.deps.crypto,
          request.memberKey,
          request.proof,
          memberJoinOptionsMessage(transcript, request.memberKey, request.origin),
        )),
    );
    this.#concludeJoin(redeemed, ['join-open', 'join-challenge']);
  }

  #concludeJoin(redeemed: ModeRedeemed | undefined, allowed: readonly string[]): void {
    if (!this.#live()) return;
    let content: JoinOutcomeContent = REFUSED_JOIN_OUTCOME;
    if (redeemed !== undefined && allowed.includes(redeemed.outcome)) {
      const { t: _t, protocol: _protocol, pad: _pad, ...fields } = redeemed.fields;
      content = { ...fields, t: redeemed.outcome as JoinOutcomeContent['t'], protocol: SESSION_PROTOCOL_ID };
    }
    const text = padJoinOutcome(content) ?? padJoinOutcome(REFUSED_JOIN_OUTCOME) ?? '';
    this.#queue({ t: 'join-outcome', text });
    this.#conclude();
  }

  /** Ask a mode to redeem; a missing mode, a throw and a refusal are all `undefined` (one refusal). */
  async #redeem(
    modeKey: 'pair' | 'member',
    proof: ModeProof,
    prove: () => Promise<boolean>,
  ): Promise<ModeRedeemed | undefined> {
    const mode = this.deps.modes(modeKey);
    if (mode?.redeem === undefined) return undefined;
    try {
      const result = await mode.redeem({ proof, prove, carrier: this.carrier, peer: this.#origin().clientAddress });
      return result === 'refused' ? undefined : result;
    } catch {
      return undefined;
    }
  }

  // ─── one stream ─────────────────────────────────────────────────────────────────────────────

  /**
   * The credential record opens the stream in the same breath. It goes through the kernel's OWN socket table,
   * so a stream a direct viewer may not open a carried viewer may not open either (R217, R539), and every
   * refusal is said BEFORE anything switches (R542).
   */
  async #openStream(request: ClientStreamRecord): Promise<void> {
    if (!(await this.#proveDevice('stream', request))) return;
    const standing = this.#standing;
    if (standing === undefined) return;
    this.#phase = 'concluding';
    const streamRequest = sessionStreamRequest(request, standing.principal, this.#origin(), this.#transcript);
    const decision = await this.deps.sockets
      .upgrade(streamRequest)
      .catch((): SocketUpgradeDecision => ({ outcome: 'unclaimed' }));
    if (!this.#live()) return;
    if (decision.outcome !== 'accepted') {
      const refusal =
        decision.outcome === 'refused'
          ? { status: decision.response.status, body: decision.response.body }
          : { status: 404, body: 'no stream is served at this path' };
      this.#queue({ t: 'stream-refused', protocol: SESSION_PROTOCOL_ID, ...refusal });
      this.#conclude();
      return;
    }
    let handler: SocketHandler;
    try {
      handler = await decision.attach(this.#downstream());
    } catch {
      this.#queue({
        t: 'stream-refused',
        protocol: SESSION_PROTOCOL_ID,
        status: 500,
        body: 'the daemon failed to attach this stream',
      });
      this.#conclude();
      return;
    }
    if (!this.#live()) {
      handler.close();
      return;
    }
    this.#stream = handler;
    this.#streamRequest = streamRequest;
    this.#phase = 'streaming';
    this.#queue({
      t: 'stream-opened',
      protocol: SESSION_PROTOCOL_ID,
      accessExpiresAt: instant(this.#leaseExpiresAtMs),
      ...this.#rotateBy(),
    });
    // Queued before `open` runs, so the acceptance is ahead of the first frame the handler produces.
    await handler.open().catch(() => {
      this.#closeStream(SOCKET_CLOSES.unavailable.code, SOCKET_CLOSES.unavailable.reason);
    });
  }

  async #onStreamRecord(message: ClientRecord): Promise<void> {
    if (message.t === 'data') {
      this.#onStreamData(message);
      return;
    }
    if (message.t === 'renewed') {
      await this.#renewed(message.proof);
      return;
    }
    if (message.t !== 'stream-close') {
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'this session carries one stream only');
      return;
    }
    // The peer's own outcome has already crossed: this session owes it no sealed record, and the payload it has
    // stopped reading goes. MARKED BEFORE THE HANDLER IS RELEASED, so a late frame from it is not queued.
    this.#phase = 'concluding';
    this.#releaseStream();
    this.#discardStreamPayload();
    this.#conclude();
  }

  #onStreamData(message: ClientDataRecord): void {
    const frame = streamDataFrame(message);
    if (frame === null) {
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'a stream record carried unusable bytes');
      return;
    }
    this.#stream?.fromClient(frame);
  }

  /** The live socket as a stream handler understands one. `bufferedBytes` is HONEST (R551). */
  #downstream(): SocketDownstream {
    return {
      send: (frame, permit) => this.#sendStream(frame, permit),
      close: (code, reason) => this.#closeStream(code, reason),
      bufferedBytes: () => this.#buffered(),
    };
  }

  #buffered(): number {
    let total = 0;
    for (const record of this.#waiting) total += record.plaintext.byteLength;
    return total;
  }

  /**
   * One frame out, under the policy its own stream deserves: bytes (a terminal redraw) are DROPPED when over
   * budget or backed up, answering `0`; text (an event) may be neither dropped nor split, so the stream closes
   * `1009` (too large for a record, R550) or `1013` (the viewer fell behind, R554).
   */
  #sendStream(frame: string | Uint8Array, permit?: () => boolean): number | undefined {
    if (this.#phase !== 'streaming') return -1;
    const droppable = typeof frame !== 'string';
    const size = droppable ? frame.byteLength : frame.length;
    if (this.#buffered() > SESSION_STREAM_MAX_BUFFERED_BYTES) {
      if (droppable) return 0;
      this.#closeStream(SESSION_STREAM_CLOSES.slowReader.code, SESSION_STREAM_CLOSES.slowReader.reason);
      return -1;
    }
    const message = streamDataRecord(frame);
    if (message === null) {
      if (droppable) return 0;
      this.#closeStream(SESSION_STREAM_CLOSES.oversize.code, SESSION_STREAM_CLOSES.oversize.reason);
      return -1;
    }
    this.#queue(message, true, permit);
    return size;
  }

  /** End one stream: release the handler, seal the taxonomy, then conclude (R556). */
  #closeStream(code: number, reason: string): void {
    if (this.#phase !== 'streaming') return;
    this.#phase = 'concluding';
    this.#releaseStream();
    this.#discardStreamPayload();
    this.#queue({ t: 'stream-close', protocol: SESSION_PROTOCOL_ID, code, reason });
    this.#conclude();
  }

  #releaseStream(): void {
    const stream = this.#stream;
    this.#stream = undefined;
    stream?.close();
  }

  // ─── ending ─────────────────────────────────────────────────────────────────────────────────

  /** Everything a session holds beyond its record state. THE PHASE GOES FIRST, so no send path queues again. */
  #forget(): void {
    this.#phase = 'concluding';
    this.#credentialDeadline?.();
    this.#credentialDeadline = undefined;
    this.#lease?.();
    this.#lease = undefined;
    this.#renewal?.();
    this.#renewal = undefined;
    this.#renewNonce = undefined;
    this.#incoming.clear();
    this.#backlog.length = 0;
    this.#owesConclusion = false;
    this.#waiting.length = 0;
    this.#sealed = undefined;
    this.#plain.length = 0;
    this.#releaseStream();
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }

  /**
   * The session has an outcome and ends `4440` once that outcome has been HANDED OVER, from whichever flush
   * empties the queue (R557). It takes no reason: `4440` always carries the one shared sentence.
   */
  #conclude(): void {
    this.#owesConclusion = true;
    this.connection.outbox = this.connection.outbox.then(() => this.#settle());
  }

  #settle(): void {
    if (!this.#owesConclusion || this.#waiting.length > 0 || this.#sealed !== undefined || !this.#live()) return;
    this.#owesConclusion = false;
    this.#finish({ code: RELAY_SESSION_CONCLUDED_CLOSE_CODE, reason: RELAY_SESSION_CONCLUDED_CLOSE_REASON });
  }

  #endSession(code: number, reason: string): void {
    if (!this.#live()) return;
    this.layer.lastRefusal = `session ${code}: ${reason}`;
    this.#finish({ code, reason });
  }

  #finish(end: SessionEnd): void {
    this.#forget();
    this.#end = end;
    this.layer.sessions.delete(this);
    this.#ready();
  }

  // ─── sending ────────────────────────────────────────────────────────────────────────────────

  /**
   * Count one consumed end-to-end frame and return credit once half a window is owed. A peer that sent past the
   * allowance it was given ends the session `4430` (R97): the layer enforces the window itself, on every
   * carrier, rather than trusting a rendezvous to.
   */
  #consume(): boolean {
    this.#receive = recordConsumed(this.#receive);
    if (this.#receive.consumed > this.#receive.credited + CREDIT_WINDOW_FRAMES) {
      this.#endSession(SESSION_CLOSE_CODES.flowViolation, 'the peer exceeded its credit window');
      return false;
    }
    this.#returnCredit();
    return true;
  }

  #returnCredit(): void {
    const owed = creditToReturn({ ...this.#receive, consumed: this.#receive.consumed - this.#backlog.length });
    if (owed === 0 || this.#wireId === undefined) return;
    this.#receive = recordCredited(this.#receive, owed);
    this.#pushPlain({
      kind: FRAME_KINDS.credit,
      sessionId: this.#wireId,
      sequence: 0,
      payload: encodeCreditPayload(owed),
    });
  }

  #pushPlain(frame: SessionFrame): void {
    this.#plain.push({ sequence: frame.sequence, bytes: encodeFrame(frame) });
    this.#ready();
  }

  #sendRecord(message: DaemonRecord): void {
    this.#sendEncodedRecord({ plaintext: encodeDaemonRecord(message), payload: false });
  }

  /** A request-side record: a queue deeper than one window means the peer is not honouring the protocol. */
  #sendEncodedRecord(record: PendingRecord): void {
    const room = Math.max(0, this.#send.allowed - this.#send.sent);
    // Only records past what the peer has credited are WAITING FOR CREDIT; the rest wait only for the pull.
    if (
      record.plaintext.byteLength > MAX_PLAINTEXT_BYTES ||
      wholeRecords(this.#waiting) - room >= CREDIT_WINDOW_FRAMES
    ) {
      this.#endSession(SESSION_CLOSE_CODES.protocolError, 'this session cannot carry its own answer');
      return;
    }
    this.#waiting.push(record);
    this.#flush();
  }

  /** Queue a record whose backlog its caller has already decided about (a stream's own policy). */
  #queue(message: DaemonRecord, payload = false, permit?: () => boolean): void {
    if (!this.#live()) return;
    this.#waiting.push({
      plaintext: encodeDaemonRecord(message),
      payload,
      ...(message.t === 'res-more' ? { part: true as const } : {}),
      ...(permit === undefined ? {} : { permit }),
    });
    this.#flush();
  }

  /** Queue one control record ahead of everything waiting, behind only the record a seal already holds. */
  #queueFirst(message: DaemonRecord): void {
    const record: PendingRecord = { plaintext: encodeDaemonRecord(message), payload: false };
    const head = this.#waiting[0];
    const held = head !== undefined && (head === this.#sealing || head === this.#sealed?.pending);
    this.#waiting.splice(held ? 1 : 0, 0, record);
    this.#flush();
  }

  /** Drop stream payload a close has made explicit, never the record a seal holds or has produced. */
  #discardStreamPayload(): void {
    for (let index = this.#waiting.length - 1; index >= 0; index -= 1) {
      const record = this.#waiting[index];
      if (record?.payload === true && record !== this.#sealing && record !== this.#sealed?.pending)
        this.#waiting.splice(index, 1);
    }
  }

  /**
   * Seal the head record ahead of the pull, when the window allows and nothing is already sealed. One at a time,
   * on this connection's outbox (R555), because the nonce IS the sequence number. The produced ciphertext waits in
   * `#sealed`; its sequence is committed only when `next()` hands it over after the permit.
   */
  #flush(): void {
    this.connection.outbox = this.connection.outbox.then(async () => {
      if (!this.#live()) return;
      const channel = this.#channel;
      const pending = this.#waiting[0];
      if (this.#sealed === undefined && channel !== undefined && pending !== undefined && maySend(this.#send)) {
        this.#sealing = pending;
        const sealed = await sealRecord(this.deps.crypto, channel, pending.plaintext);
        this.#sealing = undefined;
        if (!this.#live()) return;
        if (!sealed.ok) {
          // Both refusals are checked ahead of the AEAD: no ciphertext, no sequence spent.
          this.#endSession(sealed.code, sealed.reason);
          return;
        }
        // Discarded while sealing (only stream payload may be): nothing was handed over, so nothing is spent.
        if (this.#waiting[0] !== pending) {
          this.#flush();
          return;
        }
        this.#sealed = {
          pending,
          frame: { sequence: sealed.frame.sequence, bytes: encodeFrame(sealed.frame) },
          state: sealed.state,
        };
        this.#ready();
        return;
      }
      this.#settle();
    });
  }
}

async function askHolder(mode: SessionMode | undefined, proof: ModeProof): Promise<ModeHolder | undefined> {
  if (mode?.holder === undefined) return undefined;
  try {
    return await mode.holder(proof);
  } catch {
    return undefined;
  }
}

function instant(ms: number): SessionPrincipal['leaseUntil'] {
  return instantFromEpochMs(ms);
}

/**
 * A session's name: its transcript hash, hex. Unique per session and public to both ends, so it names one
 * without being a secret. It is the {@link SessionId} a principal carries.
 */
export function transcriptKey(transcript: Uint8Array): string {
  return [...transcript].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
