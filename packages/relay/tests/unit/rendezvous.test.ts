import { describe, it } from 'bun:test';
import {
  CLAIM_DEADLINE_SECONDS,
  CONNECTION_RATE_LIMIT,
  type ControlMessage,
  CREDIT_WINDOW_FRAMES,
  decodeControlMessage,
  encodeControlMessage,
  encodeCreditPayload,
  FRAME_KINDS,
  HEARTBEAT_GRACE_SECONDS,
  initialRendezvousState,
  MAX_PENDING_DAEMON_SOCKETS,
  MAX_SESSIONS_PER_RENDEZVOUS,
  newSendWindow,
  reduceRendezvous,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  type RelayFrame,
  type RendezvousEffect,
  type RendezvousState,
  RENDEZVOUS_SESSION_ID,
  sessionIdFromBytes,
  type SessionId,
} from '@ferretry/relay';
import should from 'should';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const host = 'relay.example';
const publicKey = 'A'.repeat(59);
const signature = 'B'.repeat(86);

function sessionId(fill: number): SessionId {
  const built = sessionIdFromBytes(new Uint8Array(16).fill(fill));
  if (built === null) throw new Error('fixture session id is malformed');
  return built;
}

function control(target: SessionId, message: ControlMessage): RelayFrame {
  return { kind: FRAME_KINDS.control, sessionId: target, sequence: 0, payload: encodeControlMessage(message) };
}

function record(target: SessionId, sequence: number): RelayFrame {
  return { kind: FRAME_KINDS.data, sessionId: target, sequence, payload: new Uint8Array([1]) };
}

function credit(target: SessionId, frames: number): RelayFrame {
  return { kind: FRAME_KINDS.credit, sessionId: target, sequence: 0, payload: encodeCreditPayload(frames) };
}

function messagesTo(effects: readonly RendezvousEffect[], socketId: string): ControlMessage[] {
  return effects
    .filter(effect => effect.kind === 'send' && effect.socketId === socketId)
    .map(effect => (effect.kind === 'send' ? decodeControlMessage(effect.frame.payload) : null))
    .filter((message): message is ControlMessage => message !== null);
}

function closures(effects: readonly RendezvousEffect[]): { socketId: string; code: number; reason: string }[] {
  return effects.flatMap(effect =>
    effect.kind === 'close' ? [{ socketId: effect.socketId, code: effect.code, reason: effect.reason }] : [],
  );
}

function forwarded(effects: readonly RendezvousEffect[]): { socketId: string; frame: RelayFrame }[] {
  return effects.flatMap(effect =>
    effect.kind === 'send' && effect.frame.kind !== FRAME_KINDS.control
      ? [{ socketId: effect.socketId, frame: effect.frame }]
      : [],
  );
}

const goodVerdict = { ok: true, publicKeySpki: new Uint8Array(44) } as const;

function withDaemon(at = 1_000): RendezvousState {
  const arrived = reduceRendezvous(initialRendezvousState(daemonId), {
    kind: 'daemon-arrived',
    socketId: 'daemon',
    challenge: new Uint8Array(32).fill(7),
    host,
    at,
  });
  return reduceRendezvous(arrived.state, { kind: 'claim-verdict', socketId: 'daemon', verdict: goodVerdict, at }).state;
}

function withClient(at = 2_000, socketId = 'phone', target = sessionId(1)) {
  return reduceRendezvous(withDaemon(), { kind: 'client-arrived', socketId, sessionId: target, at });
}

