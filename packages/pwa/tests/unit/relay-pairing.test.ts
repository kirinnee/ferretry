/**
 * FIRST CONTACT AND LIVE STREAMS, one refusal at a time.
 *
 * `docs/relay-protocol.md` §14's two new session modes, proved against real WebCrypto and a
 * rendezvous scripted frame by frame. The happy paths also run end to end against the REAL
 * rendezvous and the REAL daemon link in `tests/integration/relay-carrier-end-to-end.test.ts`; what
 * only this file can produce is the misbehaviour a conforming daemon never emits — a close that
 * arrives while the sealed outcome is still decrypting, a `4440` with no outcome before it, a
 * `stream-opened` on a pairing session — and every one of those must be refused rather than absorbed.
 */

import { RELAY_SESSION_CONCLUDED_CLOSE_CODE } from '@ferretry/protocol';
import {
  decodeFrame,
  FRAME_KINDS,
  fromBase64Url,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  toBase64Url,
  utf8Bytes,
} from '@ferretry/relay';
import { describe, it } from 'bun:test';
import should from 'should';
import type { RelayCarrier } from '../../src/lib/daemon-connection.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { PairingSeed } from '../../src/lib/pairing.ts';
import { DaemonEventTransport } from '../../src/lib/event-transport.ts';
import { DaemonCarrierRouter } from '../../src/lib/relay-carrier.ts';
import { browserTerminalStreamAttach, TerminalStreamRefused } from '../../src/lib/web-terminals.ts';
import { redeemPairingOverRelay, relayPairingCandidates } from '../../src/lib/relay-pairing.ts';
import {
  PAIRING_REFUSED_REASON,
  RELAY_DATA_BYTE_BUDGET,
  RelayClientSession,
  RelayPairingRefusedError,
  type RelaySessionMode,
  type RelayStreamFrame,
  RelayStreamRefusedError,
  RelaySessionError,
} from '../../src/lib/relay-session.ts';
import {
  autoDial,
  newDaemonIdentity,
  readyFrame,
  relayCrypto,
  ScriptedDaemon,
  ScriptedSocket,
  settle,
  testSessionId,
} from '../support/relay.ts';

const sessionId = testSessionId();
const CODE = '7F3K-Q2ND';
const FINGERPRINT = `fy_daemon_${'A'.repeat(43)}`;
const HOSTED = 'wss://relay.ferretry.test';
const LINK_RELAY: RelayCarrier = { kind: 'relay', relayUrl: 'wss://relay.mine.test' };

const seedFor = (daemonId: string, relay?: RelayCarrier): PairingSeed => ({
  daemonUrl: 'https://studio.example',
  daemonId,
  code: CODE,
  ...(relay === undefined ? {} : { relay }),
});

const PAIRED_RESPONSE = {
  deviceToken: `fy_device_${'b'.repeat(43)}`,
  daemonId: FINGERPRINT,
  daemonName: 'Studio',
  capabilities: [],
  carriers: [],
} as const;

interface Harness {
  readonly session: RelayClientSession;
  readonly socket: ScriptedSocket;
  readonly daemon: ScriptedDaemon;
}

/** A keyed session in the given mode, with the daemon ready to answer its credential record. */
const keyed = async (mode: RelaySessionMode, onData?: (frame: RelayStreamFrame) => void): Promise<Harness> => {
  const identity = await newDaemonIdentity();
  const socket = new ScriptedSocket();
  const session = new RelayClientSession({
    crypto: relayCrypto,
    daemonId: identity.daemonId,
    mode,
    socket,
    ...(onData === undefined ? {} : { onData }),
  });
  await session.receiveBinary(readyFrame(sessionId));
  const daemon = new ScriptedDaemon(identity, sessionId);
  const hello = socket.sent[0];
  if (hello === undefined) throw new Error('the session sent no hello');
  await session.receiveBinary(await daemon.answer(hello));
  return { session, socket, daemon };
};

