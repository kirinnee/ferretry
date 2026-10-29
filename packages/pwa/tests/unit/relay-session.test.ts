/**
 * The browser's session, one refusal at a time.
 *
 * Every case here is a carrier or a peer misbehaving, because the happy path is
 * proved end to end against the real rendezvous in
 * `tests/integration/relay-carrier-end-to-end.test.ts` and proving it twice would
 * only prove this file's harness. What CANNOT be proved there is what happens when
 * a frame is forged, arrives out of order, or answers a request nobody sent — a
 * correct rendezvous never produces one — and every one of those must end the
 * session rather than be absorbed.
 */

import { describe, it } from 'bun:test';
import { MAX_TUNNEL_BODY_BYTES, OLDER_DAEMON_SENTENCE } from '@ferretry/protocol';
import {
  CREDIT_WINDOW_FRAMES,
  encodeCreditPayload,
  encodeFrame,
  FRAME_KINDS,
  MAX_PLAINTEXT_BYTES,
  HOSTED_RELAY_BANDWIDTH_REASONS,
  RELAY_CLOSE_CODES,
  RELAY_LIMITS,
  SESSION_PROTOCOL_ID,
  utf8Bytes,
} from '@ferretry/relay';
import should from 'should';
import {
  decodeTunnelDaemonMessage,
  encodeTunnelClientMessage,
  MAX_TUNNEL_REQUEST_ID,
  RelayClientSession,
  type RelayClientSessionDependencies,
  RelaySessionError,
} from '../../src/lib/relay-session.ts';
import {
  controlFrame,
  creditFrame,
  LEASE_ENDS,
  newDaemonIdentity,
  readyFrame,
  relayCrypto,
  ScriptedDaemon,
  ScriptedSocket,
  settle,
  testDevice,
  testSessionId,
} from '../support/relay.ts';

const device = await testDevice('fy_dev_session');
const ACCEPTED = { t: 'authenticated', protocol: SESSION_PROTOCOL_ID, accessExpiresAt: LEASE_ENDS } as const;
const sessionId = testSessionId();

interface Harness {
  readonly session: RelayClientSession;
  readonly socket: ScriptedSocket;
  readonly daemon: ScriptedDaemon;
}

/** A session that has said hello, with the daemon ready to answer it. */
const opened = async (overrides: Partial<RelayClientSessionDependencies> = {}): Promise<Harness> => {
  const identity = await newDaemonIdentity();
  const socket = new ScriptedSocket();
  const session = new RelayClientSession({
    crypto: relayCrypto,
    daemonId: identity.daemonId,
    mode: { kind: 'auth', device: device.claim },
    socket,
    ...overrides,
  });
  await session.receiveBinary(readyFrame(sessionId));
  return { session, socket, daemon: new ScriptedDaemon(identity, sessionId) };
};

/** A session the daemon has keyed and authenticated: ready to carry requests. */
const serving = async (overrides: Partial<RelayClientSessionDependencies> = {}): Promise<Harness> => {
  const harness = await opened(overrides);
  const hello = harness.socket.sent[0];
  if (hello === undefined) throw new Error('the session sent no hello');
  await harness.session.receiveBinary(await harness.daemon.answer(hello));
  await harness.session.receiveBinary(await harness.daemon.record(ACCEPTED));
  return harness;
};

/** A keyed stream the daemon has accepted: ready to carry frames and conclude. */
const streaming = async (overrides: Partial<RelayClientSessionDependencies> = {}): Promise<Harness> => {
  const harness = await opened({
    mode: { kind: 'stream', device: device.claim, path: '/v1/events' },
    ...overrides,
  });
  const hello = harness.socket.sent[0];
  if (hello === undefined) throw new Error('the session sent no hello');
  await harness.session.receiveBinary(await harness.daemon.answer(hello));
  const ready = harness.session.ready();
  await harness.session.receiveBinary(
    await harness.daemon.record({ t: 'stream-opened', protocol: SESSION_PROTOCOL_ID, accessExpiresAt: LEASE_ENDS }),
  );
  await ready;
  return harness;
};

/** A keyed stream accepted with extra fields on `stream-opened`. */
const streamingWith = async (extra: Record<string, unknown>): Promise<Harness> => {
  const harness = await opened({ mode: { kind: 'stream', device: device.claim, path: '/v1/events' } });
  await harness.session.receiveBinary(await harness.daemon.answer(harness.socket.sent[0] as Uint8Array));
  const ready = harness.session.ready();
  await harness.session.receiveBinary(
    await harness.daemon.record({
      t: 'stream-opened',
      protocol: SESSION_PROTOCOL_ID,
      accessExpiresAt: LEASE_ENDS,
      ...extra,
    }),
  );
  await ready;
  return harness;
};

const failure = async (promise: Promise<unknown>): Promise<RelaySessionError> => {
  const reason = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(reason).be.instanceof(RelaySessionError);
  return reason as RelaySessionError;
};