describe('rendezvous: claiming the slot', () => {
  it('should challenge an arriving daemon and schedule the sweep', () => {
    const step = reduceRendezvous(initialRendezvousState(daemonId), {
      kind: 'daemon-arrived',
      socketId: 'daemon',
      challenge: new Uint8Array(32).fill(7),
      host,
      at: 1_000,
    });
    should(messagesTo(step.effects, 'daemon')[0]).match({
      t: 'challenge',
      host,
      deadlineSeconds: CLAIM_DEADLINE_SECONDS,
    });
    should(step.effects.some(effect => effect.kind === 'schedule-alarm')).be.true();
    should(step.state.pending.length).equal(1);
  });

  it('should verify a claim out of band and then hand over the slot', () => {
    const arrived = reduceRendezvous(initialRendezvousState(daemonId), {
      kind: 'daemon-arrived',
      socketId: 'daemon',
      challenge: new Uint8Array(32).fill(7),
      host,
      at: 1_000,
    });
    const claiming = reduceRendezvous(arrived.state, {
      kind: 'frame',
      socketId: 'daemon',
      frame: control(RENDEZVOUS_SESSION_ID, { t: 'claim', protocol: RELAY_PROTOCOL_ID, publicKey, signature }),
      at: 1_100,
    });
    should(claiming.effects).deepEqual([
      { kind: 'verify-claim', socketId: 'daemon', host, challenge: new Uint8Array(32).fill(7), publicKey, signature },
    ]);
    should(claiming.state.pending[0]?.verifying).be.true();

    const settled = reduceRendezvous(claiming.state, {
      kind: 'claim-verdict',
      socketId: 'daemon',
      verdict: goodVerdict,
      at: 1_200,
    });
    should(messagesTo(settled.effects, 'daemon')[0]).match({ t: 'claimed' });
    should(settled.state.daemon?.socketId).equal('daemon');
    should(settled.state.pending).deepEqual([]);
  });

  it('should refuse a claim that did not verify', () => {
    const arrived = reduceRendezvous(initialRendezvousState(daemonId), {
      kind: 'daemon-arrived',
      socketId: 'daemon',
      challenge: new Uint8Array(32),
      host,
      at: 1_000,
    });
    const step = reduceRendezvous(arrived.state, {
      kind: 'claim-verdict',
      socketId: 'daemon',
      verdict: { ok: false, reason: 'claim signature failed' },
      at: 1_100,
    });
    should(closures(step.effects)[0]?.code).equal(RELAY_CLOSE_CODES.claimRejected);
    should(step.state.daemon).be.null();
  });

  it('should let the incumbent keep the rendezvous when a second daemon appears', () => {
    const second = reduceRendezvous(withDaemon(), {
      kind: 'daemon-arrived',
      socketId: 'other',
      challenge: new Uint8Array(32),
      host,
      at: 3_000,
    });
    should(closures(second.effects)[0]?.code).equal(RELAY_CLOSE_CODES.rendezvousClaimed);
    should(second.state.daemon?.socketId).equal('daemon');
  });

  it('should refuse a verdict that arrives after somebody else took the slot', () => {
    const contender = reduceRendezvous(initialRendezvousState(daemonId), {
      kind: 'daemon-arrived',
      socketId: 'contender',
      challenge: new Uint8Array(32),
      host,
      at: 900,
    });
    const taken: RendezvousState = { ...contender.state, daemon: { socketId: 'daemon', since: 1_000 } };
    const step = reduceRendezvous(taken, {
      kind: 'claim-verdict',
      socketId: 'contender',
      verdict: goodVerdict,
      at: 1_100,
    });
    should(closures(step.effects)[0]?.code).equal(RELAY_CLOSE_CODES.rendezvousClaimed);
    should(step.state.daemon?.socketId).equal('daemon');
  });

  it('should ignore a verdict for a socket that has already gone', () => {
    const step = reduceRendezvous(withDaemon(), {
      kind: 'claim-verdict',
      socketId: 'ghost',
      verdict: goodVerdict,
      at: 5,
    });
    should(step.effects).deepEqual([]);
  });

  it('should accept exactly one claim, of exactly the right shape, per socket', () => {
    const arrived = reduceRendezvous(initialRendezvousState(daemonId), {
      kind: 'daemon-arrived',
      socketId: 'daemon',
      challenge: new Uint8Array(32),
      host,
      at: 1_000,
    });
    const claimFrame = control(RENDEZVOUS_SESSION_ID, {
      t: 'claim',
      protocol: RELAY_PROTOCOL_ID,
      publicKey,
      signature,
    });

    const wrongKind = reduceRendezvous(arrived.state, {
      kind: 'frame',
      socketId: 'daemon',
      frame: record(RENDEZVOUS_SESSION_ID, 0),
      at: 1_100,
    });
    should(closures(wrongKind.effects)[0]?.code).equal(RELAY_CLOSE_CODES.protocolError);
    should(wrongKind.state.pending).deepEqual([]);

    const wrongMessage = reduceRendezvous(arrived.state, {
      kind: 'frame',
      socketId: 'daemon',
      frame: control(RENDEZVOUS_SESSION_ID, { t: 'open' }),
      at: 1_100,
    });
    should(closures(wrongMessage.effects)[0]?.reason).match(/expected a claim/u);

    const verifying = reduceRendezvous(arrived.state, {
      kind: 'frame',
      socketId: 'daemon',
      frame: claimFrame,
      at: 1_100,
    });
    const twice = reduceRendezvous(verifying.state, {
      kind: 'frame',
      socketId: 'daemon',
      frame: claimFrame,
      at: 1_200,
    });
    should(closures(twice.effects)[0]?.reason).match(/already being verified/u);
  });

  it('should cap unproved daemon sockets and the arrival rate', () => {
    let state = initialRendezvousState(daemonId);
    for (let index = 0; index < MAX_PENDING_DAEMON_SOCKETS; index += 1) {
      state = reduceRendezvous(state, {
        kind: 'daemon-arrived',
        socketId: `daemon-${index}`,
        challenge: new Uint8Array(32),
        host,
        at: 1_000 + index,
      }).state;
    }
    const overflowing = reduceRendezvous(state, {
      kind: 'daemon-arrived',
      socketId: 'one-too-many',
      challenge: new Uint8Array(32),
      host,
      at: 2_000,
    });
    should(closures(overflowing.effects)[0]?.reason).match(/unproved daemon sockets/u);

    let flooded = initialRendezvousState(daemonId);
    for (let index = 0; index < CONNECTION_RATE_LIMIT; index += 1) {
      flooded = reduceRendezvous(flooded, {
        kind: 'client-arrived',
        socketId: `probe-${index}`,
        sessionId: sessionId(index + 1),
        at: 1_000 + index,
      }).state;
    }
    const rateLimited = reduceRendezvous(flooded, {
      kind: 'client-arrived',
      socketId: 'probe-last',
      sessionId: sessionId(99),
      at: 1_100,
    });
    should(closures(rateLimited.effects)[0]?.reason).match(/too many connections/u);

    const laterDaemon = reduceRendezvous(flooded, {
      kind: 'daemon-arrived',
      socketId: 'late',
      challenge: new Uint8Array(32),
      host,
      at: 1_100,
    });
    should(closures(laterDaemon.effects)[0]?.reason).match(/too many connections/u);
  });
});