const pairMode: RelaySessionMode = { kind: 'pair', code: CODE, deviceName: 'Ferretry PWA' };
const streamMode: RelaySessionMode = {
  kind: 'stream',
  deviceToken: 'fy_device_x',
  path: '/v1/events',
  query: [['after', '0']],
};

const failure = async (promise: Promise<unknown>): Promise<Error> => {
  const reason = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(reason instanceof Error)) throw new Error('expected a refusal');
  return reason;
};

describe('the rendezvous candidates one redemption may try', () => {
  it('should offer the link candidate first and the advertisement second', () => {
    should(relayPairingCandidates(seedFor(FINGERPRINT, LINK_RELAY), HOSTED)).eql([
      LINK_RELAY,
      { kind: 'relay', relayUrl: HOSTED, operator: 'hosted' },
    ]);
  });

  /*
   * A daemon whose first published relay IS the hosted one would otherwise be dialled twice: two
   * sockets, two handshakes, and two attempts spent from a five-guess budget to ask one question.
   */
  it('should dial one address once even when the link and the advertisement agree', () => {
    const same: RelayCarrier = { kind: 'relay', relayUrl: HOSTED };
    should(relayPairingCandidates(seedFor(FINGERPRINT, same), HOSTED)).have.length(1);
  });

  it('should leave a v1 link with only the advertisement, and a directory-less build with nothing', () => {
    should(relayPairingCandidates(seedFor(FINGERPRINT), HOSTED)).eql([
      { kind: 'relay', relayUrl: HOSTED, operator: 'hosted' },
    ]);
    should(relayPairingCandidates(seedFor(FINGERPRINT), undefined)).eql([]);
  });

  /*
   * A rendezvous is addressed by the fingerprint (§4) and the handshake is checked against that same
   * string (§6). Any other spelling has nothing to verify against, and a session keyed against an
   * unverifiable fingerprint is exactly the one a hostile carrier would like this browser to open.
   */
  it('should offer nothing at all to a fingerprint no rendezvous can address', () => {
    should(relayPairingCandidates(seedFor('sha256:legacy', LINK_RELAY), HOSTED)).eql([]);
  });

  it('should refuse an advertised address this browser may not dial', () => {
    should(relayPairingCandidates(seedFor(FINGERPRINT), 'http://plaintext.example')).eql([]);
    should(relayPairingCandidates(seedFor(FINGERPRINT), 'not a url')).eql([]);
  });
});

