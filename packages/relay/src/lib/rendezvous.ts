/**
 * The rendezvous, as a state machine with no runtime attached.
 *
 * Everything a Durable Object decides is decided here, in a function from state and one event to
 * new state and a list of effects. The Cloudflare adapter around it only moves bytes and clocks.
 * That split is what makes a socket-holding, hibernating, single-instance service testable at all:
 * every rule below is proved by a plain unit test rather than by reasoning about an edge runtime.
 *
 * The rules it enforces, and why each one is what it is:
 *
 * **One daemon, and the incumbent wins.** A live authenticated daemon holds the rendezvous. A
 * second claim is refused, not accepted and not raced. A daemon whose network dropped is therefore
 * locked out until the sweep evicts its dead socket — bounded by the heartbeat grace window, and
 * chosen deliberately: the other resolution, letting the newer socket win, hands the rendezvous to
 * whoever connected most recently, which is the wrong answer whenever it matters.
 *
 * **The one exception is a handover.** A daemon that asked for `claim-handover` is given a random
 * token in `claimed`, over its own socket and nowhere else. A VERIFIED claim that names the
 * incumbent's token in `replaces` supersedes the incumbent at once: the old socket is closed `4410`,
 * its sessions end as a departure ends them, and the new socket holds the slot under a NEW token. A
 * claim with no token, a wrong one, or no feature still meets "the incumbent wins" — a second copy of
 * the same key never saw the token, so it can neither steal the rendezvous nor flap it.
 *
 * **Many clients, each in its own session.** A phone and a laptop can both be connected. There is
 * no shared "the client" slot to be ambiguous about, and a client may only ever address the one
 * session identifier the rendezvous assigned it.
 *
 * **It forwards; it does not read.** For an end-to-end frame this machine looks at the header and
 * copies the payload. It has no branch that decodes one, which is the point: the property has to
 * be structural, not a promise.
 *
 * **It forwards; it does not queue.** A frame is delivered immediately or the session ends. What
 * bounds memory is the credit window, not a buffer with a hopeful limit on it.
 *
 * **Absence is never benign.** A missing daemon, an unknown socket, a duplicate session
 * identifier, a heartbeat with no evidence behind it: each ends a connection rather than assuming
 * the harmless reading.
 */

import { toBase64Url } from './binary.ts';
import type { ClaimVerdict } from './claim.ts';
import {
  CLAIM_DEADLINE_SECONDS,
  CONNECTION_RATE_LIMIT,
  CONNECTION_RATE_WINDOW_SECONDS,
  HEARTBEAT_GRACE_SECONDS,
  HEARTBEAT_SECONDS,
  MAX_PENDING_DAEMON_SOCKETS,
  MAX_SESSIONS_PER_RENDEZVOUS,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  type RelayFeature,
} from './constants.ts';
import { type ControlMessage, decodeControlMessage, encodeControlMessage, RELAY_LIMITS } from './control.ts';
import { grantCredit, maySend, newSendWindow, recordSent, type SendWindow } from './flow.ts';
import {
  decodeCreditPayload,
  FRAME_KINDS,
  isRendezvousSessionId,
  RENDEZVOUS_SESSION_ID,
  type RelayFrame,
  type SessionId,
} from './frames.ts';

export interface PendingDaemonSocket {
  readonly socketId: string;
  readonly challenge: Uint8Array;
  readonly host: string;
  readonly deadlineAt: number;
  /** True once a claim from this socket is out for verification, so a second claim is refused. */
  readonly verifying: boolean;
  /** What the daemon asked for on its route that this rendezvous speaks. Absent is none. */
  readonly features?: readonly RelayFeature[];
  /** `claim-handover` only: the token this socket is given if its claim is accepted. Minted by the adapter. */
  readonly handover?: string;
  /** `claim-handover` only: the token its claim named in `replaces`, held until the verdict. */
  readonly replaces?: string;
}

export interface DaemonSlot {
  readonly socketId: string;
  readonly since: number;
  readonly features?: readonly RelayFeature[];
  /** `claim-handover` only: what a claim must name in `replaces` to supersede this socket. Secret. */
  readonly handover?: string;
  /**
   * The stored state had lost this claim and {@link reconcileRendezvous} restored it from the socket's
   * own claim marker. Nothing about the sessions it was serving survived, so a frame it sends for one
   * of them is answered with that session's `closed` rather than read as a protocol error.
   */
  readonly restored?: boolean;
}