describe('rendezvous: sessions', () => {
  it('should refuse a client when no daemon holds the rendezvous', () => {
    const step = reduceRendezvous(initialRendezvousState(daemonId), {
      kind: 'client-arrived',
      socketId: 'phone',
      sessionId: sessionId(1),
      at: 2_000,
    });
    should(closures(step.effects)[0]?.code).equal(RELAY_CLOSE_CODES.daemonAbsent);
  });

  it('should open a session and tell both sides about it', () => {
    const step = withClient();
    should(messagesTo(step.effects, 'phone')[0]).match({ t: 'ready' });
    should(messagesTo(step.effects, 'daemon')[0]).match({ t: 'open' });
    should(step.state.sessions.length).equal(1);
  });

  it('should refuse a session identifier it cannot use', () => {
    const opened = withClient();
    const duplicate = reduceRendezvous(opened.state, {
      kind: 'client-arrived',
      socketId: 'laptop',
      sessionId: sessionId(1),
      at: 2_100,
    });
    should(closures(duplicate.effects)[0]?.code).equal(RELAY_CLOSE_CODES.relayInternal);

    const reserved = reduceRendezvous(opened.state, {
      kind: 'client-arrived',
      socketId: 'laptop',
      sessionId: RENDEZVOUS_SESSION_ID,
      at: 2_100,
    });
    should(closures(reserved.effects)[0]?.code).equal(RELAY_CLOSE_CODES.relayInternal);
  });

  it('should carry several clients at once and then refuse the next', () => {
    let state = withDaemon().daemon === null ? initialRendezvousState(daemonId) : withDaemon();
    for (let index = 0; index < MAX_SESSIONS_PER_RENDEZVOUS; index += 1) {
      state = reduceRendezvous(state, {
        kind: 'client-arrived',
        socketId: `client-${index}`,
        sessionId: sessionId(index + 1),
        at: 2_000 + index,
      }).state;
    }
    should(state.sessions.length).equal(MAX_SESSIONS_PER_RENDEZVOUS);
    const overflowing = reduceRendezvous(state, {
      kind: 'client-arrived',
      socketId: 'one-too-many',
      sessionId: sessionId(200),
      at: 2_100,
    });
    should(closures(overflowing.effects)[0]?.reason).match(/session limit/u);
  });
});