describe('a pairing session', () => {
  it('should send the sealed pair record and nothing else at sequence 1', async () => {
    const { socket } = await keyed(pairMode);
    const record = socket.sent.at(-1);
    should(record).not.be.undefined();
    // The code and the device name are inside the channel: the frame carries neither in the clear.
    const wire = new TextDecoder().decode(record as Uint8Array);
    should(wire).not.containEql(CODE);
    should(wire).not.containEql('Ferretry PWA');
  });

  it('should answer with the redemption response the daemon sealed, verbatim', async () => {
    const { session, daemon } = await keyed(pairMode);
    const outcome = session.paired();
    await session.receiveBinary(
      await daemon.record({ t: 'paired', protocol: RELAY_PROTOCOL_ID, response: PAIRED_RESPONSE }),
    );
    should((await outcome).response).eql(PAIRED_RESPONSE);
  });

  /*
   * THE LATCH, and the reason it exists. §14 puts the sealed outcome before the `4440` close, so a
   * client that read that close as a failure would discard a pairing that SUCCEEDED — the daemon has
   * already minted the grant and the operator can see the device.
   */
  it('should treat the close that follows a sealed outcome as expected teardown', async () => {
    const { session, daemon } = await keyed(pairMode);
    const outcome = session.paired();
    await session.receiveBinary(
      await daemon.record({ t: 'paired', protocol: RELAY_PROTOCOL_ID, response: PAIRED_RESPONSE }),
    );
    session.carrierClosed(RELAY_SESSION_CONCLUDED_CLOSE_CODE, '');
    should((await outcome).kind).equal('paired');
  });

  /*
   * THE RACE THIS CLASS USED TO LOSE. Opening a record is asynchronous — it decrypts — while a
   * socket close arrives synchronously, and the adapter hands frames over without awaiting them. A
   * close applied under an in-flight record set the phase to `ended`, and the resumed handler then
   * dropped the outcome on the floor: the daemon minted the grant and the browser reported failure.
   */
  it('should not lose a sealed outcome to a close that arrives while it is still decrypting', async () => {
    const { session, daemon } = await keyed(pairMode);
    const outcome = session.paired();
    const sealed = await daemon.record({ t: 'paired', protocol: RELAY_PROTOCOL_ID, response: PAIRED_RESPONSE });
    // Deliberately NOT awaited: this is what the socket adapter does, and it is what makes the race
    // reachable at all.
    const reading = session.receiveBinary(sealed);
    session.carrierClosed(RELAY_SESSION_CONCLUDED_CLOSE_CODE, '');
    await reading;
    should((await outcome).kind).equal('paired');
  });

  it('should report a sealed refusal as its own class, and never as a transport failure', async () => {
    const { session, daemon } = await keyed(pairMode);
    const outcome = session.paired();
    await session.receiveBinary(
      await daemon.record({ t: 'pair-refused', protocol: RELAY_PROTOCOL_ID, reason: PAIRING_REFUSED_REASON }),
    );
    const reason = await failure(outcome);
    should(reason).be.instanceof(RelayPairingRefusedError);
    should(reason).not.be.instanceof(RelaySessionError);
  });

  /*
   * §14: "a `4440` with no sealed outcome before it is a protocol violation". Reported as one rather
   * than smoothed into a quiet end, because a session that owed an answer and closed instead is a
   * daemon this browser cannot reason about.
   */
  it('should report a concluded close that stated no outcome as the violation it is', async () => {
    const { session } = await keyed(pairMode);
    const outcome = session.paired();
    session.carrierClosed(RELAY_SESSION_CONCLUDED_CLOSE_CODE, '');
    should((await failure(outcome)).message).match(/without stating an outcome/u);
  });

  it('should refuse a daemon that answers a pairing attempt with anything else', async () => {
    const { session, daemon } = await keyed(pairMode);
    const outcome = session.paired();
    await session.receiveBinary(await daemon.record({ t: 'authenticated', protocol: RELAY_PROTOCOL_ID }));
    should((await failure(outcome)).message).match(/did not answer this pairing attempt/u);
  });

  it('should never serve a request, whatever the daemon says', async () => {
    const { session, daemon } = await keyed(pairMode);
    await session.receiveBinary(
      await daemon.record({ t: 'paired', protocol: RELAY_PROTOCOL_ID, response: PAIRED_RESPONSE }),
    );
    should(session.live()).be.false();
    should(await failure(session.request({ method: 'GET', path: '/v1/sessions' }))).be.instanceof(RelaySessionError);
  });
});

describe('redeeming over one rendezvous', () => {
  it('should refuse a fingerprint that cannot address a rendezvous rather than dialling', async () => {
    const reason = await failure(
      redeemPairingOverRelay({
        crypto: relayCrypto,
        seed: seedFor('sha256:legacy'),
        deviceName: 'Ferretry PWA',
        rendezvous: LINK_RELAY,
        dial: () => {
          throw new Error('nothing may be dialled for an unverifiable fingerprint');
        },
      }),
    );
    should(reason.message).match(/cannot address a rendezvous/u);
  });
});