export interface RendezvousSession {
  readonly sessionId: SessionId;
  readonly clientSocketId: string;
  readonly since: number;
  /** What the client may still send toward the daemon. */
  readonly fromClient: SendWindow;
  /** What the daemon may still send toward this client. */
  readonly fromDaemon: SendWindow;
}

export interface RendezvousState {
  /** The fingerprint this rendezvous is addressed by. One daemon's state is never another's. */
  readonly daemonId: string;
  readonly daemon: DaemonSlot | null;
  readonly pending: readonly PendingDaemonSocket[];
  readonly sessions: readonly RendezvousSession[];
  /** CLIENT arrival timestamps still inside the rate window. */
  readonly arrivals: readonly number[];
  /**
   * DAEMON arrival timestamps still inside the rate window — a budget of its own.
   *
   * THE TWO USED TO SHARE ONE WINDOW, and refused arrivals count. So while a daemon was away — a relay
   * restart, a dropped network — every client retrying got `4404` and still spent the window, and the
   * returning daemon's own redials were refused `4429` for as long as the clients kept trying: the
   * one socket that could end the outage was the one locked out of it. Clients still bound each
   * other; they can no longer bound the daemon.
   *
   * Optional because a Durable Object reloads state an earlier deploy stored; absent reads as empty.
   */
  readonly daemonArrivals?: readonly number[];
  /**
   * Sessions THIS rendezvous ended while the daemon may still have frames in flight for them.
   *
   * Optional because a Durable Object reloads state an earlier deploy stored, and that state has no
   * such field; absent reads as empty. See {@link ENDED_SESSION_GRACE_MS}.
   */
  readonly ended?: readonly EndedSession[];
}

/** One session this rendezvous ended, and when, so a daemon frame racing the close can be dropped. */
export interface EndedSession {
  readonly sessionId: string;
  readonly at: number;
}

/**
 * How long a session this rendezvous ended is remembered.
 *
 * ENDING A SESSION IS ASYNCHRONOUS AND FRAMES CROSS THE CLOSE. When a client hangs up, the daemon
 * keeps sending for that session until the `closed` this machine sends it arrives, so a daemon frame
 * naming a session that just ended is the ordinary consequence of the close. Reading it as a protocol
 * error used to drop the DAEMON'S socket — every other client's session with it, on any client
 * disconnect that happened to race an answer. The window is the heartbeat grace: a daemon whose
 * in-flight frames take longer than that is one the sweep has already declared dead. A daemon frame
 * for a session this rendezvous never opened, or one the daemon ITSELF closed, still ends the socket.
 */
export const ENDED_SESSION_GRACE_MS = HEARTBEAT_GRACE_SECONDS * 1000;

/** A backstop on {@link RendezvousState.ended}; arrivals are already rate-limited well below it. */
export const MAX_ENDED_SESSIONS = 64;

export function initialRendezvousState(daemonId: string): RendezvousState {
  return { daemonId, daemon: null, pending: [], sessions: [], arrivals: [] };
}

export type RendezvousEvent =
  | {
      readonly kind: 'daemon-arrived';
      readonly socketId: string;
      readonly challenge: Uint8Array;
      readonly host: string;
      readonly at: number;
      readonly features?: readonly RelayFeature[];
      /** Random bytes, minted by the adapter so this machine stays pure; used only with `claim-handover`. */
      readonly handover?: string;
    }
  | { readonly kind: 'client-arrived'; readonly socketId: string; readonly sessionId: SessionId; readonly at: number }
  | { readonly kind: 'claim-verdict'; readonly socketId: string; readonly verdict: ClaimVerdict; readonly at: number }
  | { readonly kind: 'frame'; readonly socketId: string; readonly frame: RelayFrame; readonly at: number }
  | { readonly kind: 'socket-closed'; readonly socketId: string; readonly at: number }
  /**
   * The sweep. `lastSeen` is what the runtime observed per socket, and a socket missing from it
   * has no evidence of life — which is read as dead, not as fine.
   */
  | { readonly kind: 'alarm'; readonly at: number; readonly lastSeen: Readonly<Record<string, number>> };

export type RendezvousEffect =
  | { readonly kind: 'send'; readonly socketId: string; readonly frame: RelayFrame }
  | { readonly kind: 'close'; readonly socketId: string; readonly code: number; readonly reason: string }
  /** Verify a claim out of band, then feed the answer back as a `claim-verdict` event. */
  | {
      readonly kind: 'verify-claim';
      readonly socketId: string;
      readonly host: string;
      readonly challenge: Uint8Array;
      readonly publicKey: string;
      readonly signature: string;
    }
  | { readonly kind: 'schedule-alarm'; readonly at: number };