describe('rendezvous: forwarding', () => {
  it('should move records both ways without decoding them', () => {
    const opened = withClient();
    const target = sessionId(1);

    const upward = reduceRendezvous(opened.state, {
      kind: 'frame',
      socketId: 'phone',
      frame: record(target, 1),
      at: 3_000,
    });
    should(forwarded(upward.effects)).deepEqual([{ socketId: 'daemon', frame: record(target, 1) }]);
    should(upward.state.sessions[0]?.fromClient.sent).equal(1);

    const downward = reduceRendezvous(upward.state, {
      kind: 'frame',
      socketId: 'daemon',
      frame: record(target, 1),
      at: 3_100,
    });
    should(forwarded(downward.effects)).deepEqual([{ socketId: 'phone', frame: record(target, 1) }]);
    should(downward.state.sessions[0]?.fromDaemon.sent).equal(1);
  });

  it('should keep one client out of another client session', () => {
    const first = withClient(2_000, 'phone', sessionId(1));
    const second = reduceRendezvous(first.state, {
      kind: 'client-arrived',
      socketId: 'laptop',
      sessionId: sessionId(2),
      at: 2_100,
    });
    const trespass = reduceRendezvous(second.state, {
      kind: 'frame',
      socketId: 'laptop',
      frame: record(sessionId(1), 1),
      at: 3_000,
    });
    should(closures(trespass.effects)[0]).match({ socketId: 'laptop', code: RELAY_CLOSE_CODES.protocolError });
    should(trespass.state.sessions.map(session => session.sessionId.text)).deepEqual([sessionId(1).text]);
  });

  it('should end a session when its sender ignores the credit window', () => {
    let state = withClient().state;
    for (let frame = 0; frame < CREDIT_WINDOW_FRAMES; frame += 1) {
      state = reduceRendezvous(state, {
        kind: 'frame',
        socketId: 'phone',
        frame: record(sessionId(1), frame + 1),
        at: 3_000 + frame,
      }).state;
    }
    const overflowing = reduceRendezvous(state, {
      kind: 'frame',
      socketId: 'phone',
      frame: record(sessionId(1), 99),
      at: 4_000,
    });
    should(closures(overflowing.effects)[0]?.code).equal(RELAY_CLOSE_CODES.flowViolation);
    should(messagesTo(overflowing.effects, 'daemon')[0]).match({ code: RELAY_CLOSE_CODES.flowViolation });
    should(overflowing.state.sessions).deepEqual([]);
  });

  it('should forward a credit grant that does something and refuse one that does not', () => {
    let state = withClient().state;
    state = reduceRendezvous(state, {
      kind: 'frame',
      socketId: 'daemon',
      frame: record(sessionId(1), 1),
      at: 3_000,
    }).state;

    const granting = reduceRendezvous(state, {
      kind: 'frame',
      socketId: 'phone',
      frame: credit(sessionId(1), 1),
      at: 3_100,
    });
    should(forwarded(granting.effects)[0]?.socketId).equal('daemon');
    should(granting.state.sessions[0]?.fromDaemon.allowed).equal(CREDIT_WINDOW_FRAMES + 1);

    const pointless = reduceRendezvous(granting.state, {
      kind: 'frame',
      socketId: 'phone',
      frame: credit(sessionId(1), 5),
      at: 3_200,
    });
    should(closures(pointless.effects)[0]?.reason).match(/no effect/u);

    const malformed = reduceRendezvous(state, {
      kind: 'frame',
      socketId: 'phone',
      frame: { kind: FRAME_KINDS.credit, sessionId: sessionId(1), sequence: 0, payload: new Uint8Array(3) },
      at: 3_300,
    });
    should(closures(malformed.effects)[0]?.reason).match(/malformed credit/u);
  });

  it('should let either side close one session without dropping the other', () => {
    const opened = withClient();
    const byDaemon = reduceRendezvous(opened.state, {
      kind: 'frame',
      socketId: 'daemon',
      frame: control(sessionId(1), { t: 'closed', code: RELAY_CLOSE_CODES.authRejected, reason: 'unknown device' }),
      at: 3_000,
    });
    should(closures(byDaemon.effects)[0]).match({ socketId: 'phone', code: RELAY_CLOSE_CODES.authRejected });
    should(byDaemon.state.sessions).deepEqual([]);

    const byClient = reduceRendezvous(opened.state, {
      kind: 'frame',
      socketId: 'phone',
      frame: control(sessionId(1), { t: 'closed', code: 4400, reason: 'done' }),
      at: 3_000,
    });
    should(byClient.state.sessions).deepEqual([]);
    should(messagesTo(byClient.effects, 'daemon')[0]).match({ t: 'closed', reason: 'done' });
  });

  it('should refuse control nobody is allowed to send', () => {
    const opened = withClient();
    const fromDaemon = reduceRendezvous(opened.state, {
      kind: 'frame',
      socketId: 'daemon',
      frame: control(sessionId(1), { t: 'open' }),
      at: 3_000,
    });
    should(closures(fromDaemon.effects)[0]).match({ socketId: 'daemon', code: RELAY_CLOSE_CODES.protocolError });

    const fromClient = reduceRendezvous(opened.state, {
      kind: 'frame',
      socketId: 'phone',
      frame: control(sessionId(1), { t: 'open' }),
      at: 3_000,
    });
    should(closures(fromClient.effects)[0]).match({ socketId: 'phone', code: RELAY_CLOSE_CODES.protocolError });
  });

  it('should refuse a daemon frame for a session that does not exist', () => {
    const step = reduceRendezvous(withDaemon(), {
      kind: 'frame',
      socketId: 'daemon',
      frame: record(sessionId(9), 1),
      at: 3_000,
    });
    should(closures(step.effects)[0]?.reason).match(/no live session/u);
  });

  it('should refuse a frame from a socket it never accepted', () => {
    const step = reduceRendezvous(withDaemon(), {
      kind: 'frame',
      socketId: 'stranger',
      frame: record(sessionId(1), 1),
      at: 3_000,
    });
    should(closures(step.effects)[0]?.reason).match(/not part of this rendezvous/u);
  });

  it('should end a session it finds without a daemon rather than serve it', () => {
    const damaged: RendezvousState = {
      daemonId,
      daemon: null,
      pending: [],
      sessions: [
        {
          sessionId: sessionId(1),
          clientSocketId: 'phone',
          since: 2_000,
          fromClient: newSendWindow(),
          fromDaemon: newSendWindow(),
        },
      ],
      arrivals: [],
    };
    const step = reduceRendezvous(damaged, {
      kind: 'frame',
      socketId: 'phone',
      frame: record(sessionId(1), 1),
      at: 3_000,
    });
    should(closures(step.effects)[0]?.code).equal(RELAY_CLOSE_CODES.daemonAbsent);
    should(step.state.sessions).deepEqual([]);
  });
});

