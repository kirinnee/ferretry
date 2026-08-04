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

import type { ClaimVerdict } from './claim.ts';
import { toBase64Url } from './binary.ts';
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
} from './constants.ts';
import { type ControlMessage, decodeControlMessage, encodeControlMessage, RELAY_LIMITS } from './control.ts';
import { grantCredit, maySend, newSendWindow, recordSent, type SendWindow } from './flow.ts';
import {
  decodeCreditPayload,
  FRAME_KINDS,
  isRendezvousSessionId,
  type RelayFrame,
  RENDEZVOUS_SESSION_ID,
  type SessionId,
} from './frames.ts';

export interface PendingDaemonSocket {
  readonly socketId: string;
  readonly challenge: Uint8Array;
  readonly host: string;
  readonly deadlineAt: number;
  /** True once a claim from this socket is out for verification, so a second claim is refused. */
  readonly verifying: boolean;
}

export interface DaemonSlot {
  readonly socketId: string;
  readonly since: number;
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
  /** Arrival timestamps still inside the rate window. */
  readonly arrivals: readonly number[];
}

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

function withinRateLimit(
  state: RendezvousState,
  at: number,
): { readonly state: RendezvousState; readonly allowed: boolean } {
  const cutoff = at - CONNECTION_RATE_WINDOW_SECONDS * 1000;
  const arrivals = [...state.arrivals.filter(stamp => stamp > cutoff), at];
  return { state: { ...state, arrivals }, allowed: arrivals.length <= CONNECTION_RATE_LIMIT };
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

function dropPending(state: RendezvousState, socketId: string): RendezvousState {
  return { ...state, pending: state.pending.filter(entry => entry.socketId !== socketId) };
}

// ─── arrivals ─────────────────────────────────────────────────────────────────────────────────

function onDaemonArrived(
  state: RendezvousState,
  event: Extract<RendezvousEvent, { kind: 'daemon-arrived' }>,
): RendezvousStep {
  const limited = withinRateLimit(state, event.at);
  if (!limited.allowed) {
    return {
      state: limited.state,
      effects: refuse(event.socketId, RELAY_CLOSE_CODES.rendezvousBusy, 'too many connections'),
    };
  }
  if (limited.state.daemon !== null) {
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
  const limited = withinRateLimit(state, event.at);
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
  if (withoutPending.daemon !== null) {
    return {
      state: withoutPending,
      effects: refuse(event.socketId, RELAY_CLOSE_CODES.rendezvousClaimed, 'a daemon already holds this rendezvous'),
    };
  }
  const next: RendezvousState = { ...withoutPending, daemon: { socketId: event.socketId, since: event.at } };
  return {
    state: next,
    effects: [
      sendControl(event.socketId, RENDEZVOUS_SESSION_ID, {
        t: 'claimed',
        protocol: RELAY_PROTOCOL_ID,
        limits: RELAY_LIMITS,
      }),
      ...nextAlarm(next, event.at),
    ],
  };
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
  return {
    state: {
      ...state,
      pending: state.pending.map(entry =>
        entry.socketId === pending.socketId ? { ...entry, verifying: true } : entry,
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
): RendezvousStep {
  const endWithViolation = (reason: string): RendezvousStep => ({
    state: withoutSession(state, session.sessionId),
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
    };
  }
  if (!maySend(direction.send)) return endWithViolation('sender exceeded its credit window');
  return {
    state: replaceSession(state, direction.withSend(session, recordSent(direction.send))),
    effects: [{ kind: 'send', socketId: direction.toSocketId, frame }],
  };
}

function onDaemonFrame(state: RendezvousState, daemon: DaemonSlot, frame: RelayFrame): RendezvousStep {
  const session = sessionFor(state, frame.sessionId);
  if (session === undefined) {
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
  return forward(state, session, frame, {
    toSocketId: session.clientSocketId,
    send: session.fromDaemon,
    credits: session.fromClient,
    withSend: (target, window) => ({ ...target, fromDaemon: window }),
    withCredits: (target, window) => ({ ...target, fromClient: window }),
  });
}

function onClientFrame(state: RendezvousState, session: RendezvousSession, frame: RelayFrame): RendezvousStep {
  const daemon = state.daemon;
  if (daemon === null) {
    return {
      state: withoutSession(state, session.sessionId),
      effects: endSession(session, RELAY_CLOSE_CODES.daemonAbsent, 'the daemon left'),
    };
  }
  const endBoth = (code: number, reason: string): RendezvousStep => ({
    state: withoutSession(state, session.sessionId),
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
  return forward(state, session, frame, {
    toSocketId: daemon.socketId,
    send: session.fromClient,
    credits: session.fromDaemon,
    withSend: (target, window) => ({ ...target, fromClient: window }),
    withCredits: (target, window) => ({ ...target, fromDaemon: window }),
  });
}

function onFrame(state: RendezvousState, event: Extract<RendezvousEvent, { kind: 'frame' }>): RendezvousStep {
  const pending = state.pending.find(entry => entry.socketId === event.socketId);
  if (pending !== undefined) return onPendingFrame(state, pending, event.frame);
  if (state.daemon !== null && state.daemon.socketId === event.socketId) {
    return onDaemonFrame(state, state.daemon, event.frame);
  }
  const session = state.sessions.find(entry => entry.clientSocketId === event.socketId);
  if (session !== undefined) return onClientFrame(state, session, event.frame);
  return {
    state,
    effects: refuse(event.socketId, RELAY_CLOSE_CODES.protocolError, 'socket is not part of this rendezvous'),
  };
}

// ─── departures ───────────────────────────────────────────────────────────────────────────────

function dropDaemon(state: RendezvousState, code: number, reason: string): RendezvousStep {
  return {
    state: { ...state, daemon: null, sessions: [] },
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
    state: withoutSession(state, session.sessionId),
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
    next = withoutSession(next, session.sessionId);
    effects.push(
      ...endSession(session, RELAY_CLOSE_CODES.heartbeatTimeout, reason),
      ...tellDaemon(next, session, RELAY_CLOSE_CODES.heartbeatTimeout, reason),
    );
  }

  return { state: next, effects: [...effects, ...nextAlarm(next, event.at)] };
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