export interface RendezvousStep {
  readonly state: RendezvousState;
  readonly effects: readonly RendezvousEffect[];
  /**
   * Set when the only thing this step changed is one session's credit window, because a frame or a
   * credit grant moved across it. Every relayed frame is such a step, so it is the one that decides
   * what forwarding costs: the adapter persists it without waiting for the write to be confirmed (see
   * `applyStep` in `worker.ts`). Absent on every step that admits, ends or reshapes anything.
   */
  readonly windowOnly?: true;
}

// ─── effect helpers ───────────────────────────────────────────────────────────────────────────

function sendControl(socketId: string, sessionId: SessionId, message: ControlMessage): RendezvousEffect {
  return {
    kind: 'send',
    socketId,
    frame: { kind: FRAME_KINDS.control, sessionId, sequence: 0, payload: encodeControlMessage(message) },
  };
}

/** A refusal always says why on the wire before it closes, so a peer never has to guess. */
function refuse(socketId: string, code: number, reason: string): readonly RendezvousEffect[] {
  return [
    sendControl(socketId, RENDEZVOUS_SESSION_ID, { t: 'error', code, reason }),
    { kind: 'close', socketId, code, reason },
  ];
}

function endSession(session: RendezvousSession, code: number, reason: string): readonly RendezvousEffect[] {
  return [
    sendControl(session.clientSocketId, session.sessionId, { t: 'closed', code, reason }),
    { kind: 'close', socketId: session.clientSocketId, code, reason },
  ];
}

/** Tell the daemon a session it was serving has ended. Its own socket stays up for the others. */
function tellDaemon(
  state: RendezvousState,
  session: RendezvousSession,
  code: number,
  reason: string,
): readonly RendezvousEffect[] {
  return state.daemon === null
    ? []
    : [sendControl(state.daemon.socketId, session.sessionId, { t: 'closed', code, reason })];
}

function nextAlarm(state: RendezvousState, at: number): readonly RendezvousEffect[] {
  const live = state.daemon !== null || state.pending.length > 0 || state.sessions.length > 0;
  return live ? [{ kind: 'schedule-alarm', at: at + HEARTBEAT_SECONDS * 1000 }] : [];
}

/** Counts one arrival against its role's window — refused arrivals included, which is what bounds the cost. */
function withinRateLimit(
  state: RendezvousState,
  at: number,
  role: 'daemon' | 'client',
): { readonly state: RendezvousState; readonly allowed: boolean } {
  const cutoff = at - CONNECTION_RATE_WINDOW_SECONDS * 1000;
  const recent = [
    ...(role === 'daemon' ? (state.daemonArrivals ?? []) : state.arrivals).filter(stamp => stamp > cutoff),
    at,
  ];
  return {
    state: role === 'daemon' ? { ...state, daemonArrivals: recent } : { ...state, arrivals: recent },
    allowed: recent.length <= CONNECTION_RATE_LIMIT,
  };
}

function sessionFor(state: RendezvousState, sessionId: SessionId): RendezvousSession | undefined {
  return state.sessions.find(session => session.sessionId.text === sessionId.text);
}

function withoutSession(state: RendezvousState, sessionId: SessionId): RendezvousState {
  return { ...state, sessions: state.sessions.filter(session => session.sessionId.text !== sessionId.text) };
}

function replaceSession(state: RendezvousState, updated: RendezvousSession): RendezvousState {
  return {
    ...state,
    sessions: state.sessions.map(session => (session.sessionId.text === updated.sessionId.text ? updated : session)),
  };
}

/**
 * Remove a session this rendezvous ended on its own initiative, remembering it for the daemon's
 * stragglers. Stale entries are pruned in the same breath, so the list only grows with real endings.
 */
function endedByRendezvous(state: RendezvousState, sessionId: SessionId, at: number): RendezvousState {
  const kept = (state.ended ?? []).filter(
    entry => entry.sessionId !== sessionId.text && entry.at + ENDED_SESSION_GRACE_MS > at,
  );
  return {
    ...withoutSession(state, sessionId),
    ended: [...kept.slice(Math.max(0, kept.length - MAX_ENDED_SESSIONS + 1)), { sessionId: sessionId.text, at }],
  };
}

function recentlyEnded(state: RendezvousState, sessionId: SessionId, at: number): boolean {
  return (state.ended ?? []).some(
    entry => entry.sessionId === sessionId.text && entry.at + ENDED_SESSION_GRACE_MS > at,
  );
}

function dropPending(state: RendezvousState, socketId: string): RendezvousState {
  return { ...state, pending: state.pending.filter(entry => entry.socketId !== socketId) };
}