describe('the relay tunnel codec', () => {
  it('should refuse everything that is not exactly one §14 daemon message', () => {
    should(decodeTunnelDaemonMessage(new Uint8Array([0xff, 0xfe]))).be.null();
    should(decodeTunnelDaemonMessage(utf8Bytes('{'))).be.null();
    should(decodeTunnelDaemonMessage(utf8Bytes('{"t":"nope"}'))).be.null();
    should(decodeTunnelDaemonMessage(utf8Bytes('{"t":"res","id":1,"status":200,"headers":7}'))).be.null();
    should(decodeTunnelDaemonMessage(utf8Bytes('{"t":"res","id":1,"status":200}'))).match({ t: 'res' });
    should(decodeTunnelDaemonMessage(utf8Bytes('{"t":"res","id":1,"status":200,"more":true}'))).match({ more: true });
    should(decodeTunnelDaemonMessage(utf8Bytes('{"t":"res-more","id":1,"body":"x"}'))).match({ t: 'res-more' });
    // `oversize` is gone: a large body travels in parts, so a record claiming one is a stranger.
    should(decodeTunnelDaemonMessage(utf8Bytes('{"t":"oversize","id":1,"status":200,"byteLength":9}'))).be.null();
    // The previous dialect is not this one, however it is otherwise shaped.
    should(
      decodeTunnelDaemonMessage(
        utf8Bytes(`{"t":"authenticated","protocol":"ferretry-relay/1","accessExpiresAt":"${LEASE_ENDS}"}`),
      ),
    ).be.null();
    should(MAX_TUNNEL_REQUEST_ID).equal(0xffff_ffff);
  });

  it('should encode a client message as one JSON object', () => {
    const encoded = encodeTunnelClientMessage({ t: 'renewed', protocol: SESSION_PROTOCOL_ID, proof: 'p' });
    should(JSON.parse(new TextDecoder().decode(encoded))).eql({
      t: 'renewed',
      protocol: SESSION_PROTOCOL_ID,
      proof: 'p',
    });
  });
});

describe('a relay session that is not serving', () => {
  it('should refuse a request before the daemon has authenticated this browser', async () => {
    const { session } = await opened();
    should(session.live()).be.false();
    const refusal = await failure(session.request({ method: 'GET', path: '/v1/sessions' }));
    should(refusal.code).equal(RELAY_CLOSE_CODES.protocolError);
  });

  it('should refuse everything outstanding when the carrier drops the socket', async () => {
    const { session, socket } = await opened();
    const answer = session.request({ method: 'GET', path: '/v1/sessions' }).catch(() => 'refused');
    session.carrierClosed(RELAY_CLOSE_CODES.heartbeatTimeout, '');
    should(await answer).equal('refused');
    // Already ended: a second close is not a second refusal to report.
    session.carrierClosed(RELAY_CLOSE_CODES.protocolError, 'again');
    session.heartbeat();
    should(socket.texts).be.empty();
    await failure(session.ready());
  });

  it('should answer a heartbeat with a heartbeat and refuse any other text', async () => {
    const { session, socket } = await opened();
    session.receiveText('fy-ping');
    should(socket.texts).eql(['fy-pong']);
    session.receiveText('fy-pong');
    session.heartbeat();
    should(socket.texts).eql(['fy-pong', 'fy-ping']);

    const other = await opened();
    other.session.receiveText('hello?');
    should(other.socket.closed?.code).equal(RELAY_CLOSE_CODES.protocolError);
  });

  it('should close from this side and stay closed', async () => {
    const { session, socket } = await opened();
    session.close();
    should(socket.closed?.code).equal(1000);
    session.close();
    await session.receiveBinary(readyFrame(sessionId));
    await failure(session.ready());
  });
});