describe('rendezvous: departures and the sweep', () => {
  it('should forget an unproved socket that hung up', () => {
    const arrived = reduceRendezvous(initialRendezvousState(daemonId), {
      kind: 'daemon-arrived',
      socketId: 'daemon',
      challenge: new Uint8Array(32),
      host,
      at: 1_000,
    });
    const step = reduceRendezvous(arrived.state, { kind: 'socket-closed', socketId: 'daemon', at: 1_500 });
    should(step.state.pending).deepEqual([]);
    should(step.effects).deepEqual([]);
  });

  it('should end every session when the daemon goes', () => {
    const opened = withClient();
    const step = reduceRendezvous(opened.state, { kind: 'socket-closed', socketId: 'daemon', at: 4_000 });
    should(step.state.daemon).be.null();
    should(step.state.sessions).deepEqual([]);
    should(closures(step.effects)[0]).match({ socketId: 'phone', code: RELAY_CLOSE_CODES.daemonAbsent });
  });

  it('should tell the daemon when one client goes, and ignore a socket it does not know', () => {
    const opened = withClient();
    const step = reduceRendezvous(opened.state, { kind: 'socket-closed', socketId: 'phone', at: 4_000 });
    should(messagesTo(step.effects, 'daemon')[0]).match({ t: 'closed', reason: 'the client disconnected' });
    should(step.state.sessions).deepEqual([]);

    should(reduceRendezvous(opened.state, { kind: 'socket-closed', socketId: 'nobody', at: 4_000 }).effects).deepEqual(
      [],
    );
  });

  it('should drop a daemon socket that never proved itself', () => {
    const arrived = reduceRendezvous(initialRendezvousState(daemonId), {
      kind: 'daemon-arrived',
      socketId: 'daemon',
      challenge: new Uint8Array(32),
      host,
      at: 1_000,
    });
    const step = reduceRendezvous(arrived.state, {
      kind: 'alarm',
      at: 1_000 + CLAIM_DEADLINE_SECONDS * 1_000,
      lastSeen: {},
    });
    should(closures(step.effects)[0]?.code).equal(RELAY_CLOSE_CODES.claimTimeout);
    should(step.state.pending).deepEqual([]);
    should(step.effects.some(effect => effect.kind === 'schedule-alarm')).be.false();
  });

  it('should keep everyone whose heartbeat is recent, and keep sweeping', () => {
    const opened = withClient();
    const at = 2_000 + HEARTBEAT_GRACE_SECONDS * 1_000;
    const step = reduceRendezvous(opened.state, {
      kind: 'alarm',
      at,
      lastSeen: { daemon: at - 1_000, phone: at - 1_000 },
    });
    should(closures(step.effects)).deepEqual([]);
    should(step.effects.some(effect => effect.kind === 'schedule-alarm')).be.true();
  });

  it('should evict a socket with no evidence of life rather than assume it is fine', () => {
    const opened = withClient();
    const at = 2_000 + HEARTBEAT_GRACE_SECONDS * 1_000 + 1;
    const step = reduceRendezvous(opened.state, { kind: 'alarm', at, lastSeen: {} });
    const closed = closures(step.effects);
    should(closed.map(entry => entry.socketId).sort()).deepEqual(['daemon', 'phone']);
    should(step.state.daemon).be.null();
    should(step.state.sessions).deepEqual([]);
  });

  it('should evict only the client that went quiet', () => {
    const opened = withClient();
    const at = 2_000 + HEARTBEAT_GRACE_SECONDS * 1_000 + 1;
    const step = reduceRendezvous(opened.state, { kind: 'alarm', at, lastSeen: { daemon: at - 100 } });
    should(closures(step.effects)).deepEqual([
      { socketId: 'phone', code: RELAY_CLOSE_CODES.heartbeatTimeout, reason: 'the client stopped answering' },
    ]);
    should(step.state.daemon?.socketId).equal('daemon');
    should(messagesTo(step.effects, 'daemon')[0]).match({ code: RELAY_CLOSE_CODES.heartbeatTimeout });
  });
});