// ─── arrivals ─────────────────────────────────────────────────────────────────────────────────

function onDaemonArrived(
  state: RendezvousState,
  event: Extract<RendezvousEvent, { kind: 'daemon-arrived' }>,
): RendezvousStep {
  const limited = withinRateLimit(state, event.at, 'daemon');
  if (!limited.allowed) {
    return {
      state: limited.state,
      effects: refuse(event.socketId, RELAY_CLOSE_CODES.rendezvousBusy, 'too many connections'),
    };
  }
  // A socket that asked for `claim-handover` may be holding the token that supersedes the incumbent, and
  // only its claim says so. It is challenged like any other, and refused `4409` at the verdict if it is not.
  if (limited.state.daemon !== null && !asksForHandover(event.features)) {
    return {
      state: limited.state,
      effects: refuse(event.socketId, RELAY_CLOSE_CODES.rendezvousClaimed, 'a daemon already holds this rendezvous'),
    };
  }
  if (limited.state.pending.length >= MAX_PENDING_DAEMON_SOCKETS) {
    return {
      state: limited.state,
      effects: refuse(event.socketId, RELAY_CLOSE_CODES.rendezvousBusy, 'too many unproved daemon sockets'),
    };
  }
  const pending: PendingDaemonSocket = {
    socketId: event.socketId,
    challenge: event.challenge,
    host: event.host,
    deadlineAt: event.at + CLAIM_DEADLINE_SECONDS * 1000,
    verifying: false,
    ...(event.features === undefined || event.features.length === 0 ? {} : { features: event.features }),
    ...(asksForHandover(event.features) && event.handover !== undefined ? { handover: event.handover } : {}),
  };
  const next = { ...limited.state, pending: [...limited.state.pending, pending] };
  return {
    state: next,
    effects: [
      sendControl(event.socketId, RENDEZVOUS_SESSION_ID, {
        t: 'challenge',
        protocol: RELAY_PROTOCOL_ID,
        nonce: toBase64Url(event.challenge),
        host: event.host,
        deadlineSeconds: CLAIM_DEADLINE_SECONDS,
      }),
      ...nextAlarm(next, event.at),
    ],
  };
}

function onClientArrived(
  state: RendezvousState,
  event: Extract<RendezvousEvent, { kind: 'client-arrived' }>,
): RendezvousStep {
  const limited = withinRateLimit(state, event.at, 'client');
  if (!limited.allowed) {
    return {
      state: limited.state,
      effects: refuse(event.socketId, RELAY_CLOSE_CODES.rendezvousBusy, 'too many connections'),
    };
  }
  const daemon = limited.state.daemon;
  if (daemon === null) {
    return {
      state: limited.state,
      effects: refuse(event.socketId, RELAY_CLOSE_CODES.daemonAbsent, 'no daemon holds this rendezvous'),
    };
  }
  if (limited.state.sessions.length >= MAX_SESSIONS_PER_RENDEZVOUS) {
    return {
      state: limited.state,
      effects: refuse(event.socketId, RELAY_CLOSE_CODES.rendezvousBusy, 'session limit reached'),
    };
  }
  if (isRendezvousSessionId(event.sessionId) || sessionFor(limited.state, event.sessionId) !== undefined) {
    return {
      state: limited.state,
      effects: refuse(event.socketId, RELAY_CLOSE_CODES.relayInternal, 'session identifier is not usable'),
    };
  }
  const session: RendezvousSession = {
    sessionId: event.sessionId,
    clientSocketId: event.socketId,
    since: event.at,
    fromClient: newSendWindow(),
    fromDaemon: newSendWindow(),
  };
  const next = { ...limited.state, sessions: [...limited.state.sessions, session] };
  return {
    state: next,
    effects: [
      sendControl(event.socketId, event.sessionId, { t: 'ready', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS }),
      sendControl(daemon.socketId, event.sessionId, { t: 'open' }),
      ...nextAlarm(next, event.at),
    ],
  };
}

// ─── claim ────────────────────────────────────────────────────────────────────────────────────