describe('a relay session reading frames from its carrier', () => {
  it('should refuse a frame that is not one, and a frame for another session', async () => {
    const short = await opened();
    await short.session.receiveBinary(new Uint8Array([0xfe, 0x01]));
    should(short.socket.closed?.code).equal(RELAY_CLOSE_CODES.protocolError);

    const stray = await opened();
    await stray.session.receiveBinary(creditFrame(testSessionId(9), encodeCreditPayload(4)));
    should(stray.socket.closed?.reason).match(/session this browser does not hold/u);
  });

  it('should refuse a session frame that arrives before the rendezvous named a session', async () => {
    const identity = await newDaemonIdentity();
    const socket = new ScriptedSocket();
    const session = new RelayClientSession({
      crypto: relayCrypto,
      daemonId: identity.daemonId,
      mode: { kind: 'auth', device: device.claim },
      socket,
    });
    await session.receiveBinary(creditFrame(sessionId, encodeCreditPayload(4)));
    should(socket.closed?.code).equal(RELAY_CLOSE_CODES.protocolError);
  });

  it('should refuse rendezvous control it cannot parse or did not expect', async () => {
    const unparseable = await opened();
    await unparseable.session.receiveBinary(
      encodeFrame({ kind: FRAME_KINDS.control, sessionId, sequence: 0, payload: utf8Bytes('not json') }),
    );
    should(unparseable.socket.closed?.reason).match(/unparseable rendezvous control/u);

    const wrongRole = await opened();
    await wrongRole.session.receiveBinary(controlFrame(sessionId, { t: 'open' }));
    should(wrongRole.socket.closed?.reason).match(/unexpected rendezvous control: open/u);

    const twice = await opened();
    await twice.session.receiveBinary(readyFrame(sessionId));
    should(twice.socket.closed?.reason).match(/second ready/u);
  });

  it('should keep the reason when the rendezvous ends a session or refuses the browser', async () => {
    const ended = await opened();
    await ended.session.receiveBinary(
      controlFrame(sessionId, { t: 'closed', code: RELAY_CLOSE_CODES.authRejected, reason: 'unknown device' }),
    );
    should((await failure(ended.session.ready())).code).equal(RELAY_CLOSE_CODES.authRejected);

    const refused = await opened();
    await refused.session.receiveBinary(
      controlFrame(sessionId, { t: 'error', code: RELAY_CLOSE_CODES.hostedDisabled, reason: 'switched off' }),
    );
    const reason = await failure(refused.session.ready());
    should(reason.code).equal(RELAY_CLOSE_CODES.hostedDisabled);
    should(reason.message).match(/switched off/u);
    // An `error` is followed by the rendezvous' own close, so this side does not race it.
    should(refused.socket.closed).be.null();

    // A spent data allowance is said in a person's words, not the operator's.
    const spent = await opened();
    await spent.session.receiveBinary(
      controlFrame(sessionId, {
        t: 'error',
        code: RELAY_CLOSE_CODES.hostedBandwidth,
        reason: HOSTED_RELAY_BANDWIDTH_REASONS.daemon.day,
      }),
    );
    const allowance = await failure(spent.session.ready());
    should(allowance.code).equal(RELAY_CLOSE_CODES.hostedBandwidth);
    should(allowance.message).equal(
      "Today's relay data allowance for this machine is used up (resets at midnight UTC). Direct connections still work.",
    );
    // A 4433 this build cannot read keeps the relay's own words.
    const unknown = await opened();
    await unknown.session.receiveBinary(
      controlFrame(sessionId, { t: 'error', code: RELAY_CLOSE_CODES.hostedBandwidth, reason: 'over budget' }),
    );
    should((await failure(unknown.session.ready())).message).match(/refused this browser: 4433 over budget/u);
  });

  it('should refuse credit that is malformed or changes nothing', async () => {
    const malformed = await opened();
    await malformed.session.receiveBinary(creditFrame(sessionId, new Uint8Array([1, 2])));
    should((await failure(malformed.session.ready())).code).equal(RELAY_CLOSE_CODES.flowViolation);

    const pointless = await opened();
    await pointless.session.receiveBinary(creditFrame(sessionId, encodeCreditPayload(0)));
    should((await failure(pointless.session.ready())).message).match(/no effect/u);
  });

  it('should accept credit before the handshake without sending anything it has not keyed', async () => {
    const { session, socket } = await opened();
    const before = socket.sent.length;
    await session.receiveBinary(creditFrame(sessionId, encodeCreditPayload(4)));
    should(socket.sent.length).equal(before);
    should(socket.closed).be.null();
  });
});