describe('a stream session', () => {
  it('should open the stream in its credential record and carry frames both ways', async () => {
    const received: RelayStreamFrame[] = [];
    const { session, socket, daemon } = await keyed(streamMode, frame => received.push(frame));
    const ready = session.ready();
    await session.receiveBinary(await daemon.record({ t: 'stream-opened', protocol: RELAY_PROTOCOL_ID }));
    await ready;
    should(session.streaming()).be.true();

    await session.receiveBinary(await daemon.record({ t: 'data', text: '{"kind":"event"}' }));
    await session.receiveBinary(await daemon.record({ t: 'data', bytes: toBase64Url(utf8Bytes('shell output')) }));
    should(received).have.length(2);
    should(received[0]).eql({ kind: 'text', text: '{"kind":"event"}' });
    should(new TextDecoder().decode((received[1] as { bytes: Uint8Array }).bytes)).equal('shell output');

    const before = socket.sent.length;
    session.sendStream({ kind: 'text', text: '{"type":"resize"}' });
    await settle();
    should(socket.sent.length).equal(before + 1);
  });

  /*
   * §14: "a client splits an oversized write — a 64 KiB paste — into ordered `bytes` records", at a
   * budget that is DERIVED, "not a constant to hard-code, because it moves if the envelope does".
   * Text is never split, because a text frame is a message and half a message is corruption.
   */
  it('should split an oversized write into ordered records and never split a control frame', async () => {
    const { session, socket, daemon } = await keyed(streamMode);
    const ready = session.ready();
    await session.receiveBinary(await daemon.record({ t: 'stream-opened', protocol: RELAY_PROTOCOL_ID }));
    await ready;

    const before = socket.sent.length;
    const paste = new Uint8Array(RELAY_DATA_BYTE_BUDGET * 2 + 1).fill(65);
    session.sendStream({ kind: 'bytes', bytes: paste });
    await settle();
    should(socket.sent.length).equal(before + 3);

    const control = socket.sent.length;
    session.sendStream({ kind: 'text', text: 'x'.repeat(RELAY_DATA_BYTE_BUDGET) });
    await settle();
    should(socket.sent.length).equal(control + 1);
  });

  it('should surface a refusal with the status the direct upgrade would have carried', async () => {
    const { session, daemon } = await keyed(streamMode);
    const ready = session.ready();
    await session.receiveBinary(
      await daemon.record({ t: 'stream-refused', protocol: RELAY_PROTOCOL_ID, status: 404, body: 'no terminal' }),
    );
    const reason = await failure(ready);
    should(reason).be.instanceof(RelayStreamRefusedError);
    should((reason as RelayStreamRefusedError).status).equal(404);
    should((reason as RelayStreamRefusedError).body).equal('no terminal');
  });

  /*
   * The sealed close is the stream's verdict and the `4440` after it is teardown. A consumer that
   * read the session's code would be handed a number `shouldReopenTerminalStream` treats as "retry"
   * against a stream the daemon deliberately ended.
   */
  it('should report the sealed close code and not the session close that follows it', async () => {
    const { session, daemon } = await keyed(streamMode);
    const ready = session.ready();
    await session.receiveBinary(await daemon.record({ t: 'stream-opened', protocol: RELAY_PROTOCOL_ID }));
    await ready;
    const closes: { code: number; reason: string }[] = [];
    session.onStreamClosed(closed => closes.push(closed));
    await session.receiveBinary(
      await daemon.record({ t: 'stream-close', protocol: RELAY_PROTOCOL_ID, code: 1013, reason: 'fell behind' }),
    );
    session.carrierClosed(RELAY_SESSION_CONCLUDED_CLOSE_CODE, '');
    should(closes).eql([{ code: 1013, reason: 'fell behind' }]);
  });

  it('should answer a listener that subscribes after the stream already ended', async () => {
    const { session, daemon } = await keyed(streamMode);
    const ready = session.ready();
    await session.receiveBinary(await daemon.record({ t: 'stream-opened', protocol: RELAY_PROTOCOL_ID }));
    await ready;
    await session.receiveBinary(
      await daemon.record({ t: 'stream-close', protocol: RELAY_PROTOCOL_ID, code: 1000, reason: 'done' }),
    );
    const closes: number[] = [];
    session.onStreamClosed(closed => closes.push(closed.code));
    should(closes).eql([1000]);
  });

  /*
   * §14 makes a client's leave an explicit sealed record "so that the taxonomy survives in both
   * directions and a deliberate leave is never spelled the same as a network failure".
   */
  it('should leave by sealing a close rather than by dropping the socket', async () => {
    const { session, socket, daemon } = await keyed(streamMode);
    const ready = session.ready();
    await session.receiveBinary(await daemon.record({ t: 'stream-opened', protocol: RELAY_PROTOCOL_ID }));
    await ready;
    const before = socket.sent.length;
    session.closeStream(1000, 'the viewer left this stream');
    await settle();
    should(socket.sent.length).equal(before + 1);
    should(socket.closed).be.null();
    should(session.streaming()).be.false();
  });

  it('should end a stream that dies with no sealed close, in the same shape as an orderly one', async () => {
    const { session, daemon } = await keyed(streamMode);
    const ready = session.ready();
    await session.receiveBinary(await daemon.record({ t: 'stream-opened', protocol: RELAY_PROTOCOL_ID }));
    await ready;
    const closes: number[] = [];
    session.onStreamClosed(closed => closes.push(closed.code));
    session.carrierClosed(RELAY_CLOSE_CODES.heartbeatTimeout, 'evicted');
    // `1006` is the browser's own word for "abnormally, with no close frame", which is what this is.
    should(closes).eql([1006]);
  });

  it('should refuse bytes that are not base64url, rather than writing invented bytes', async () => {
    const { session, daemon } = await keyed(streamMode);
    const ready = session.ready();
    await session.receiveBinary(await daemon.record({ t: 'stream-opened', protocol: RELAY_PROTOCOL_ID }));
    await ready;
    await session.receiveBinary(await daemon.record({ t: 'data', bytes: 'not base64url!!' }));
    should(await failure(session.paired())).be.instanceof(RelaySessionError);
    should(fromBase64Url('not base64url!!')).be.null();
  });

  it('should refuse a request answer on a stream session and a data record on a request session', async () => {
    const streaming = await keyed(streamMode);
    const ready = streaming.session.ready();
    await streaming.session.receiveBinary(
      await streaming.daemon.record({ t: 'stream-opened', protocol: RELAY_PROTOCOL_ID }),
    );
    await ready;
    await streaming.session.receiveBinary(await streaming.daemon.record({ t: 'res', id: 1, status: 200 }));
    should(streaming.session.streaming()).be.false();

    const serving = await keyed({ kind: 'auth', deviceToken: 'fy_device_x' });
    const authenticated = serving.session.ready();
    await serving.session.receiveBinary(
      await serving.daemon.record({ t: 'authenticated', protocol: RELAY_PROTOCOL_ID }),
    );
    await authenticated;
    await serving.session.receiveBinary(await serving.daemon.record({ t: 'data', text: 'x' }));
    should(serving.session.live()).be.false();
  });

  it('should refuse to carry a frame before the daemon has opened the stream', async () => {
    const { session } = await keyed(streamMode);
    should(() => session.sendStream({ kind: 'text', text: 'x' })).throw(/not carrying a stream/u);
  });
});