function onClaimVerdict(
  state: RendezvousState,
  event: Extract<RendezvousEvent, { kind: 'claim-verdict' }>,
): RendezvousStep {
  const pending = state.pending.find(entry => entry.socketId === event.socketId);
  if (pending === undefined) return { state, effects: [] };
  const withoutPending = dropPending(state, event.socketId);

  if (!event.verdict.ok) {
    return {
      state: withoutPending,
      effects: refuse(event.socketId, RELAY_CLOSE_CODES.claimRejected, event.verdict.reason),
    };
  }
  const incumbent = withoutPending.daemon;
  if (incumbent !== null && !supersedes(pending, incumbent)) {
    return {
      state: withoutPending,
      effects: refuse(event.socketId, RELAY_CLOSE_CODES.rendezvousClaimed, 'a daemon already holds this rendezvous'),
    };
  }
  // The incumbent's departure, said once: its sessions end exactly as `dropDaemon` ends them, and its
  // socket is closed `4410`. No frame is sent on it first — it is the socket the daemon found dead.
  const superseded =
    incumbent === null ? null : dropDaemon(withoutPending, RELAY_CLOSE_CODES.daemonAbsent, 'the daemon reconnected');
  const features = pending.features === undefined ? {} : { features: [...pending.features] };
  const handover = pending.handover === undefined ? {} : { handover: pending.handover };
  const next: RendezvousState = {
    ...(superseded?.state ?? withoutPending),
    daemon: { socketId: event.socketId, since: event.at, ...features, ...handover },
  };
  return {
    state: next,
    effects: [
      ...(superseded?.effects ?? []),
      ...(incumbent === null
        ? []
        : [
            {
              kind: 'close',
              socketId: incumbent.socketId,
              code: RELAY_CLOSE_CODES.claimLost,
              reason: 'replaced by a fresh claim from the same daemon',
            } satisfies RendezvousEffect,
          ]),
      sendControl(event.socketId, RENDEZVOUS_SESSION_ID, {
        t: 'claimed',
        protocol: RELAY_PROTOCOL_ID,
        limits: RELAY_LIMITS,
        ...features,
        ...handover,
      }),
      ...nextAlarm(next, event.at),
    ],
  };
}

function asksForHandover(features: readonly RelayFeature[] | undefined): boolean {
  return features?.includes('claim-handover') === true;
}

/**
 * Compare two tokens without stopping at the first difference, so how long a guess takes says nothing
 * about how much of it was right. A length mismatch is folded into the same pass rather than returned early.
 */