describe('a relay session completing its handshake', () => {
  it('should refuse a handshake out of turn, and one it cannot read', async () => {
    const outOfTurn = await serving();
    const hello = outOfTurn.socket.sent[0];
    if (hello === undefined) throw new Error('no hello');
    await outOfTurn.session.receiveBinary(await outOfTurn.daemon.answer(hello).catch(() => hello));
    should((await failure(outOfTurn.session.request({ method: 'GET', path: '/x' }))).message).match(/out of turn/u);

    const unreadable = await opened();
    await unreadable.session.receiveBinary(
      encodeFrame({ kind: FRAME_KINDS.handshake, sessionId, sequence: 0, payload: utf8Bytes('{}') }),
    );
    should((await failure(unreadable.session.ready())).message).match(/unparseable daemon hello/u);
  });

  it('should refuse a daemon whose key is not the pinned fingerprint, before signing anything', async () => {
    const impostor = await newDaemonIdentity();
    const { session, socket, daemon } = await opened();
    const hello = socket.sent[0];
    if (hello === undefined) throw new Error('no hello');
    const answered = await new ScriptedDaemon(impostor, daemon.sessionId).spoof(hello);
    await session.receiveBinary(answered);
    should((await failure(session.ready())).message).match(/pinned fingerprint/u);
    // One frame only: the hello. No proof by this device was ever produced for that daemon.
    should(socket.sent).have.length(1);
  });

  it('should refuse a record that arrives before any channel exists', async () => {
    const { session } = await opened();
    await session.receiveBinary(
      encodeFrame({ kind: FRAME_KINDS.data, sessionId, sequence: 1, payload: new Uint8Array(32) }),
    );
    should((await failure(session.ready())).message).match(/before the handshake/u);
  });

  it('should refuse a forged record rather than tolerate it', async () => {
    const { session, socket, daemon } = await opened();
    const hello = socket.sent[0];
    if (hello === undefined) throw new Error('no hello');
    await session.receiveBinary(await daemon.answer(hello));
    const record = await daemon.record(ACCEPTED);
    const meddled = Uint8Array.from(record);
    meddled[30] = (meddled[30] ?? 0) ^ 0x01;
    await session.receiveBinary(meddled);
    should((await failure(session.ready())).code).equal(RELAY_CLOSE_CODES.frameForged);
  });

  it('should refuse a first record that is not the acceptance §14 requires', async () => {
    const unparseable = await opened();
    const helloA = unparseable.socket.sent[0];
    if (helloA === undefined) throw new Error('no hello');
    await unparseable.session.receiveBinary(await unparseable.daemon.answer(helloA));
    await unparseable.session.receiveBinary(await unparseable.daemon.rawRecord(new Uint8Array([0xff, 0xfe])));
    should((await failure(unparseable.session.ready())).message).match(/unparseable tunnel record/u);

    const wrongShape = await opened();
    const helloB = wrongShape.socket.sent[0];
    if (helloB === undefined) throw new Error('no hello');
    await wrongShape.session.receiveBinary(await wrongShape.daemon.answer(helloB));
    await wrongShape.session.receiveBinary(await wrongShape.daemon.record({ t: 'res', id: 1, status: 200 }));
    should((await failure(wrongShape.session.ready())).message).match(/did not accept this device/u);
  });
});

describe('a streaming relay session', () => {
  it('should contain a throwing close listener and still notify following and late listeners once', async () => {
    const failures: unknown[] = [];
    const reportingFault = new Error('the reporting port failed');
    const { session, daemon } = await streaming({
      onStreamListenerFailure: reason => {
        failures.push(reason);
        throw reportingFault;
      },
    });
    const listenerFault = new Error('the first close observer failed');
    const observed: { source: string; code: number; reason: string }[] = [];
    session.onStreamClosed(() => {
      throw listenerFault;
    });
    session.onStreamClosed(closed => observed.push({ source: 'following', ...closed }));

    await session.receiveBinary(
      await daemon.record({ t: 'stream-close', protocol: SESSION_PROTOCOL_ID, code: 1013, reason: 'fell behind' }),
    );
    session.onStreamClosed(closed => observed.push({ source: 'late', ...closed }));

    // Neither another local close nor the carrier's teardown may announce the latched outcome again.
    session.closeStream(1000, 'again');
    session.carrierClosed(4440, 'the stream is complete');
    should(observed).eql([
      { source: 'following', code: 1013, reason: 'fell behind' },
      { source: 'late', code: 1013, reason: 'fell behind' },
    ]);
    should(failures).eql([listenerFault]);
  });
});