describe('the carrier a redemption and a stream actually travel', () => {
  const identity = async () => await newDaemonIdentity();
  const RENDEZVOUS = { kind: 'relay' as const, relayUrl: 'wss://relay.example', operator: 'hosted' as const };

  it('should redeem over a dialled rendezvous and hand back the response verbatim', async () => {
    const id = await identity();
    const response = {
      deviceToken: `fy_device_${'m'.repeat(43)}`,
      daemonId: id.daemonId,
      daemonName: 'Studio',
      capabilities: [],
      carriers: [],
    };
    const auto = autoDial(id, { paired: response });

    const paired = await redeemPairingOverRelay({
      crypto: relayCrypto,
      seed: seedFor(id.daemonId),
      deviceName: 'Ferretry PWA',
      rendezvous: RENDEZVOUS,
      dial: auto.dial,
      heartbeat: () => () => undefined,
    });

    should(paired).eql(response);
    should(auto.requests[0]).match({ t: 'pair', code: CODE, deviceName: 'Ferretry PWA' });
    // The socket is closed by this side once the exchange is over: an attempt that resolved and left
    // a connection open would hold one of the eight sessions a rendezvous serves for nothing.
    should(auto.sockets[0]?.closed?.code).equal(1000);
  });

  it('should reject a sealed refusal as its own class rather than as a carrier failure', async () => {
    const id = await identity();
    const auto = autoDial(id, { pairRefused: true });
    const reason = await failure(
      redeemPairingOverRelay({
        crypto: relayCrypto,
        seed: seedFor(id.daemonId),
        deviceName: 'Ferretry PWA',
        rendezvous: RENDEZVOUS,
        dial: auto.dial,
        heartbeat: () => () => undefined,
      }),
    );
    should(reason).be.instanceof(RelayPairingRefusedError);
  });
});

