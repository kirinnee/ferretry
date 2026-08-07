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
import {
  CREDIT_WINDOW_FRAMES,
  encodeCreditPayload,
  encodeFrame,
  FRAME_KINDS,
  MAX_PLAINTEXT_BYTES,
  RELAY_CLOSE_CODES,
  RELAY_LIMITS,
  RELAY_PROTOCOL_ID,
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
  newDaemonIdentity,
  readyFrame,
  relayCrypto,
  ScriptedDaemon,
  ScriptedSocket,
  testSessionId,
} from '../support/relay.ts';

const DEVICE_TOKEN = 'fy_device_secret';
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
    mode: { kind: 'auth', deviceToken: DEVICE_TOKEN },
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
  await harness.session.receiveBinary(await harness.daemon.record({ t: 'authenticated', protocol: RELAY_PROTOCOL_ID }));
  return harness;
};

/** A keyed stream the daemon has accepted: ready to carry frames and conclude. */
const streaming = async (overrides: Partial<RelayClientSessionDependencies> = {}): Promise<Harness> => {
  const harness = await opened({
    mode: { kind: 'stream', deviceToken: DEVICE_TOKEN, path: '/v1/events' },
    ...overrides,
  });
  const hello = harness.socket.sent[0];
  if (hello === undefined) throw new Error('the session sent no hello');
  await harness.session.receiveBinary(await harness.daemon.answer(hello));
  const ready = harness.session.ready();
  await harness.session.receiveBinary(await harness.daemon.record({ t: 'stream-opened', protocol: RELAY_PROTOCOL_ID }));
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
    should(decodeTunnelDaemonMessage(utf8Bytes(`{"t":"oversize","id":1,"status":200,"byteLength":9}`))).match({
      byteLength: 9,
    });
    should(MAX_TUNNEL_REQUEST_ID).equal(0xffff_ffff);
  });

  it('should encode a client message as one JSON object', () => {
    const encoded = encodeTunnelClientMessage({ t: 'auth', protocol: RELAY_PROTOCOL_ID, deviceToken: 'token' });
    should(JSON.parse(new TextDecoder().decode(encoded))).match({ t: 'auth', deviceToken: 'token' });
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
      mode: { kind: 'auth', deviceToken: DEVICE_TOKEN },
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

  it('should refuse a daemon whose key is not the pinned fingerprint, before sending the token', async () => {
    const impostor = await newDaemonIdentity();
    const { session, socket, daemon } = await opened();
    const hello = socket.sent[0];
    if (hello === undefined) throw new Error('no hello');
    const answered = await new ScriptedDaemon(impostor, daemon.sessionId).spoof(hello);
    await session.receiveBinary(answered);
    should((await failure(session.ready())).message).match(/pinned fingerprint/u);
    // One frame only: the hello. The credential never left this browser.
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
    const record = await daemon.record({ t: 'authenticated', protocol: RELAY_PROTOCOL_ID });
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
      await daemon.record({ t: 'stream-close', protocol: RELAY_PROTOCOL_ID, code: 1013, reason: 'fell behind' }),
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
    await session.receiveBinary(await daemon.record({ t: 'oversize', id: 3, status: 200, byteLength: 402_641 }));
    should(await third).eql({ kind: 'oversize', status: 200, byteLength: 402_641 });
  });

  it('should refuse a second acceptance and an answer to a request it never sent', async () => {
    const twice = await serving();
    await twice.session.receiveBinary(await twice.daemon.record({ t: 'authenticated', protocol: RELAY_PROTOCOL_ID }));
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

  it('should end the session rather than send a record that cannot fit one frame', async () => {
    const { session } = await serving();
    const refusal = await failure(
      session.request({ method: 'POST', path: '/x', body: 'b'.repeat(MAX_PLAINTEXT_BYTES) }),
    );
    should(refusal.code).equal(RELAY_CLOSE_CODES.frameTooLarge);
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