describe('a serving relay session', () => {
  it('should answer a request by its own identifier, headers and body absent or present', async () => {
    const { session, daemon } = await serving();
    const first = session.request({ method: 'GET', path: '/v1/sessions' });
    await session.receiveBinary(await daemon.record({ t: 'res', id: 1, status: 200 }));
    should(await first).eql({ kind: 'response', status: 200, headers: {}, body: '' });

    const second = session.request({ method: 'POST', path: '/v1/sessions', body: '{}' });
    await session.receiveBinary(
      await daemon.record({ t: 'res', id: 2, status: 201, headers: { etag: 'w/1' }, body: 'made' }),
    );
    should(await second).eql({ kind: 'response', status: 201, headers: { etag: 'w/1' }, body: 'made' });

    const third = session.request({ method: 'GET', path: '/v1/sessions' });
    await session.receiveBinary(await daemon.record({ t: 'res', id: 3, status: 200, body: 'ab', more: true }));
    await session.receiveBinary(await daemon.record({ t: 'res-more', id: 3, body: 'cd', more: true }));
    await session.receiveBinary(await daemon.record({ t: 'res-more', id: 3, body: 'ef' }));
    should(await third).eql({ kind: 'response', status: 200, headers: {}, body: 'abcdef' });
  });

  it('should refuse a second acceptance and an answer to a request it never sent', async () => {
    const twice = await serving();
    await twice.session.receiveBinary(await twice.daemon.record(ACCEPTED));
    should((await failure(twice.session.request({ method: 'GET', path: '/x' }))).message).match(
      /already authenticated/u,
    );

    const unasked = await serving();
    // THE HANDLER IS ATTACHED BEFORE THE REJECTION CAN FIRE, and that is not a style choice. The
    // record below rejects this request from inside `receiveBinary`; a promise that rejects while
    // nothing is watching it is an unhandled rejection, which Bun fails the file for — intermittently,
    // because whether the test's own `await` has attached a handler by then is a matter of microtask
    // timing. Wrapping first makes the case deterministic against what it is actually asserting.
    const outstanding = failure(unasked.session.request({ method: 'GET', path: '/x' }));
    await unasked.session.receiveBinary(await unasked.daemon.record({ t: 'res', id: 99, status: 200 }));
    should((await outstanding).message).match(/did not send/u);
  });

  it('should return credit once it owes half a window, and never before', async () => {
    const { session, socket, daemon } = await serving();
    // Two end-to-end frames are already consumed: the daemon hello and the acceptance.
    const half = Math.floor(CREDIT_WINDOW_FRAMES / 2);
    should(RELAY_LIMITS.creditWindowFrames).equal(CREDIT_WINDOW_FRAMES);
    const beforeCredit = socket.sent.length;
    for (let index = 0; index < half - 2; index += 1) {
      const pending = session.request({ method: 'GET', path: '/v1/sessions' });
      await session.receiveBinary(await daemon.record({ t: 'res', id: index + 1, status: 200 }));
      await pending;
    }
    // Every request cost one frame; the credit grant is the one extra.
    should(socket.sent.length).equal(beforeCredit + (half - 2) + 1);
  });

  it('should end the session rather than reuse a request identifier', async () => {
    const { session } = await serving({ maxRequestId: 1 });
    const first = session.request({ method: 'GET', path: '/one' });
    const refusal = await failure(session.request({ method: 'GET', path: '/two' }));
    should(refusal.message).match(/exhausted its request identifiers/u);
    await failure(first);
  });

  it('should end the session rather than queue more than one window of records', async () => {
    const { session } = await serving();
    // No credit is ever returned, so the window fills and the queue is all that grows.
    const outstanding: Promise<unknown>[] = [];
    for (let index = 0; index <= CREDIT_WINDOW_FRAMES; index += 1) {
      outstanding.push(session.request({ method: 'GET', path: `/${index}` }).catch(() => 'refused'));
    }
    should(await Promise.all(outstanding)).containEql('refused');
  });
});