export function handoverTokensMatch(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/** Whether a verified claim holds the token its incumbent issued — which is the only way to displace one. */
function supersedes(pending: PendingDaemonSocket, incumbent: DaemonSlot): boolean {
  if (!asksForHandover(pending.features)) return false;
  if (pending.replaces === undefined || incumbent.handover === undefined) return false;
  return handoverTokensMatch(pending.replaces, incumbent.handover);
}

function onPendingFrame(state: RendezvousState, pending: PendingDaemonSocket, frame: RelayFrame): RendezvousStep {
  const reject = (reason: string): RendezvousStep => ({
    state: dropPending(state, pending.socketId),
    effects: refuse(pending.socketId, RELAY_CLOSE_CODES.protocolError, reason),
  });
  if (frame.kind !== FRAME_KINDS.control || !isRendezvousSessionId(frame.sessionId)) return reject('expected a claim');
  const message = decodeControlMessage(frame.payload);
  if (message === null || message.t !== 'claim') return reject('expected a claim');
  if (pending.verifying) return reject('a claim from this socket is already being verified');
  if (message.replaces !== undefined && !asksForHandover(pending.features)) {
    return reject('replaces needs the claim-handover feature');
  }
  return {
    state: {
      ...state,
      pending: state.pending.map(entry =>
        entry.socketId === pending.socketId
          ? { ...entry, verifying: true, ...(message.replaces === undefined ? {} : { replaces: message.replaces }) }
          : entry,
      ),
    },
    effects: [
      {
        kind: 'verify-claim',
        socketId: pending.socketId,
        host: pending.host,
        challenge: pending.challenge,
        publicKey: message.publicKey,
        signature: message.signature,
      },
    ],
  };
}

// ─── forwarding ───────────────────────────────────────────────────────────────────────────────

/** One direction of one session: who receives, which window governs it, which window it credits. */
interface Direction {
  readonly toSocketId: string;
  readonly send: SendWindow;
  readonly credits: SendWindow;
  readonly withSend: (session: RendezvousSession, window: SendWindow) => RendezvousSession;
  readonly withCredits: (session: RendezvousSession, window: SendWindow) => RendezvousSession;
}

/**
 * Move one frame across the rendezvous.
 *
 * The payload is never decoded. The window is checked before the frame moves, so a producer that
 * ignores its credit is refused at the door rather than buffered behind it.
 *
 * A credit frame that grants nothing is itself a violation. Credit is clamped to the window, so a
 * peer could otherwise send credit frames forever at no cost to itself and at a real cost to
 * whoever pays for the relay. Requiring every credit frame to do something bounds their number by
 * the number of frames actually delivered.
 */
function forward(
  state: RendezvousState,
  session: RendezvousSession,
  frame: RelayFrame,
  direction: Direction,
  at: number,
): RendezvousStep {
  const endWithViolation = (reason: string): RendezvousStep => ({
    state: endedByRendezvous(state, session.sessionId, at),
    effects: [
      ...endSession(session, RELAY_CLOSE_CODES.flowViolation, reason),
      ...tellDaemon(state, session, RELAY_CLOSE_CODES.flowViolation, reason),
    ],
  });

  if (frame.kind === FRAME_KINDS.credit) {
    const frames = decodeCreditPayload(frame.payload);
    if (frames === null) return endWithViolation('malformed credit');
    const credited = grantCredit(direction.credits, frames);
    if (credited.allowed === direction.credits.allowed) return endWithViolation('credit grant had no effect');
    return {
      state: replaceSession(state, direction.withCredits(session, credited)),
      effects: [{ kind: 'send', socketId: direction.toSocketId, frame }],
      windowOnly: true,
    };
  }
  if (!maySend(direction.send)) return endWithViolation('sender exceeded its credit window');
  return {
    state: replaceSession(state, direction.withSend(session, recordSent(direction.send))),
    effects: [{ kind: 'send', socketId: direction.toSocketId, frame }],
    windowOnly: true,
  };
}

function onDaemonFrame(state: RendezvousState, daemon: DaemonSlot, frame: RelayFrame, at: number): RendezvousStep {
  if (isClaimProbe(frame)) {
    return { state, effects: [sendControl(daemon.socketId, RENDEZVOUS_SESSION_ID, { t: 'held' })] };
  }
  const session = sessionFor(state, frame.sessionId);
  if (session === undefined) {
    // In flight across a close this rendezvous made: dropped, and the daemon keeps its socket.
    if (recentlyEnded(state, frame.sessionId, at)) return { state, effects: [] };
    if (daemon.restored === true && !isRendezvousSessionId(frame.sessionId)) {
      // A session from before the claim was restored. Its client's state went with the stored state, so
      // the daemon is told it ended — once; the rest of its stragglers are dropped as `ended` ones are.
      return {
        state: endedByRendezvous(state, frame.sessionId, at),
        effects: [
          sendControl(daemon.socketId, frame.sessionId, {
            t: 'closed',
            code: RELAY_CLOSE_CODES.relayInternal,
            reason: 'the rendezvous lost this session',
          }),
        ],
      };
    }
    return { state, effects: refuse(daemon.socketId, RELAY_CLOSE_CODES.protocolError, 'frame names no live session') };
  }
  if (frame.kind === FRAME_KINDS.control) {
    const message = decodeControlMessage(frame.payload);
    if (message === null || message.t !== 'closed') {
      return {
        state,
        effects: refuse(daemon.socketId, RELAY_CLOSE_CODES.protocolError, 'unexpected control from a daemon'),
      };
    }
    return {
      state: withoutSession(state, session.sessionId),
      effects: endSession(session, message.code, message.reason),
    };
  }
  return forward(
    state,
    session,
    frame,
    {
      toSocketId: session.clientSocketId,
      send: session.fromDaemon,
      credits: session.fromClient,
      withSend: (target, window) => ({ ...target, fromDaemon: window }),
      withCredits: (target, window) => ({ ...target, fromClient: window }),
    },
    at,
  );
}

function onClientFrame(
  state: RendezvousState,
  session: RendezvousSession,
  frame: RelayFrame,
  at: number,
): RendezvousStep {
  const daemon = state.daemon;
  if (daemon === null) {
    return {
      state: withoutSession(state, session.sessionId),
      effects: endSession(session, RELAY_CLOSE_CODES.daemonAbsent, 'the daemon left'),
    };
  }
  const endBoth = (code: number, reason: string): RendezvousStep => ({
    state: endedByRendezvous(state, session.sessionId, at),
    effects: [...endSession(session, code, reason), ...tellDaemon(state, session, code, reason)],
  });
  if (frame.sessionId.text !== session.sessionId.text) {
    return endBoth(RELAY_CLOSE_CODES.protocolError, 'frame addresses another session');
  }
  if (frame.kind === FRAME_KINDS.control) {
    const message = decodeControlMessage(frame.payload);
    if (message === null || message.t !== 'closed') {
      return endBoth(RELAY_CLOSE_CODES.protocolError, 'unexpected control from a client');
    }
    return endBoth(message.code, message.reason);
  }
  return forward(
    state,
    session,
    frame,
    {
      toSocketId: daemon.socketId,
      send: session.fromClient,
      credits: session.fromDaemon,
      withSend: (target, window) => ({ ...target, fromClient: window }),
      withCredits: (target, window) => ({ ...target, fromDaemon: window }),
    },
    at,
  );
}

function onFrame(state: RendezvousState, event: Extract<RendezvousEvent, { kind: 'frame' }>): RendezvousStep {
  const pending = state.pending.find(entry => entry.socketId === event.socketId);
  if (pending !== undefined) return onPendingFrame(state, pending, event.frame);
  if (state.daemon !== null && state.daemon.socketId === event.socketId) {
    return onDaemonFrame(state, state.daemon, event.frame, event.at);
  }
  const session = state.sessions.find(entry => entry.clientSocketId === event.socketId);
  if (session !== undefined) return onClientFrame(state, session, event.frame, event.at);
  if (isClaimProbe(event.frame)) {
    // A daemon asking after a claim this state does not name. Its socket is live — it just spoke — so
    // the slot is what was lost, and the remedy is a fresh claim rather than a guess about the socket.
    return {
      state,
      effects: refuse(event.socketId, RELAY_CLOSE_CODES.claimLost, 'this rendezvous no longer holds the claim'),
    };
  }
  return {
    state,
    effects: refuse(event.socketId, RELAY_CLOSE_CODES.protocolError, 'socket is not part of this rendezvous'),
  };
}

// ─── departures ───────────────────────────────────────────────────────────────────────────────

function dropDaemon(state: RendezvousState, code: number, reason: string): RendezvousStep {
  return {
    // A new daemon is a new socket, and nothing the old one had in flight can reach this one.
    state: { ...state, daemon: null, sessions: [], ended: [] },
    effects: state.sessions.flatMap(session => endSession(session, code, reason)),
  };
}

function onSocketClosed(
  state: RendezvousState,
  event: Extract<RendezvousEvent, { kind: 'socket-closed' }>,
): RendezvousStep {
  if (state.pending.some(entry => entry.socketId === event.socketId)) {
    return { state: dropPending(state, event.socketId), effects: [] };
  }
  if (state.daemon !== null && state.daemon.socketId === event.socketId) {
    return dropDaemon(state, RELAY_CLOSE_CODES.daemonAbsent, 'the daemon disconnected');
  }
  const session = state.sessions.find(entry => entry.clientSocketId === event.socketId);
  if (session === undefined) return { state, effects: [] };
  return {
    state: endedByRendezvous(state, session.sessionId, event.at),
    effects: tellDaemon(state, session, RELAY_CLOSE_CODES.daemonAbsent, 'the client disconnected'),
  };
}

/**
 * The sweep.
 *
 * A socket with no recorded activity since it arrived, older than the grace window, is gone as far
 * as this rendezvous is concerned. The alternative — waiting for a close frame that a dead laptop
 * will never send — is how a rendezvous ends up refusing its own daemon's reconnection forever.
 */
function onAlarm(state: RendezvousState, event: Extract<RendezvousEvent, { kind: 'alarm' }>): RendezvousStep {
  const effects: RendezvousEffect[] = [];
  let next = state;

  for (const pending of state.pending) {
    if (pending.deadlineAt > event.at) continue;
    next = dropPending(next, pending.socketId);
    effects.push(...refuse(pending.socketId, RELAY_CLOSE_CODES.claimTimeout, 'claim deadline expired'));
  }

  const stale = (socketId: string, since: number): boolean =>
    Math.max(event.lastSeen[socketId] ?? 0, since) + HEARTBEAT_GRACE_SECONDS * 1000 <= event.at;

  const daemon = next.daemon;
  if (daemon !== null && stale(daemon.socketId, daemon.since)) {
    const reason = 'the daemon stopped answering';
    const dropped = dropDaemon(next, RELAY_CLOSE_CODES.heartbeatTimeout, reason);
    next = dropped.state;
    effects.push(...dropped.effects, {
      kind: 'close',
      socketId: daemon.socketId,
      code: RELAY_CLOSE_CODES.heartbeatTimeout,
      reason,
    });
  }

  for (const session of next.sessions) {
    if (!stale(session.clientSocketId, session.since)) continue;
    const reason = 'the client stopped answering';
    next = endedByRendezvous(next, session.sessionId, event.at);
    effects.push(
      ...endSession(session, RELAY_CLOSE_CODES.heartbeatTimeout, reason),
      ...tellDaemon(next, session, RELAY_CLOSE_CODES.heartbeatTimeout, reason),
    );
  }

  return { state: next, effects: [...effects, ...nextAlarm(next, event.at)] };
}

// ─── reconciliation ───────────────────────────────────────────────────────────────────────────

/** A daemon's `{ "t": "probe" }` on the rendezvous's own session: hop-by-hop, never forwarded or metered. */
export function isClaimProbe(frame: RelayFrame): boolean {
  if (frame.kind !== FRAME_KINDS.control || !isRendezvousSessionId(frame.sessionId)) return false;
  return decodeControlMessage(frame.payload)?.t === 'probe';
}

/**
 * One socket the runtime still holds, as the rendezvous marked it.
 *
 * `claim` is present only while the socket holds a proved claim: it is written on the socket itself the
 * moment the claim is accepted and erased before this side ever closes it, so it travels with the
 * socket through hibernation, eviction and anything that happens to the stored state.
 */
export interface AttachedSocket {
  readonly socketId: string;
  readonly claim?: { readonly features?: readonly RelayFeature[]; readonly handover?: string };
}

/**
 * MAKE THE STORED STATE AGREE WITH THE SOCKETS THAT ARE ACTUALLY THERE, or null when it already does.
 *
 * The state is a document in storage and the sockets are the runtime's, and nothing used to compare
 * them. When they disagreed the rendezvous believed the document: a daemon socket the runtime still
 * held — still answered `fy-pong` by the auto-responder, so the daemon was sure it was connected — was
 * no longer named as the holder, and every phone was told `4404` until somebody restarted the daemon.
 * So every handler runs this first, and the sockets win wherever they can prove something:
 *
 * - a slot, pending socket or session whose socket the runtime no longer holds is gone, exactly as if
 *   its close had been delivered (a close that a reset swallowed is still a close);
 * - an empty slot with a claimed socket attached is that socket's again — its claim was proved, its
 *   socket is live, and only the document forgot. It is marked `restored`, because what it was
 *   carrying was not restored with it;
 * - any OTHER claimed socket is refused `4410`, so a daemon on a socket the slot does not name finds
 *   out at once and claims again, instead of sitting on a socket nobody can reach it through.
 */
export function reconcileRendezvous(
  state: RendezvousState,
  attached: readonly AttachedSocket[],
  at: number,
): RendezvousStep | null {
  const present = new Set(attached.map(socket => socket.socketId));
  const effects: RendezvousEffect[] = [];
  let next: RendezvousState = { ...state, pending: state.pending.filter(entry => present.has(entry.socketId)) };
  let changed = next.pending.length !== state.pending.length;

  if (next.daemon !== null && !present.has(next.daemon.socketId)) {
    const dropped = dropDaemon(next, RELAY_CLOSE_CODES.daemonAbsent, 'the daemon disconnected');
    next = dropped.state;
    effects.push(...dropped.effects);
    changed = true;
  }

  for (const session of next.sessions) {
    if (present.has(session.clientSocketId)) continue;
    effects.push(...tellDaemon(next, session, RELAY_CLOSE_CODES.daemonAbsent, 'the client disconnected'));
    next = endedByRendezvous(next, session.sessionId, at);
    changed = true;
  }

  const claimants = attached.filter(socket => socket.claim !== undefined);
  const restored = claimants[0];
  if (next.daemon === null && restored !== undefined) {
    const features = restored.claim?.features;
    const handover = restored.claim?.handover;
    next = {
      ...next,
      daemon: {
        socketId: restored.socketId,
        since: at,
        restored: true,
        ...(features === undefined || features.length === 0 ? {} : { features: [...features] }),
        ...(handover === undefined ? {} : { handover }),
      },
    };
    changed = true;
  }
  for (const socket of claimants) {
    if (socket.socketId === next.daemon?.socketId) continue;
    effects.push(...refuse(socket.socketId, RELAY_CLOSE_CODES.claimLost, 'this rendezvous no longer holds the claim'));
    changed = true;
  }

  return changed ? { state: next, effects: [...effects, ...nextAlarm(next, at)] } : null;
}

// ─── entry point ──────────────────────────────────────────────────────────────────────────────

export function reduceRendezvous(state: RendezvousState, event: RendezvousEvent): RendezvousStep {
  switch (event.kind) {
    case 'daemon-arrived':
      return onDaemonArrived(state, event);
    case 'client-arrived':
      return onClientArrived(state, event);
    case 'claim-verdict':
      return onClaimVerdict(state, event);
    case 'frame':
      return onFrame(state, event);
    case 'socket-closed':
      return onSocketClosed(state, event);
    case 'alarm':
      return onAlarm(state, event);
  }
}