describe('a stream opened through the carrier router', () => {
  const RELAY = { kind: 'relay' as const, relayUrl: 'wss://relay.example', operator: 'hosted' as const };

  /** A router whose walk has already measured a relay, which is the state `openStream` reads. */
  const routed = async (answer: Parameters<typeof autoDial>[1] = {}) => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, { ...answer, body: '{}' });
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      dial: auto.dial,
      heartbeat: () => () => undefined,
      network: async () => {
        throw new Error('direct is not reachable in this case');
      },
    });
    const daemon = daemonConnection({
      daemonId: id.daemonId,
      baseUrl: 'https://studio.example',
      deviceToken: `fy_device_${'x'.repeat(43)}`,
      carriers: [{ kind: 'direct', daemonUrl: 'https://studio.example' }, RELAY],
    });
    // One ordinary request first: `openStream` reads a MEASURED carrier and never probes for one.
    await router.send(daemon, 'https://studio.example/v1/health');
    return { router, daemon, auto };
  };

  it('should answer null while nothing has measured a carrier, rather than probing for one', async () => {
    const id = await newDaemonIdentity();
    const router = new DaemonCarrierRouter({ crypto: relayCrypto, dial: () => new ScriptedSocket() });
    const daemon = daemonConnection({
      daemonId: id.daemonId,
      baseUrl: 'https://studio.example',
      deviceToken: `fy_device_${'x'.repeat(43)}`,
    });
    should(await router.openStream(daemon, { path: '/v1/events', onData: () => undefined })).be.null();
  });

  it('should open one stream session per stream and register it where an unpair can reach it', async () => {
    const frames: RelayStreamFrame[] = [];
    const { router, daemon, auto } = await routed({ streamFrames: [{ t: 'data', text: 'one' }] });

    const first = await router.openStream(daemon, { path: '/v1/events', onData: frame => frames.push(frame) });
    const second = await router.openStream(daemon, {
      path: '/v1/sessions/s/terminals/t/stream',
      onData: () => undefined,
    });
    await settle();

    should(first).not.be.null();
    should(second).not.be.null();
    // Two streams are two SESSIONS: §14 rejects multiplexing, so the request session, the event
    // stream and the terminal stream are three sockets and not one.
    should(auto.sockets.length).equal(3);
    should(frames).eql([{ kind: 'text', text: 'one' }]);

    // THE CREDENTIAL-LIFETIME RULE. §14: every session a client holds must be owned by the structure
    // unpairing tears down, or a stream is a live socket presenting a grant revocation cannot reach.
    router.clearDaemon(daemon.daemonId);
    await settle();
    should(first?.streaming()).be.false();
    should(second?.streaming()).be.false();
  });

  it('should reuse the live session for a stream already open at the same path', async () => {
    const { router, daemon, auto } = await routed();
    const opened = auto.sockets.length;
    await router.openStream(daemon, { path: '/v1/events', onData: () => undefined });
    await router.openStream(daemon, { path: '/v1/events', onData: () => undefined });
    await settle();
    should(auto.sockets.length).equal(opened + 1);
  });

  it('should surface the daemon refusal with its status rather than a bare failure', async () => {
    const { router, daemon } = await routed({ streamRefused: { status: 404, body: 'no terminal' } });
    const reason = await failure(
      router.openStream(daemon, { path: '/v1/sessions/s/terminals/gone/stream', onData: () => undefined }),
    );
    should(reason).be.instanceof(RelayStreamRefusedError);
    should((reason as RelayStreamRefusedError).status).equal(404);
  });
});