/** Let sealing and signing, which resolve on the task queue, finish. */
const drain = async (): Promise<void> => {
  for (let spin = 0; spin < 20; spin += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe('a relay session proving its device', () => {
  it('should open with a credential record that proves this session, never one that names a token', async () => {
    const { socket, daemon } = await serving();
    const credential = (await daemon.receive(socket.sent[1] as Uint8Array)) as Record<string, unknown>;
    should(credential).match({ t: 'auth', protocol: SESSION_PROTOCOL_ID, deviceId: 'fy_dev_session' });
    should(credential.appSession).equal(device.claim.appSession);
    should(await daemon.proves(credential, device.publicKey)).be.true();
    // The proof is over THIS transcript: a different daemon key would not accept it.
    should(await daemon.proves(credential, (await testDevice()).publicKey)).be.false();
  });

  it('should open a stream with a stream-kind proof naming the route and its query', async () => {
    const { socket, daemon } = await streaming({
      mode: { kind: 'stream', device: device.claim, path: '/v1/events', query: [['after', '3']] },
    });
    const credential = (await daemon.receive(socket.sent[1] as Uint8Array)) as Record<string, unknown>;
    should(credential).match({ t: 'stream', path: '/v1/events', query: [['after', '3']] });
    should(await daemon.proves(credential, device.publicKey)).be.true();
  });

  it('should register the public key it pairs with and prove it holds the private half', async () => {
    const pairing = await testDevice();
    const { session, socket, daemon } = await opened({
      mode: {
        kind: 'pair',
        code: 'ABCD-EFGH',
        deviceName: 'phone',
        publicKey: pairing.publicKey,
        key: pairing.claim.key,
      },
    });
    should(session.credentialSent()).be.false();
    await session.receiveBinary(await daemon.answer(socket.sent[0] as Uint8Array));
    await drain();
    should(session.credentialSent()).be.true();
    const credential = (await daemon.receive(socket.sent[1] as Uint8Array)) as Record<string, unknown>;
    should(credential).match({ t: 'pair', code: 'ABCD-EFGH', deviceName: 'phone', deviceKey: pairing.publicKey });
    should(credential).not.have.property('deviceId');
    should(await daemon.proves(credential, pairing.publicKey)).be.true();
  });

  it('should renew its lease by signing the nonce the daemon sent, on a request session', async () => {
    const { session, socket, daemon } = await serving();
    await daemon.receive(socket.sent[1] as Uint8Array);
    await session.receiveBinary(
      await daemon.record({ t: 'renew', protocol: SESSION_PROTOCOL_ID, nonce: 'bm9uY2Utb25l', expiresAt: LEASE_ENDS }),
    );
    await drain();
    const renewed = (await daemon.receive(socket.sent[2] as Uint8Array)) as Record<string, unknown>;
    should(renewed).match({ t: 'renewed', protocol: SESSION_PROTOCOL_ID });
    should(await daemon.proves(renewed, device.publicKey, 'bm9uY2Utb25l')).be.true();
    should(await daemon.proves(renewed, device.publicKey, 'some-other-nonce')).be.false();
    should(session.live()).be.true();
  });

  it('should renew a stream lease the same way, without disturbing the stream', async () => {
    const { session, socket, daemon } = await streaming();
    await daemon.receive(socket.sent[1] as Uint8Array);
    await session.receiveBinary(
      await daemon.record({ t: 'renew', protocol: SESSION_PROTOCOL_ID, nonce: 'c3RyZWFt', expiresAt: LEASE_ENDS }),
    );
    await drain();
    const renewed = (await daemon.receive(socket.sent[2] as Uint8Array)) as Record<string, unknown>;
    should(await daemon.proves(renewed, device.publicKey, 'c3RyZWFt')).be.true();
    should(session.streaming()).be.true();
  });

  it('should not sign a renewal for a session that ended while it was asked', async () => {
    const { session, socket, daemon } = await serving();
    const before = socket.sent.length;
    const asking = session.receiveBinary(
      await daemon.record({ t: 'renew', protocol: SESSION_PROTOCOL_ID, nonce: 'bGF0ZQ', expiresAt: LEASE_ENDS }),
    );
    session.close();
    await asking;
    await drain();
    should(socket.sent.length).equal(before);
  });

  it('should say the access lease ended, so a caller can open a new session rather than report a fault', async () => {
    const { session } = await serving();
    const waiting = failure(session.request({ method: 'GET', path: '/v1/sessions' }));
    await session.receiveBinary(controlFrame(sessionId, { t: 'closed', code: 4441, reason: 'the access lease ended' }));
    const reason = await waiting;
    should(reason.code).equal(4441);
    should(reason.message).match(/access lease on this session ended/u);
  });
});

describe('a relay session told to rotate its device key', () => {
  const ROTATE_BY = '2026-10-01T00:00:00.000Z';

  it('should remember the rotateBy a request session was accepted with, and none when not told', async () => {
    const told = await opened();
    await told.session.receiveBinary(await told.daemon.answer(told.socket.sent[0] as Uint8Array));
    await told.session.receiveBinary(await told.daemon.record({ ...ACCEPTED, rotateBy: ROTATE_BY }));
    should(told.session.rotateBy()).equal(ROTATE_BY);

    const silent = await serving();
    should(silent.session.rotateBy()).be.undefined();
  });

  it('should remember the rotateBy a stream was opened with', async () => {
    const { session } = await streamingWith({ rotateBy: ROTATE_BY });
    should(session.rotateBy()).equal(ROTATE_BY);
  });

  it('should sign the rotation with the NEW key over THIS session’s transcript, for this device only', async () => {
    const { session, daemon } = await serving();
    const replacement = await testDevice();

    const rotation = await session.signRotation('fy_dev_session', replacement.claim.key, replacement.publicKey);

    should(rotation.deviceKey).equal(replacement.publicKey);
    should(await daemon.provesRotation(rotation, 'fy_dev_session')).be.true();
    // Not valid for another device id, and not by the old key's say-so.
    should(await daemon.provesRotation(rotation, 'fy_dev_other')).be.false();
    should(await daemon.provesRotation({ ...rotation, deviceKey: device.publicKey }, 'fy_dev_session')).be.false();
  });

  it('should refuse to sign for a session that is not serving requests', async () => {
    const before = await opened();
    const replacement = await testDevice();
    await should(
      before.session.signRotation('fy_dev_session', replacement.claim.key, replacement.publicKey),
    ).be.rejectedWith(/not serving requests/u);

    const keyed = await opened();
    await keyed.session.receiveBinary(await keyed.daemon.answer(keyed.socket.sent[0] as Uint8Array));
    await settle();
    await should(
      keyed.session.signRotation('fy_dev_session', replacement.claim.key, replacement.publicKey),
    ).be.rejectedWith(/not serving requests/u);
  });
});

describe('a relay session whose daemon is from before device keys', () => {
  it('should name the daemon as the side to update when it answers in the previous dialect', async () => {
    const { session } = await opened();
    await session.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId,
        sequence: 0,
        payload: utf8Bytes(
          JSON.stringify({ t: 'hs2', protocol: 'ferretry-relay/1', epk: 'x', nonce: 'y', spki: 'z', sig: 's' }),
        ),
      }),
    );
    const reason = await failure(session.ready());
    should(reason.message).equal(OLDER_DAEMON_SENTENCE);
    should(reason.code).equal(RELAY_CLOSE_CODES.versionUnsupported);
  });

  it('should name the daemon when it refuses this hello in the words an old daemon uses', async () => {
    const { session } = await opened();
    await session.receiveBinary(
      controlFrame(sessionId, {
        t: 'closed',
        code: RELAY_CLOSE_CODES.protocolError,
        reason: 'unparseable client hello',
      }),
    );
    should((await failure(session.ready())).message).equal(OLDER_DAEMON_SENTENCE);
  });

  it('should NOT blame the daemon for the same refusal once the handshake is past', async () => {
    const { session } = await serving();
    await session.receiveBinary(
      controlFrame(sessionId, {
        t: 'closed',
        code: RELAY_CLOSE_CODES.protocolError,
        reason: 'unparseable client hello',
      }),
    );
    should((await failure(session.request({ method: 'GET', path: '/x' }))).message).not.equal(OLDER_DAEMON_SENTENCE);
  });
});

describe('a relay session carrying a body larger than one record', () => {
  it('should send a large request body as ordered parts the daemon reassembles exactly', async () => {
    const { session, socket, daemon } = await serving();
    const body = `${'a'.repeat(MAX_PLAINTEXT_BYTES)}${'é'.repeat(MAX_PLAINTEXT_BYTES / 2)}tail`;
    const answer = session.request({ method: 'PUT', path: '/v1/big', body });
    await drain();
    await daemon.receive(socket.sent[1] as Uint8Array);
    const parts: Record<string, unknown>[] = [];
    for (const frame of socket.sent.slice(2)) parts.push((await daemon.receive(frame)) as Record<string, unknown>);
    should(parts.length).be.above(2);
    should(parts[0]).match({ t: 'req', id: 1, method: 'PUT', path: '/v1/big', more: true });
    should(parts.slice(1, -1).every(part => part.t === 'req-more' && part.more === true)).be.true();
    should(parts.at(-1)).match({ t: 'req-more', id: 1 });
    should(parts.at(-1)).not.have.property('more');
    should(parts.map(part => part.body).join('')).equal(body);
    await session.receiveBinary(await daemon.record({ t: 'res', id: 1, status: 204 }));
    should((await answer).status).equal(204);
  });

  it('should send a request without a body as one record with no body field', async () => {
    const { session, socket, daemon } = await serving();
    const answer = session.request({ method: 'GET', path: '/v1/small' });
    await drain();
    await daemon.receive(socket.sent[1] as Uint8Array);
    const record = (await daemon.receive(socket.sent[2] as Uint8Array)) as Record<string, unknown>;
    should(record).eql({ t: 'req', id: 1, method: 'GET', path: '/v1/small' });
    await session.receiveBinary(await daemon.record({ t: 'res', id: 1, status: 200 }));
    await answer;
  });

  it('should refuse a request body over the session limit before sending any of it', async () => {
    const { session, socket } = await serving();
    const before = socket.sent.length;
    const refusal = await failure(
      session.request({ method: 'POST', path: '/x', body: 'b'.repeat(MAX_TUNNEL_BODY_BYTES + 1) }),
    );
    should(refusal.code).equal(RELAY_CLOSE_CODES.frameTooLarge);
    should(socket.sent.length).equal(before);
    // Refused, not failed: the session is still good for the next request.
    should(session.live()).be.true();
  });

  it('should end a stream whose text frame cannot fit in one sealed record, and say why', async () => {
    const { session, socket } = await streaming();
    const closed: { code: number; reason: string }[] = [];
    session.onStreamClosed(end => closed.push(end));
    const before = socket.sent.length;

    session.sendStream({ kind: 'text', text: 'x'.repeat(MAX_PLAINTEXT_BYTES) });
    await drain();

    // The seal refused it, so nothing of it left; the stream ended abnormally with the seal's own reason.
    should(socket.sent.length).equal(before);
    should(socket.closed?.code).equal(RELAY_CLOSE_CODES.frameTooLarge);
    should(socket.closed?.reason).match(/payload exceeds one record/u);
    should(closed).eql([{ code: 1006, reason: 'payload exceeds one record' }]);
    should(session.streaming()).be.false();
  });

  it('should end a stream session whose daemon answers with a record that does not open the stream', async () => {
    const harness = await opened({ mode: { kind: 'stream', device: device.claim, path: '/v1/events' } });
    await harness.session.receiveBinary(await harness.daemon.answer(harness.socket.sent[0] as Uint8Array));
    const ready = failure(harness.session.ready());

    await harness.session.receiveBinary(await harness.daemon.record(ACCEPTED));

    const refusal = await ready;
    should(refusal.code).equal(RELAY_CLOSE_CODES.protocolError);
    should(refusal.message).match(/did not open this stream before answering/u);
    should(harness.session.streaming()).be.false();
  });

  it('should refuse an answer part that arrives with no answer to continue, or a second start', async () => {
    const stray = await serving();
    const strayAnswer = failure(stray.session.request({ method: 'GET', path: '/a' }));
    await stray.session.receiveBinary(await stray.daemon.record({ t: 'res-more', id: 1, body: 'x' }));
    should((await strayAnswer).message).match(/answer part out of order/u);

    const restarted = await serving();
    const restartedAnswer = failure(restarted.session.request({ method: 'GET', path: '/a' }));
    await restarted.session.receiveBinary(
      await restarted.daemon.record({ t: 'res', id: 1, status: 200, body: 'x', more: true }),
    );
    await restarted.session.receiveBinary(await restarted.daemon.record({ t: 'res', id: 1, status: 200, body: 'y' }));
    should((await restartedAnswer).message).match(/answer part out of order/u);
  });

  it('should end the session rather than assemble an answer larger than one session carries', async () => {
    const { session, daemon } = await serving();
    const answer = failure(session.request({ method: 'GET', path: '/a' }));
    const chunk = 'z'.repeat(MAX_PLAINTEXT_BYTES - 200);
    await session.receiveBinary(await daemon.record({ t: 'res', id: 1, status: 200, body: chunk, more: true }));
    let sent = chunk.length;
    while (sent <= MAX_TUNNEL_BODY_BYTES) {
      await session.receiveBinary(await daemon.record({ t: 'res-more', id: 1, body: chunk, more: true }));
      sent += chunk.length;
    }
    should((await answer).code).equal(RELAY_CLOSE_CODES.frameTooLarge);
  });

  it('should refuse a record a request session has no reading for', async () => {
    const { session, daemon } = await serving();
    const answer = failure(session.request({ method: 'GET', path: '/a' }));
    await session.receiveBinary(await daemon.record({ t: 'data', text: 'stray' }));
    should((await answer).message).match(/cannot read/u);
  });
});