describe('a terminal and an event feed on a relayed carrier', () => {
  const scope = { daemonId: 'fy_daemon_x' as never, sessionId: 'shared' } as never;
  const daemon = daemonConnection({
    daemonId: 'fy_daemon_x',
    baseUrl: 'https://studio.example',
    deviceToken: `fy_device_${'x'.repeat(43)}`,
  });

  /** A stream session the suite drives directly, standing in for one the router opened. */
  const scriptedStream = async (): Promise<Harness> => await keyed(streamMode);

  const openStreamWith = (session: RelayClientSession, seen: { path?: string }) => {
    return async (_daemon: unknown, request: { path: string; onData: (frame: RelayStreamFrame) => void }) => {
      seen.path = request.path;
      onFrame = request.onData;
      return session;
    };
  };
  let onFrame: ((frame: RelayStreamFrame) => void) | undefined;

  it('should carry terminal output up, split writes down and seal its own leave', async () => {
    const { session, socket, daemon: scripted } = await scriptedStream();
    const ready = session.ready();
    await session.receiveBinary(await scripted.record({ t: 'stream-opened', protocol: RELAY_PROTOCOL_ID }));
    await ready;

    const received: Uint8Array[] = [];
    const seen: { path?: string } = {};
    const attach = browserTerminalStreamAttach(openStreamWith(session, seen) as never, async () => {
      throw new Error('a relayed terminal buys no ticket');
    });
    const stream = await attach(daemon, scope, 'a1b2c3d4e5f6', {
      onOpen: () => undefined,
      onBytes: bytes => received.push(bytes),
      onClosed: () => undefined,
      onRefused: () => undefined,
    });
    should(seen.path).equal('/v1/sessions/shared/terminals/a1b2c3d4e5f6/stream');

    // Output arrives as bytes; a TEXT record on this route is a shape the terminal does not have and
    // is dropped rather than written into the emulator as if the shell had printed it.
    onFrame?.({ kind: 'bytes', bytes: utf8Bytes('built ok') });
    onFrame?.({ kind: 'text', text: '{"type":"resize"}' });
    should(received).have.length(1);

    const before = socket.sent.length;
    stream.write(new Uint8Array(RELAY_DATA_BYTE_BUDGET + 1).fill(65));
    await settle();
    should(socket.sent.length).equal(before + 2);

    const control = socket.sent.length;
    stream.control('{"type":"resize"}');
    stream.close(1000, 'terminal tab detached');
    await settle();
    should(socket.sent.length).equal(control + 2);
    should(socket.closed).be.null();
  });

  it('should report a refused relayed terminal without buying a ticket or opening a socket', async () => {
    const refusals: { status: number; body: string }[] = [];
    const attach = browserTerminalStreamAttach(
      (async () => {
        throw new RelayStreamRefusedError(403, 'the operator refused this capability');
      }) as never,
      async () => {
        throw new Error('a refused relayed terminal buys no ticket');
      },
    );
    const reason = await failure(
      attach(daemon, scope, 'a1b2c3d4e5f6', {
        onOpen: () => undefined,
        onBytes: () => undefined,
        onClosed: () => undefined,
        onRefused: (status, body) => refusals.push({ status, body }),
      }),
    );
    should(reason).be.instanceof(TerminalStreamRefused);
    should(refusals).eql([{ status: 403, body: 'the operator refused this capability' }]);
  });

  it('should carry the event feed as a stream session and end on the sealed close', async () => {
    const { session, daemon: scripted } = await scriptedStream();
    const ready = session.ready();
    await session.receiveBinary(await scripted.record({ t: 'stream-opened', protocol: RELAY_PROTOCOL_ID }));
    await ready;

    const messages: unknown[] = [];
    const transport = new DaemonEventTransport(
      daemon,
      async () => {
        throw new Error('a relayed stream mints no ticket');
      },
      () => {
        throw new Error('a relayed stream opens no socket');
      },
      () => ({ kind: 'relay', relayUrl: 'wss://relay.example', operator: 'hosted' }),
      openStreamWith(session, {}) as never,
    );
    const streaming = transport.stream({
      url: 'wss://studio.example/v1/events?after=0',
      token: 'x',
      onMessage: value => messages.push(value),
    });

    onFrame?.({ kind: 'text', text: '{"kind":"event"}' });
    // Bytes on the event route are a shape this stream does not have, and are not parsed as text.
    onFrame?.({ kind: 'bytes', bytes: utf8Bytes('not an event') });
    await session.receiveBinary(
      await scripted.record({ t: 'stream-close', protocol: RELAY_PROTOCOL_ID, code: 1013, reason: 'fell behind' }),
    );

    should(await failure(streaming)).match({ message: /1013 fell behind/u });
    should(messages).eql([{ kind: 'event' }]);
  });

  it('should refuse an event stream when the carrier is no longer a rendezvous', async () => {
    const transport = new DaemonEventTransport(
      daemon,
      async () => 'ticket',
      () => {
        throw new Error('no socket');
      },
      () => ({ kind: 'relay', relayUrl: 'wss://relay.example', operator: 'hosted' }),
      async () => null,
    );
    should(
      (
        await failure(
          transport.stream({ url: 'wss://studio.example/v1/events', token: 'x', onMessage: () => undefined }),
        )
      ).message,
    ).match(/no longer reachable over a rendezvous/u);
  });
});