describe('a relay request its caller gives up on', () => {
  // The phone's message sat at "Sending" because a relayed request that the daemon never answered
  // stayed pending for good: the client's deadline was never handed to the session.
  it('should refuse a request whose signal has already fired, before sending anything', async () => {
    // Arrange
    const { session, socket } = await serving();
    const sent = socket.sent.length;
    const controller = new AbortController();
    controller.abort(new DOMException('gave up', 'TimeoutError'));

    // Act
    const reason = await session.request({ method: 'GET', path: '/v1/sessions' }, controller.signal).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should((reason as Error).name).equal('TimeoutError');
    should(socket.sent.length).equal(sent);
  });

  it('should reject with the caller’s own reason, drop the late answer, and keep serving', async () => {
    // Arrange
    const { session, daemon } = await serving();
    const controller = new AbortController();
    const abandoned = session.request({ method: 'GET', path: '/v1/sessions/one/sends' }, controller.signal).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    await settle();

    // Act
    controller.abort(new DOMException('the deadline passed', 'TimeoutError'));
    const reason = await abandoned;
    await session.receiveBinary(await daemon.record({ t: 'res', id: 1, status: 200, body: 'la', more: true }));
    await session.receiveBinary(await daemon.record({ t: 'res-more', id: 1, body: 'te' }));
    const next = session.request({ method: 'GET', path: '/v1/sessions' });
    await session.receiveBinary(await daemon.record({ t: 'res', id: 2, status: 200, body: 'fresh' }));

    // Assert
    should((reason as Error).name).equal('TimeoutError');
    should(await next).eql({ kind: 'response', status: 200, headers: {}, body: 'fresh' });
    should(session.live()).be.true();
  });

  it('should still read an abort with no reason of its own as an abandoned request', async () => {
    // Arrange
    const { session } = await serving();
    const signal = {
      aborted: false,
      reason: 'not an error',
      throwIfAborted: () => undefined,
    } as unknown as AbortSignal;
    let abort: (() => void) | undefined;
    Object.assign(signal, {
      addEventListener: (_type: string, listener: () => void) => {
        abort = listener;
      },
      removeEventListener: () => undefined,
    });
    const pending = session.request({ method: 'GET', path: '/x' }, signal).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    await settle();

    // Act
    abort?.();
    abort?.();

    // Assert
    should(((await pending) as Error).message).equal('the request was abandoned');
  });

  it('should forget its deadline once the answer arrives', async () => {
    // Arrange
    const { session, daemon } = await serving();
    const controller = new AbortController();
    const answered = session.request({ method: 'GET', path: '/x' }, controller.signal);
    await session.receiveBinary(await daemon.record({ t: 'res', id: 1, status: 204 }));

    // Act
    const answer = await answered;
    controller.abort();

    // Assert
    should(answer).eql({ kind: 'response', status: 204, headers: {}, body: '' });
    should(session.live()).be.true();
  });
});