describe('the two sequence counters one channel holds', () => {
  /**
   * A DETERMINISTIC REGRESSION FOR COUNTER OWNERSHIP, not a stress test.
   *
   * `ChannelState` carries `sendSequence` AND `receiveSequence`, and this session opens records on
   * the inbox while sealing them on the outbox — both asynchronous, both writing the channel back.
   * Writing the WHOLE captured state back means whichever finishes last rewinds the other's counter
   * with a copy taken before its own await.
   *
   * The interleave is forced rather than hoped for: `request` is deliberately not awaited, so its
   * seal is in flight on the outbox at the moment `receiveBinary` starts an open. A rewound
   * `receiveSequence` shows up as `4420` on the next arriving record; a rewound `sendSequence` is
   * worse and quieter — a record's sequence IS its AEAD nonce, so the next seal reuses one under the
   * same key, which is the arithmetic mistake AES-GCM does not survive.
   *
   * The nonce claim is read OFF THE WIRE rather than out of a private field: every record this side
   * sealed is on the socket, and its frame sequence IS the nonce it was sealed under. Two frames
   * carrying one sequence is the defect, stated in the only terms an attacker would also see.
   */
  it('should never reuse a record sequence when a seal and an open overlap', async () => {
    const { session, socket, daemon } = await keyed({ kind: 'auth', deviceToken: 'fy_device_x' });
    const ready = session.ready();
    await session.receiveBinary(await daemon.record({ t: 'authenticated', protocol: RELAY_PROTOCOL_ID }));
    await ready;

    for (let round = 1; round <= 6; round += 1) {
      // NOT awaited: the seal this starts must still be in flight when the open below begins.
      const answer = session.request({ method: 'GET', path: '/v1/sessions' });
      await session.receiveBinary(await daemon.record({ t: 'res', id: round, status: 200 }));
      should(await answer).match({ kind: 'response', status: 200 });
    }

    // Every RECORD this side sealed, by the sequence it was sealed under.
    const sealed = socket.sent
      .map(bytes => decodeFrame(bytes))
      .flatMap(decoded => (decoded.ok && decoded.frame.kind === FRAME_KINDS.data ? [decoded.frame.sequence] : []));
    should(sealed.length).be.aboveOrEqual(7);
    should(new Set(sealed).size).equal(sealed.length);
    should(sealed).eql([...sealed].sort((left, right) => left - right));
    // And the receive counter tracked too: a rewind there refuses the next arrival with `4420`,
    // which six rounds would have hit.
    should(session.live()).be.true();
  });
});
