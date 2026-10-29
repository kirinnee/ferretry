import { describe, it } from 'bun:test';
import should from 'should';
import {
  HOSTED_CONTROL_OUTAGE_GRACE_MS,
  HOSTED_RESERVATION_RENEW_MS,
  HostedRelayControlDurableObject,
  type RelayEnvironment,
  type RelayRuntime,
  RendezvousDurableObject,
  relayFetch,
  workersRuntime,
} from '../../src/adapters/index.ts';
import {
  type ControlMessage,
  claimContextForChallenge,
  DEFAULT_HOSTED_RELAY_LIMITS,
  decodeControlMessage,
  encodeClaim,
  encodeControlMessage,
  encodeCreditPayload,
  encodeFrame,
  FRAME_KINDS,
  fromBase64UrlFixed,
  HEARTBEAT_GRACE_SECONDS,
  HOSTED_RELAY_RESERVATION_HANDOFF_GRACE_MILLISECONDS,
  initialRendezvousState,
  NONCE_BYTES,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type RelayFrame,
  type RendezvousState,
  type SessionId,
  sessionIdFromBytes,
  signRendezvousClaim,
} from '../../src/lib/index.ts';
import { FakeHostedRelayControlStorage } from '../support/hosted-control-fakes.ts';
import { newDaemonIdentity, relayCrypto, stubbedCrypto } from '../support/identities.ts';
import { FakeObjectState, FakeSocket, testRuntime } from '../support/workers-fakes.ts';

const host = 'relay.example';

const environment: RelayEnvironment = {
  RENDEZVOUS: { idFromName: name => name, get: () => ({ fetch: async () => new Response(null) }) },
};

function makeObject(overrides: Partial<RelayRuntime> = {}, relayEnvironment: RelayEnvironment = environment) {
  const objectState = new FakeObjectState();
  const runtime = testRuntime(overrides);
  return {
    objectState,
    runtime,
    object: new RendezvousDurableObject(objectState, relayEnvironment, runtime),
  };
}

function socketRequest(daemonId: string, role: 'daemon' | 'client', reservationId?: string, query = ''): Request {
  return new Request(`https://${host}/v1/rendezvous/${daemonId}/${role}${query}`, {
    headers: {
      Upgrade: 'websocket',
      ...(reservationId === undefined ? {} : { 'x-ferretry-relay-reservation': reservationId }),
    },
  });
}

function controlOf(frame: RelayFrame | undefined): ControlMessage | null {
  return frame === undefined ? null : decodeControlMessage(frame.payload);
}

function bytesOf(frame: RelayFrame): ArrayBuffer {
  const encoded = encodeFrame(frame);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

/** Bring a real daemon all the way through the claim, exactly as a daemon would. */
async function claimRendezvous(harness: ReturnType<typeof makeObject>, reservationId?: string, query = '') {
  const identity = await newDaemonIdentity();
  const before = harness.objectState.sockets.length;
  await harness.object.fetch(socketRequest(identity.daemonId, 'daemon', reservationId, query));
  const daemonSocket = harness.objectState.sockets[before];
  if (daemonSocket === undefined) throw new Error('the daemon socket was never accepted');

  const challengeMessage = controlOf(daemonSocket.drain()[0]);
  if (challengeMessage?.t !== 'challenge') throw new Error('expected a challenge');
  const challenge = fromBase64UrlFixed(challengeMessage.nonce, NONCE_BYTES);
  if (challenge === null) throw new Error('challenge nonce is malformed');

  const context = claimContextForChallenge(identity.daemonId, host, challengeMessage.host, challenge);
  if (context === null) throw new Error('the daemon refused the host it was challenged for');
  const claim = encodeClaim(await signRendezvousClaim(relayCrypto, identity, context));

  await harness.object.webSocketMessage(
    daemonSocket,
    bytesOf({
      kind: FRAME_KINDS.control,
      sessionId: RENDEZVOUS_SESSION_ID,
      sequence: 0,
      payload: encodeControlMessage({ t: 'claim', protocol: RELAY_PROTOCOL_ID, ...claim }),
    }),
  );
  return { identity, daemonSocket };
}

async function joinClient(harness: ReturnType<typeof makeObject>, daemonId: string, reservationId?: string) {
  const before = harness.objectState.sockets.length;
  await harness.object.fetch(socketRequest(daemonId, 'client', reservationId));
  const clientSocket = harness.objectState.sockets[before];
  if (clientSocket === undefined) throw new Error('the client socket was never accepted');
  const ready = clientSocket.drain()[0];
  if (ready === undefined) throw new Error('the client was never told it was ready');
  return { clientSocket, sessionId: ready.sessionId, ready: controlOf(ready) };
}

describe('rendezvous durable object', () => {
  it('should let the runtime answer heartbeats so an idle rendezvous stays asleep', () => {
    const { objectState } = makeObject();
    should(objectState.autoResponse).equal('heartbeat');
  });

  it('should refuse a request that is not a rendezvous route', async () => {
    const { object } = makeObject();
    const response = await object.fetch(new Request('https://relay.example/health'));
    should(response.status).equal(404);
  });

  it('should challenge a daemon and hand it the slot once it proves itself', async () => {
    const harness = makeObject();
    const { daemonSocket } = await claimRendezvous(harness);
    should(controlOf(daemonSocket.drain()[0])).match({ t: 'claimed' });
    should(harness.objectState.storage.alarms.length).be.above(0);
  });

  it('should refuse a claim that does not verify', async () => {
    const harness = makeObject();
    const identity = await newDaemonIdentity();
    await harness.object.fetch(socketRequest(identity.daemonId, 'daemon'));
    const daemonSocket = harness.objectState.sockets[0];
    if (daemonSocket === undefined) throw new Error('no socket');
    daemonSocket.drain();

    await harness.object.webSocketMessage(
      daemonSocket,
      bytesOf({
        kind: FRAME_KINDS.control,
        sessionId: RENDEZVOUS_SESSION_ID,
        sequence: 0,
        payload: encodeControlMessage({
          t: 'claim',
          protocol: RELAY_PROTOCOL_ID,
          publicKey: 'A'.repeat(59),
          signature: 'B'.repeat(86),
        }),
      }),
    );
    should(daemonSocket.closed?.code).equal(RELAY_CLOSE_CODES.claimRejected);
  });

  it('should refuse a claim whose fields are not decodable at all', async () => {
    const harness = makeObject();
    const identity = await newDaemonIdentity();
    await harness.object.fetch(socketRequest(identity.daemonId, 'daemon'));
    const daemonSocket = harness.objectState.sockets[0];
    if (daemonSocket === undefined) throw new Error('no socket');
    daemonSocket.drain();

    const payload = encodeControlMessage({
      t: 'claim',
      protocol: RELAY_PROTOCOL_ID,
      publicKey: 'A'.repeat(59),
      signature: 'B'.repeat(86),
    });
    // Break the encoding after it passed the schema, which is the only way the decoder can fail.
    const broken = new TextEncoder().encode(
      new TextDecoder().decode(payload).replace(`"publicKey":"${'A'.repeat(59)}"`, `"publicKey":"${'-'.repeat(59)}"`),
    );
    await harness.object.webSocketMessage(
      daemonSocket,
      bytesOf({ kind: FRAME_KINDS.control, sessionId: RENDEZVOUS_SESSION_ID, sequence: 0, payload: broken }),
    );
    should(daemonSocket.closed?.code).equal(RELAY_CLOSE_CODES.claimRejected);
  });

  it('should open a client session and tell both ends', async () => {
    const harness = makeObject();
    const { identity, daemonSocket } = await claimRendezvous(harness);
    daemonSocket.drain();
    const { ready, sessionId } = await joinClient(harness, identity.daemonId);
    should(ready).match({ t: 'ready' });
    should(controlOf(daemonSocket.drain()[0])).match({ t: 'open' });
    should(sessionId.text).not.equal(RENDEZVOUS_SESSION_ID.text);
  });

  it('should carry a record between two sockets without decoding it', async () => {
    const harness = makeObject();
    const { identity, daemonSocket } = await claimRendezvous(harness);
    daemonSocket.drain();
    const { clientSocket, sessionId } = await joinClient(harness, identity.daemonId);
    daemonSocket.drain();

    const record: RelayFrame = { kind: FRAME_KINDS.data, sessionId, sequence: 1, payload: new Uint8Array([9, 9]) };
    await harness.object.webSocketMessage(clientSocket, bytesOf(record));
    should(daemonSocket.drain()).deepEqual([record]);

    const back: RelayFrame = { kind: FRAME_KINDS.data, sessionId, sequence: 1, payload: new Uint8Array([8]) };
    await harness.object.webSocketMessage(daemonSocket, bytesOf(back));
    should(clientSocket.drain()).deepEqual([back]);
  });

  it('should not hold a relayed frame behind a confirmed write, and still confirm what admits a session', async () => {
    // On Cloudflare a message sent after an ordinary write waits until that write is durable. Every
    // relayed frame moves a credit window, so every keystroke used to wait for one. A frame's write is
    // made `allowUnconfirmed`; a claim and a session open are not.
    const harness = makeObject();
    const { identity, daemonSocket } = await claimRendezvous(harness);
    const claimWrites = [...harness.objectState.storage.writes];
    daemonSocket.drain();
    const { clientSocket, sessionId } = await joinClient(harness, identity.daemonId);
    const openWrites = harness.objectState.storage.writes.slice(claimWrites.length);
    daemonSocket.drain();
    harness.objectState.storage.writes.length = 0;

    await harness.object.webSocketMessage(
      clientSocket,
      bytesOf({ kind: FRAME_KINDS.data, sessionId, sequence: 1, payload: new Uint8Array([7]) }),
    );
    await harness.object.webSocketMessage(
      daemonSocket,
      bytesOf({ kind: FRAME_KINDS.credit, sessionId, sequence: 0, payload: encodeCreditPayload(1) }),
    );

    should(claimWrites.some(write => !write.unconfirmed)).be.true();
    should(openWrites.length).be.above(0);
    should(openWrites.every(write => !write.unconfirmed)).be.true();
    should(harness.objectState.storage.writes).deepEqual([
      { key: 'rendezvous', unconfirmed: true },
      { key: 'rendezvous', unconfirmed: true },
    ]);
    should(daemonSocket.drain()).have.length(1);
    should(clientSocket.drain()).have.length(1);
  });

  it('should close a socket that speaks text, or sends something that is not a frame', async () => {
    const harness = makeObject();
    const { identity } = await claimRendezvous(harness);
    const { clientSocket } = await joinClient(harness, identity.daemonId);

    await harness.object.webSocketMessage(clientSocket, 'hello?');
    should(clientSocket.closed?.reason).match(/binary frames/u);

    const other = new FakeSocket();
    other.serializeAttachment({ socketId: 'unknown' });
    await harness.object.webSocketMessage(other, new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
    should(other.closed?.code).equal(RELAY_CLOSE_CODES.protocolError);
  });

  it('should close a socket it has no record of ever accepting', async () => {
    const { object } = makeObject();
    const stranger = new FakeSocket();
    await object.webSocketMessage(stranger, new ArrayBuffer(0));
    should(stranger.closed?.code).equal(RELAY_CLOSE_CODES.relayInternal);
  });

  it('should refuse to serve a socket when its own state is gone', async () => {
    const harness = makeObject();
    const { identity } = await claimRendezvous(harness);
    const { clientSocket, sessionId } = await joinClient(harness, identity.daemonId);
    harness.objectState.storage.values.clear();

    await harness.object.webSocketMessage(
      clientSocket,
      bytesOf({ kind: FRAME_KINDS.data, sessionId, sequence: 1, payload: new Uint8Array(1) }),
    );
    should(clientSocket.closed?.code).equal(RELAY_CLOSE_CODES.relayInternal);
  });

  it('should treat a closed or failed socket as a departure, and ignore an unknown one', async () => {
    const harness = makeObject();
    const { identity, daemonSocket } = await claimRendezvous(harness);
    const { clientSocket } = await joinClient(harness, identity.daemonId);
    daemonSocket.drain();

    await harness.object.webSocketClose(clientSocket);
    should(controlOf(daemonSocket.drain()[0])).match({ t: 'closed' });

    await harness.object.webSocketError(daemonSocket);
    const stored = harness.objectState.storage.values.get('rendezvous') as { daemon: unknown } | undefined;
    should(stored?.daemon).be.null();

    const stranger = new FakeSocket();
    await harness.object.webSocketClose(stranger);
    should(stranger.closed).be.null();
  });

  it('should do nothing on an alarm for a rendezvous that never started', async () => {
    const harness = makeObject();
    await harness.object.alarm();
    should(harness.objectState.storage.alarms).deepEqual([]);
  });

  it('should sweep on the evidence the runtime actually has', async () => {
    const harness = makeObject();
    const { identity, daemonSocket } = await claimRendezvous(harness);
    const { clientSocket } = await joinClient(harness, identity.daemonId);
    daemonSocket.drain();

    // One socket answered a heartbeat recently, one never has, and one is not ours at all.
    harness.runtime.clock += HEARTBEAT_GRACE_SECONDS * 1_000 + 1;
    harness.objectState.lastSeen.set(daemonSocket, new Date(harness.runtime.clock));
    harness.objectState.sockets.push(new FakeSocket());

    await harness.object.alarm();
    should(clientSocket.closed?.code).equal(RELAY_CLOSE_CODES.heartbeatTimeout);
    should(daemonSocket.closed).be.null();
  });

  it('should refuse to mint a session identifier of the wrong width', async () => {
    const harness = makeObject({
      crypto: stubbedCrypto({ randomBytes: length => new Uint8Array(length === 16 ? 15 : length) }),
    });
    const daemonId = `fy_daemon_${'a'.repeat(43)}`;
    await should(harness.object.fetch(socketRequest(daemonId, 'client'))).be.rejectedWith(/wrong length/u);
  });
});

describe('hosted rendezvous enforcement', () => {
  /** Which reservations were actually handed back, in the order the rendezvous gave them up. */
  function releasedBy(calls: readonly { path: string; input: unknown }[]): readonly string[] {
    return calls
      .filter(call => call.path === '/internal/release')
      .map(call => (call.input as { reservationId?: string }).reservationId ?? '');
  }

  /** Stand up a rendezvous holding one live session for `socketId`, and return a frame it may send. */
  /** The daemon a hand-written state names has to be a socket the runtime holds, or it is not there. */
  function attachDaemon(harness: ReturnType<typeof makeObject>): FakeSocket {
    const daemon = new FakeSocket();
    daemon.serializeAttachment({ socketId: 'daemon' });
    harness.objectState.sockets.push(daemon);
    return daemon;
  }

  function liveSessionFrame(harness: ReturnType<typeof makeObject>, socketId: string): ArrayBuffer {
    const sessionId = sessionIdFromBytes(new Uint8Array(16).fill(1));
    if (sessionId === null) throw new Error('session fixture is invalid');
    attachDaemon(harness);
    harness.objectState.storage.values.set('rendezvous', {
      ...initialRendezvousState(`fy_daemon_${'a'.repeat(43)}`),
      daemon: { socketId: 'daemon', since: 1 },
      sessions: [
        {
          sessionId,
          clientSocketId: socketId,
          since: 1,
          fromClient: { allowed: 1, sent: 0 },
          fromDaemon: { allowed: 1, sent: 0 },
        },
      ],
    });
    return bytesOf({ kind: FRAME_KINDS.data, sessionId, sequence: 1, payload: new Uint8Array([1]) });
  }

  function hostedEnvironment(answer: (path: string, input: unknown) => unknown = () => ({ ok: true })): {
    readonly environment: RelayEnvironment;
    readonly calls: { path: string; input: unknown }[];
  } {
    const calls: { path: string; input: unknown }[] = [];
    return {
      calls,
      environment: {
        RELAY_MODE: 'hosted',
        RELAY_CONTROL: {
          idFromName: name => name,
          get: () => ({
            fetch: async request => {
              const path = new URL(request.url).pathname;
              const input = request.method === 'POST' ? await request.json() : null;
              calls.push({ path, input });
              return Response.json(answer(path, input));
            },
          }),
        },
        RENDEZVOUS: environment.RENDEZVOUS,
      },
    };
  }

  it('should require the Worker-minted reservation header', async () => {
    const hosted = hostedEnvironment();
    const harness = makeObject({}, hosted.environment);
    should((await harness.object.fetch(socketRequest(`fy_daemon_${'a'.repeat(43)}`, 'client'))).status).equal(403);
    should(harness.objectState.sockets).deepEqual([]);
  });

  it('should meter only opaque bytes the state machine will actually forward', async () => {
    const hosted = hostedEnvironment();
    const harness = makeObject({}, hosted.environment);
    const { identity, daemonSocket } = await claimRendezvous(harness, 'daemon_reservation');
    daemonSocket.drain();
    const { clientSocket, sessionId } = await joinClient(harness, identity.daemonId, 'client_reservation');
    daemonSocket.drain();

    const frame: RelayFrame = {
      kind: FRAME_KINDS.data,
      sessionId,
      sequence: 1,
      payload: new Uint8Array([1, 2, 3]),
    };
    const encoded = bytesOf(frame);
    await harness.object.webSocketMessage(clientSocket, encoded);
    // Forwarded BEFORE it is metered: the meter is never on a frame's path (§13).
    should(daemonSocket.drain()).deepEqual([frame]);
    await harness.object.metered();
    const meterCalls = hosted.calls.filter(call => call.path === '/internal/meter');
    should(meterCalls.at(-1)?.input).deepEqual({ daemonId: identity.daemonId, bytes: encoded.byteLength });
    should(meterCalls.some(call => (call.input as { bytes?: number }).bytes === 0)).be.true();
  });

  it('should forward every frame at once and report them in one batch while a report is in flight', async () => {
    // The meter lives in ONE global object, often an ocean away. Holding each frame for its answer made
    // a rendezvous forward at one frame per control round trip; the report now trails the traffic.
    // Arrange — a control object that answers the first report only when the test says so.
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let meterCalls = 0;
    let armed = false;
    const hosted = hostedEnvironment();
    const inner = hosted.environment.RELAY_CONTROL;
    if (inner === undefined) throw new Error('hosted fixture has no control object');
    const environment: RelayEnvironment = {
      ...hosted.environment,
      RELAY_CONTROL: {
        idFromName: name => inner.idFromName(name),
        get: id => ({
          fetch: async request => {
            if (new URL(request.url).pathname === '/internal/meter') {
              meterCalls += 1;
              if (armed && meterCalls === 1) await firstHeld;
            }
            return inner.get(id).fetch(request);
          },
        }),
      },
    };
    const harness = makeObject({}, environment);
    const { identity, daemonSocket } = await claimRendezvous(harness, 'daemon_reservation');
    const { clientSocket, sessionId } = await joinClient(harness, identity.daemonId, 'client_reservation');
    await harness.object.metered();
    daemonSocket.drain();
    hosted.calls.length = 0;
    meterCalls = 0;
    armed = true;
    const frames = [1, 2, 3].map(sequence =>
      bytesOf({ kind: FRAME_KINDS.data, sessionId, sequence, payload: new Uint8Array(sequence) }),
    );

    // Act
    for (const frame of frames) await harness.object.webSocketMessage(clientSocket, frame);
    const forwardedBeforeAnyAnswer = daemonSocket.drain().length;
    releaseFirst();
    await harness.object.metered();

    // Assert
    should(forwardedBeforeAnyAnswer).equal(3);
    should(hosted.calls.filter(call => call.path === '/internal/meter').map(call => call.input)).deepEqual([
      { daemonId: identity.daemonId, bytes: frames[0]?.byteLength },
      { daemonId: identity.daemonId, bytes: (frames[1]?.byteLength ?? 0) + (frames[2]?.byteLength ?? 0), events: 2 },
    ]);
  });

  it('should send a control refusal before closing when metering denies', async () => {
    const hosted = hostedEnvironment(() => ({
      ok: false,
      code: RELAY_CLOSE_CODES.hostedBandwidth,
      reason: 'daily cap reached',
    }));
    const harness = makeObject({}, hosted.environment);
    const client = new FakeSocket();
    client.serializeAttachment({ socketId: 'client', reservationId: 'client_reservation' });
    harness.objectState.sockets.push(client);
    await harness.object.webSocketMessage(client, liveSessionFrame(harness, 'client'));
    await harness.object.metered();
    should(controlOf(client.frames()[0])).match({ t: 'error', code: RELAY_CLOSE_CODES.hostedBandwidth });
    should(client.closed?.code).equal(RELAY_CLOSE_CODES.hostedBandwidth);
    // A refusal that closes the socket and keeps the slot spends it for the deployment's lifetime.
    should(releasedBy(hosted.calls)).containEql('client_reservation');
  });

  it('should answer a claim probe without reporting it to the hosted meter', async () => {
    const hosted = hostedEnvironment();
    const harness = makeObject({}, hosted.environment);
    const { daemonSocket } = await claimRendezvous(harness, 'daemon_reservation', '?features=claim-probe');
    await harness.object.metered();
    daemonSocket.drain();
    hosted.calls.length = 0;

    await harness.object.webSocketMessage(
      daemonSocket,
      bytesOf({
        kind: FRAME_KINDS.control,
        sessionId: RENDEZVOUS_SESSION_ID,
        sequence: 0,
        payload: encodeControlMessage({ t: 'probe' }),
      }),
    );
    await harness.object.metered();

    should(daemonSocket.drain().map(controlOf)).deepEqual([{ t: 'held' }]);
    should(hosted.calls.filter(call => call.path === '/internal/meter')).be.empty();
  });

  it('should not write anything for a probe, which changes nothing it stores', async () => {
    // A write that changed nothing would still close the output gate in front of the `held` answer.
    const harness = makeObject();
    const { daemonSocket } = await claimRendezvous(harness, undefined, '?features=claim-probe');
    daemonSocket.drain();
    harness.objectState.storage.writes.length = 0;

    await harness.object.webSocketMessage(
      daemonSocket,
      bytesOf({
        kind: FRAME_KINDS.control,
        sessionId: RENDEZVOUS_SESSION_ID,
        sequence: 0,
        payload: encodeControlMessage({ t: 'probe' }),
      }),
    );

    should(daemonSocket.drain().map(controlOf)).deepEqual([{ t: 'held' }]);
    should(harness.objectState.storage.writes).deepEqual([]);
  });

  it('should carry live sessions through a meter outage, re-report the bytes, and fail closed only past the grace', async () => {
    // An unreachable control object is not a refusal: one blip used to close every socket on the
    // rendezvous — the daemon's and every phone's — with no deploy and no ceiling anywhere.
    let reachable = false;
    const hosted = hostedEnvironment(() => (reachable ? { ok: true } : { invalid: true }));
    const harness = makeObject({}, hosted.environment);
    attachDaemon(harness);
    const client = new FakeSocket();
    client.serializeAttachment({ socketId: 'client', reservationId: 'client_reservation' });
    harness.objectState.sockets.push(client);
    const sessionId = sessionIdFromBytes(new Uint8Array(16).fill(1));
    if (sessionId === null) throw new Error('session fixture is invalid');
    harness.objectState.storage.values.set('rendezvous', {
      ...initialRendezvousState(`fy_daemon_${'a'.repeat(43)}`),
      daemon: { socketId: 'daemon', since: 1 },
      sessions: [
        {
          sessionId,
          clientSocketId: 'client',
          since: 1,
          fromClient: { allowed: 32, sent: 0 },
          fromDaemon: { allowed: 32, sent: 0 },
        },
      ],
    });
    let sequence = 0;
    const send = async (): Promise<number> => {
      sequence += 1;
      const frame = bytesOf({ kind: FRAME_KINDS.data, sessionId, sequence, payload: new Uint8Array([1]) });
      await harness.object.webSocketMessage(client, frame);
      await harness.object.metered();
      return frame.byteLength;
    };
    const meterCalls = () => hosted.calls.filter(call => call.path === '/internal/meter');

    const first = await send();
    should(client.closed).be.null();
    // Asked twice — once more when the answer is unusable, as §13 does — and then not again in a loop.
    should(meterCalls()).have.length(2);

    harness.runtime.clock += HOSTED_CONTROL_OUTAGE_GRACE_MS - 1;
    const second = await send();
    should(client.closed).be.null();

    reachable = true;
    const third = await send();
    // Nothing forwarded during the outage went uncounted: it is folded into the first report that lands.
    should(meterCalls().at(-1)?.input).match({ bytes: first + second + third, events: 3 });

    // An answer ended the outage, so a new one gets a whole window of its own …
    reachable = false;
    await send();
    should(client.closed).be.null();
    // … and an outage that outlasts it fails closed, told why first, slot returned.
    harness.runtime.clock += HOSTED_CONTROL_OUTAGE_GRACE_MS;
    await send();
    should(controlOf(client.frames().at(-1))).match({ t: 'error', code: RELAY_CLOSE_CODES.relayInternal });
    should(client.closed?.code).equal(RELAY_CLOSE_CODES.relayInternal);
    should(releasedBy(hosted.calls)).containEql('client_reservation');
  });

  it('should keep sweeping heartbeats while inspection is unreachable, and refuse only past the grace', async () => {
    let reachable = true;
    const hosted = hostedEnvironment(() => (reachable ? { ok: true } : { invalid: true }));
    const harness = makeObject({}, hosted.environment);
    const { identity, daemonSocket } = await claimRendezvous(harness, 'daemon_reservation');
    const { clientSocket } = await joinClient(harness, identity.daemonId, 'client_reservation');
    daemonSocket.drain();
    reachable = false;

    // The outage starts: the daemon is still answering, the client has gone quiet. The sweep must still
    // evict the quiet one — skipping it would let dead sockets outlive the outage — and keep the daemon.
    harness.runtime.clock += HEARTBEAT_GRACE_SECONDS * 1_000 + 1;
    harness.objectState.lastSeen.set(daemonSocket, new Date(harness.runtime.clock));
    await harness.object.alarm();
    should(clientSocket.closed?.code).equal(RELAY_CLOSE_CODES.heartbeatTimeout);
    should(daemonSocket.closed).be.null();

    harness.runtime.clock += HOSTED_CONTROL_OUTAGE_GRACE_MS;
    harness.objectState.lastSeen.set(daemonSocket, new Date(harness.runtime.clock));
    await harness.object.alarm();
    should(controlOf(daemonSocket.frames().at(-1))).match({ t: 'error', code: RELAY_CLOSE_CODES.relayInternal });
    should(daemonSocket.closed?.code).equal(RELAY_CLOSE_CODES.relayInternal);
  });

  it('should release the reservation when the state machine refuses an arriving socket', async () => {
    const hosted = hostedEnvironment();
    const harness = makeObject({}, hosted.environment);
    await harness.object.fetch(socketRequest(`fy_daemon_${'a'.repeat(43)}`, 'client', 'lonely_reservation'));
    const refused = harness.objectState.sockets.at(-1);
    should(controlOf(refused?.frames()[0])).match({ t: 'error', code: RELAY_CLOSE_CODES.daemonAbsent });
    should(refused?.closed?.code).equal(RELAY_CLOSE_CODES.daemonAbsent);
    should(releasedBy(hosted.calls)).deepEqual(['lonely_reservation']);
  });

  it('should release the reservation when the heartbeat sweep evicts a socket', async () => {
    const hosted = hostedEnvironment();
    const harness = makeObject({}, hosted.environment);
    const { identity, daemonSocket } = await claimRendezvous(harness, 'daemon_reservation');
    const { clientSocket } = await joinClient(harness, identity.daemonId, 'client_reservation');
    daemonSocket.drain();

    harness.runtime.clock += HEARTBEAT_GRACE_SECONDS * 1_000 + 1;
    harness.objectState.lastSeen.set(daemonSocket, new Date(harness.runtime.clock));
    await harness.object.alarm();

    should(clientSocket.closed?.code).equal(RELAY_CLOSE_CODES.heartbeatTimeout);
    should(daemonSocket.closed).be.null();
    // Only the evicted socket's slot goes back; the daemon that is still answering keeps its own.
    should(releasedBy(hosted.calls)).deepEqual(['client_reservation']);
  });

  it('should release the reservation on a protocol refusal but never invent one for a stray socket', async () => {
    const hosted = hostedEnvironment();
    const harness = makeObject({}, hosted.environment);
    const attached = new FakeSocket();
    attached.serializeAttachment({ socketId: 'talker', reservationId: 'talker_reservation' });
    await harness.object.webSocketMessage(attached, 'fy-ping is the only text this carries');
    should(attached.closed?.code).equal(RELAY_CLOSE_CODES.protocolError);

    const garbled = new FakeSocket();
    garbled.serializeAttachment({ socketId: 'garbled', reservationId: 'garbled_reservation' });
    await harness.object.webSocketMessage(garbled, new Uint8Array([0, 1, 2]).buffer as ArrayBuffer);
    should(garbled.closed?.code).equal(RELAY_CLOSE_CODES.protocolError);
    should(releasedBy(hosted.calls)).deepEqual(['talker_reservation', 'garbled_reservation']);

    const stray = new FakeSocket();
    await harness.object.webSocketMessage(stray, 'anything');
    should(stray.closed?.code).equal(RELAY_CLOSE_CODES.relayInternal);
    should(releasedBy(hosted.calls)).deepEqual(['talker_reservation', 'garbled_reservation']);
  });

  it('should hand the reservation back even when the socket cannot be explained to or closed', async () => {
    /** A socket the runtime has already torn down: it throws instead of accepting either call. */
    class BrokenSocket extends FakeSocket {
      constructor(private readonly failing: 'send' | 'close') {
        super();
      }

      override send(data: ArrayBuffer | string): void {
        if (this.failing === 'send') throw new Error('socket is already gone');
        super.send(data);
      }

      override close(code?: number, reason?: string): void {
        if (this.failing === 'close') throw new Error('socket is already gone');
        super.close(code, reason);
      }
    }

    const denied = (path: string) =>
      path === '/internal/meter'
        ? { ok: false, code: RELAY_CLOSE_CODES.hostedBandwidth, reason: 'daily cap reached' }
        : { ok: true };

    const mute = hostedEnvironment(denied);
    const muteHarness = makeObject({}, mute.environment);
    const unsendable = new BrokenSocket('send');
    unsendable.serializeAttachment({ socketId: 'mute', reservationId: 'mute_reservation' });
    muteHarness.objectState.sockets.push(unsendable);
    await muteHarness.object.webSocketMessage(unsendable, liveSessionFrame(muteHarness, 'mute'));
    await muteHarness.object.metered();
    // The explanation was undeliverable, so the close and the release carried on without it.
    should(unsendable.closed?.code).equal(RELAY_CLOSE_CODES.hostedBandwidth);
    should(releasedBy(mute.calls)).deepEqual(['mute_reservation']);

    const stuck = hostedEnvironment(denied);
    const stuckHarness = makeObject({}, stuck.environment);
    const unclosable = new BrokenSocket('close');
    unclosable.serializeAttachment({ socketId: 'stuck', reservationId: 'stuck_reservation' });
    stuckHarness.objectState.sockets.push(unclosable);
    const loud: unknown[] = [];
    const quiet = console.error;
    console.error = (...line: unknown[]) => loud.push(line);
    try {
      await stuckHarness.object.webSocketMessage(unclosable, liveSessionFrame(stuckHarness, 'stuck'));
      await stuckHarness.object.metered();
    } finally {
      console.error = quiet;
    }
    // A close that fails is loud, but the slot is already back before anyone hears about it.
    should(String(loud.flat().join(' '))).match(/already gone/u);
    should(releasedBy(stuck.calls)).deepEqual(['stuck_reservation']);
  });

  it('should release a departing socket even when telling its dead peer fails', async () => {
    class DeadPeer extends FakeSocket {
      override send(): void {
        throw new Error('socket is already gone');
      }
    }

    const sessionId = sessionIdFromBytes(new Uint8Array(16).fill(1));
    if (sessionId === null) throw new Error('session fixture is invalid');
    for (const departing of ['client', 'daemon'] as const) {
      const hosted = hostedEnvironment();
      const harness = makeObject({}, hosted.environment);
      const daemon = departing === 'client' ? new DeadPeer() : new FakeSocket();
      const client = departing === 'daemon' ? new DeadPeer() : new FakeSocket();
      daemon.serializeAttachment({ socketId: 'daemon', reservationId: 'daemon_reservation' });
      client.serializeAttachment({ socketId: 'client', reservationId: 'client_reservation' });
      harness.objectState.sockets.push(daemon, client);
      harness.objectState.storage.values.set('rendezvous', {
        ...initialRendezvousState(`fy_daemon_${'a'.repeat(43)}`),
        daemon: { socketId: 'daemon', since: 1 },
        sessions: [
          {
            sessionId,
            clientSocketId: 'client',
            since: 1,
            fromClient: { allowed: 1, sent: 0 },
            fromDaemon: { allowed: 1, sent: 0 },
          },
        ],
      });

      await should(
        departing === 'client' ? harness.object.webSocketClose(client) : harness.object.webSocketError(daemon),
      ).be.rejectedWith(/already gone/u);
      should(releasedBy(hosted.calls)).containEql(`${departing}_reservation`);
    }
  });

  it('should apply a failed sweep to every socket and keep the next sweep armed', async () => {
    class UnclosableSocket extends FakeSocket {
      override close(): void {
        throw new Error('socket is already gone');
      }
    }

    const hosted = hostedEnvironment(path =>
      path === '/internal/inspect'
        ? { ok: false, code: RELAY_CLOSE_CODES.hostedDisabled, reason: 'hosted relay is disabled' }
        : { ok: true },
    );
    let created = 0;
    const harness = makeObject(
      {
        createSocketPair: () => ({
          client: new FakeSocket(),
          server: created++ === 0 ? new UnclosableSocket() : new FakeSocket(),
        }),
      },
      hosted.environment,
    );
    const { identity } = await claimRendezvous(harness, 'daemon_reservation');
    const one = await joinClient(harness, identity.daemonId, 'client_one_reservation');
    const two = await joinClient(harness, identity.daemonId, 'client_two_reservation');
    const alarmsBefore = harness.objectState.storage.alarms.length;

    await should(harness.object.alarm()).be.rejectedWith(/already gone/u);

    should(releasedBy(hosted.calls)).deepEqual([
      'daemon_reservation',
      'client_one_reservation',
      'client_two_reservation',
    ]);
    should(one.clientSocket.closed?.code).equal(RELAY_CLOSE_CODES.hostedDisabled);
    should(two.clientSocket.closed?.code).equal(RELAY_CLOSE_CODES.hostedDisabled);
    should(harness.objectState.storage.alarms.length).be.above(alarmsBefore);
  });

  it('should refuse every socket and still report an alarm that could not be re-armed after the kill switch', async () => {
    const hosted = hostedEnvironment(path =>
      path === '/internal/inspect'
        ? { ok: false, code: RELAY_CLOSE_CODES.hostedDisabled, reason: 'hosted relay is disabled' }
        : { ok: true },
    );
    const harness = makeObject({}, hosted.environment);
    const { daemonSocket } = await claimRendezvous(harness, 'daemon_reservation');
    daemonSocket.drain();
    harness.objectState.storage.setAlarm = async () => {
      throw new Error('alarm storage is down');
    };

    await should(harness.object.alarm()).be.rejectedWith(/alarm storage is down/u);

    should(daemonSocket.closed?.code).equal(RELAY_CLOSE_CODES.hostedDisabled);
    should(releasedBy(hosted.calls)).deepEqual(['daemon_reservation']);
  });

  it('should still apply a departure when the runtime refuses to rewrite the departing socket', async () => {
    // A socket the runtime already tore down rejects serializeAttachment; it holds nothing to mark.
    const hosted = hostedEnvironment();
    const harness = makeObject({}, hosted.environment);
    const { daemonSocket } = await claimRendezvous(harness, 'daemon_reservation', '?features=claim-probe');
    daemonSocket.serializeAttachment = () => {
      throw new Error('socket is already gone');
    };

    await harness.object.webSocketClose(daemonSocket);

    should(releasedBy(hosted.calls)).deepEqual(['daemon_reservation']);
    const stored = harness.objectState.storage.values.get('rendezvous') as RendezvousState;
    should(stored.daemon).be.null();
  });

  it('should still close and release when a state-machine refusal cannot be explained', async () => {
    // The reducer refuses with two effects, "say why" then "close", and the close is the one that
    // gives the slot back. An undeliverable explanation must not abandon the rest of the transition.
    class MuteSocket extends FakeSocket {
      override send(): void {
        throw new Error('socket is already gone');
      }
    }

    const hosted = hostedEnvironment();
    const harness = makeObject(
      { createSocketPair: () => ({ client: new FakeSocket(), server: new MuteSocket() }) },
      hosted.environment,
    );

    // A client arriving at a rendezvous no daemon holds: refused by the state machine, not the meter.
    await should(
      harness.object.fetch(socketRequest(`fy_daemon_${'a'.repeat(43)}`, 'client', 'mute_reservation')),
    ).be.rejectedWith(/already gone/u);
    should(harness.objectState.sockets.at(-1)?.closed?.code).equal(RELAY_CLOSE_CODES.daemonAbsent);
    should(releasedBy(hosted.calls)).deepEqual(['mute_reservation']);
  });

  it('should leave self-hosted refusals free of any control-plane traffic', async () => {
    const harness = makeObject();
    await harness.object.fetch(socketRequest(`fy_daemon_${'a'.repeat(43)}`, 'client'));
    const refused = harness.objectState.sockets.at(-1);
    should(refused?.closed?.code).equal(RELAY_CLOSE_CODES.daemonAbsent);
  });

  it('should apply the runtime kill switch to live sockets on the next sweep and release their reservations', async () => {
    const hosted = hostedEnvironment(path =>
      path === '/internal/inspect'
        ? { ok: false, code: RELAY_CLOSE_CODES.hostedDisabled, reason: 'hosted relay is disabled' }
        : { ok: true },
    );
    const harness = makeObject({}, hosted.environment);
    const { daemonSocket } = await claimRendezvous(harness, 'daemon_reservation');
    daemonSocket.drain();

    await harness.object.alarm();
    should(controlOf(daemonSocket.frames()[0])).match({ t: 'error', code: RELAY_CLOSE_CODES.hostedDisabled });
    should(daemonSocket.closed?.code).equal(RELAY_CLOSE_CODES.hostedDisabled);
    should(hosted.calls.map(call => call.path)).containEql('/internal/release');
  });

  it('should release a reservation on close and fail closed when stored tenancy is lost or crossed', async () => {
    const hosted = hostedEnvironment();
    const harness = makeObject({}, hosted.environment);
    const daemonId = `fy_daemon_${'a'.repeat(43)}`;
    const socket = new FakeSocket();
    socket.serializeAttachment({ socketId: 'old', reservationId: 'old_reservation' });
    harness.objectState.sockets.push(socket);

    await harness.object.fetch(socketRequest(daemonId, 'client', 'new_reservation'));
    const refused = harness.objectState.sockets.at(-1);
    should(controlOf(refused?.frames()[0])).match({ t: 'error', code: RELAY_CLOSE_CODES.relayInternal });
    should(hosted.calls.map(call => call.path)).containEql('/internal/release');

    harness.objectState.sockets.length = 0;
    harness.objectState.storage.values.set('rendezvous', initialRendezvousState(`fy_daemon_${'b'.repeat(43)}`));
    await harness.object.fetch(socketRequest(daemonId, 'client', 'crossed_reservation'));
    should(controlOf(harness.objectState.sockets.at(-1)?.frames()[0])).match({
      t: 'error',
      code: RELAY_CLOSE_CODES.relayInternal,
    });

    const closing = new FakeSocket();
    closing.serializeAttachment({ socketId: 'closing', reservationId: 'closing_reservation' });
    await harness.object.webSocketClose(closing);
    should(hosted.calls.map(call => call.path)).containEql('/internal/release');
  });
});

describe('the runtime this adapter expects Cloudflare to provide', () => {
  it('should build a socket pair, a 101 upgrade and a heartbeat pair from the platform globals', () => {
    const scope = globalThis as Record<string, unknown>;
    const originalPair = scope.WebSocketPair;
    const originalHeartbeat = scope.WebSocketRequestResponsePair;
    class FakePair {
      readonly 0 = new FakeSocket();
      readonly 1 = new FakeSocket();
    }
    class FakeHeartbeat {
      constructor(
        readonly request: string,
        readonly response: string,
      ) {}
    }
    scope.WebSocketPair = FakePair;
    scope.WebSocketRequestResponsePair = FakeHeartbeat;
    try {
      const pair = workersRuntime.createSocketPair();
      should(pair.client).not.equal(pair.server);
      workersRuntime.acceptWebSocket(pair.server);
      should((pair.server as FakeSocket).accepted).be.true();
      should(workersRuntime.upgradeResponse(pair.client).status).equal(101);
      should(workersRuntime.heartbeatPair()).match({ request: 'fy-ping', response: 'fy-pong' });
      should(workersRuntime.now()).be.above(0);
    } finally {
      scope.WebSocketPair = originalPair;
      scope.WebSocketRequestResponsePair = originalHeartbeat;
    }
  });
});

describe('session identifiers', () => {
  it('should reject a width the frame header cannot carry', () => {
    const built: SessionId | null = sessionIdFromBytes(new Uint8Array(16));
    should(built).not.be.null();
  });
});

describe('rendezvous durable object: a claim the stored state lost', () => {
  const probing = '?features=claim-probe';
  const probe = bytesOf({
    kind: FRAME_KINDS.control,
    sessionId: RENDEZVOUS_SESSION_ID,
    sequence: 0,
    payload: encodeControlMessage({ t: 'probe' }),
  });

  /** What eviction leaves behind: the same storage and the same hibernated sockets, under fresh code. */
  function evict(harness: ReturnType<typeof makeObject>): ReturnType<typeof makeObject> {
    return { ...harness, object: new RendezvousDurableObject(harness.objectState, environment, harness.runtime) };
  }

  /** The divergence the owner hit: the document says nobody holds the slot; the runtime still holds the daemon. */
  function forgetTheClaim(harness: ReturnType<typeof makeObject>): void {
    const stored = harness.objectState.storage.values.get('rendezvous') as RendezvousState;
    harness.objectState.storage.values.set('rendezvous', { ...stored, daemon: null });
  }

  it('should mark the socket that holds the claim, with the features it asked for', async () => {
    const harness = makeObject();
    const { daemonSocket } = await claimRendezvous(harness, undefined, probing);
    should(controlOf(daemonSocket.drain()[0])).match({ t: 'claimed', features: ['claim-probe'] });
    should(daemonSocket.deserializeAttachment()).match({ claim: { features: ['claim-probe'] } });

    const plain = makeObject();
    const { daemonSocket: older } = await claimRendezvous(plain);
    should(controlOf(older.drain()[0])).not.have.property('features');
    should(older.deserializeAttachment()).match({ claim: {} });
  });

  it('should keep serving across an eviction, because the claim is stored rather than remembered', async () => {
    const harness = makeObject();
    const { identity, daemonSocket } = await claimRendezvous(harness, undefined, probing);
    daemonSocket.drain();

    const woken = evict(harness);
    const { ready } = await joinClient(woken, identity.daemonId);
    should(ready).match({ t: 'ready' });
    should(controlOf(daemonSocket.drain()[0])).match({ t: 'open' });
  });

  it('should serve the phone without a daemon restart when the claim is lost but the socket is not', async () => {
    // 2026-10-19: daemon connected at 02:30:38, fy-pong kept arriving, and every phone from 02:38 to the
    // restart at 02:46 was told 4404 — the stored state had stopped naming a socket the runtime still held.
    const harness = makeObject();
    const { identity, daemonSocket } = await claimRendezvous(harness, undefined, probing);
    daemonSocket.drain();
    forgetTheClaim(harness);
    const warned: unknown[] = [];
    const warn = console.warn;
    console.warn = (...line: unknown[]) => warned.push(line);
    let joined: Awaited<ReturnType<typeof joinClient>>;
    try {
      joined = await joinClient(evict(harness), identity.daemonId);
    } finally {
      console.warn = warn;
    }

    should(joined.ready).match({ t: 'ready' });
    should(joined.clientSocket.closed).be.null();
    should(controlOf(daemonSocket.drain()[0])).match({ t: 'open' });
    should(daemonSocket.closed).be.null();
    should(harness.objectState.storage.values.get('rendezvous')).match({
      daemon: { socketId: (daemonSocket.deserializeAttachment() as { socketId: string }).socketId, restored: true },
    });
    should(warned).have.length(1);
  });

  it('should answer the holder probe from its own state, after an eviction too', async () => {
    const harness = makeObject();
    const { daemonSocket } = await claimRendezvous(harness, undefined, probing);
    daemonSocket.drain();

    await evict(harness).object.webSocketMessage(daemonSocket, probe);
    should(daemonSocket.drain().map(controlOf)).deepEqual([{ t: 'held' }]);
    should(daemonSocket.closed).be.null();
  });

  it('should close a probing socket with 4410 when nothing it holds can restore the claim', async () => {
    // A socket that never carried a claim marker: the probe is the only thing that can find it out.
    const harness = makeObject();
    const { daemonSocket } = await claimRendezvous(harness, undefined, probing);
    daemonSocket.drain();
    forgetTheClaim(harness);
    const { claim: _claim, ...unmarked } = daemonSocket.deserializeAttachment() as Record<string, unknown>;
    daemonSocket.serializeAttachment(unmarked);

    await harness.object.webSocketMessage(daemonSocket, probe);
    should(controlOf(daemonSocket.frames().at(-1))).match({ t: 'error', code: RELAY_CLOSE_CODES.claimLost });
    should(daemonSocket.closed?.code).equal(RELAY_CLOSE_CODES.claimLost);
  });

  it('should refuse a claimed socket the slot does not name with 4410, and never restore it after', async () => {
    const harness = makeObject();
    const { identity, daemonSocket } = await claimRendezvous(harness, undefined, probing);
    daemonSocket.drain();
    const other = new FakeSocket();
    other.serializeAttachment({ socketId: 'other', claim: {} });
    harness.objectState.sockets.push(other);
    const stored = harness.objectState.storage.values.get('rendezvous') as RendezvousState;
    harness.objectState.storage.values.set('rendezvous', { ...stored, daemon: { socketId: 'other', since: 1 } });

    await harness.object.alarm();
    should(daemonSocket.closed?.code).equal(RELAY_CLOSE_CODES.claimLost);
    should(daemonSocket.deserializeAttachment()).not.have.property('claim');

    // The slot's holder goes too. The refused socket is still listed, but it carries no claim any more.
    harness.objectState.sockets.splice(harness.objectState.sockets.indexOf(other), 1);
    await harness.object.fetch(socketRequest(identity.daemonId, 'client'));
    should(harness.objectState.sockets.at(-1)?.closed?.code).equal(RELAY_CLOSE_CODES.daemonAbsent);
  });

  it('should not restore a daemon whose socket reported an error or that the sweep evicted', async () => {
    const errored = makeObject();
    const first = await claimRendezvous(errored, undefined, probing);
    await errored.object.webSocketError(first.daemonSocket);
    should(first.daemonSocket.deserializeAttachment()).not.have.property('claim');
    await errored.object.fetch(socketRequest(first.identity.daemonId, 'client'));
    should(errored.objectState.sockets.at(-1)?.closed?.code).equal(RELAY_CLOSE_CODES.daemonAbsent);

    const swept = makeObject();
    const second = await claimRendezvous(swept, undefined, probing);
    swept.runtime.clock += HEARTBEAT_GRACE_SECONDS * 1_000 + 1;
    await swept.object.alarm();
    should(second.daemonSocket.closed?.code).equal(RELAY_CLOSE_CODES.heartbeatTimeout);
    should(second.daemonSocket.deserializeAttachment()).not.have.property('claim');
    await swept.object.fetch(socketRequest(second.identity.daemonId, 'client'));
    should(swept.objectState.sockets.at(-1)?.closed?.code).equal(RELAY_CLOSE_CODES.daemonAbsent);
  });

  it('should free a slot whose socket the runtime no longer holds, instead of refusing the redial 4409', async () => {
    // A reset drops every socket without delivering their closes; the stored slot still named the old one.
    const harness = makeObject();
    const { identity, daemonSocket } = await claimRendezvous(harness, undefined, probing);
    harness.objectState.sockets.splice(harness.objectState.sockets.indexOf(daemonSocket), 1);

    await evict(harness).object.fetch(socketRequest(identity.daemonId, 'daemon', undefined, probing));
    should(controlOf(harness.objectState.sockets.at(-1)?.drain()[0])).match({ t: 'challenge' });
  });
});

describe('hosted reservations a rendezvous lost without a close', () => {
  /** A rendezvous, a real control object and the real Worker in front of both, on one clock. */
  async function hostedRelay() {
    const storage = new FakeHostedRelayControlStorage();
    let clock = 1_000;
    const control = new HostedRelayControlDurableObject({ storage }, {}, { now: () => clock });
    const configured = await control.fetch(
      new Request('https://relay-control.invalid/operator/configuration', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, relayUrl: `wss://${host}`, limits: DEFAULT_HOSTED_RELAY_LIMITS }),
      }),
    );
    should(configured.status).equal(200);
    const reconciles: unknown[] = [];
    const objectState = new FakeObjectState();
    const runtime = testRuntime({ upgradeResponse: () => new Response(null, { status: 101 }) });
    Object.defineProperty(runtime, 'clock', { get: () => clock, set: value => (clock = value) });
    const relay: { object: RendezvousDurableObject } = { object: undefined as unknown as RendezvousDurableObject };
    const value: RelayEnvironment = {
      RELAY_MODE: 'hosted',
      RELAY_CONTROL: {
        idFromName: name => name,
        get: () => ({
          fetch: async request => {
            if (new URL(request.url).pathname === '/internal/reconcile') reconciles.push(await request.clone().json());
            return control.fetch(request);
          },
        }),
      },
      RENDEZVOUS: { idFromName: name => name, get: () => ({ fetch: request => relay.object.fetch(request) }) },
    };
    relay.object = new RendezvousDurableObject(objectState, value, runtime);
    const counts = () => {
      const global = storage.values.get('metrics:global') as { concurrentConnections: number };
      return {
        global: global.concurrentConnections,
        reservations: [...storage.values.keys()].filter(key => key.startsWith('reservation:')).length,
      };
    };
    /** Dial through the Worker, as a phone or the daemon would. The newest socket is the one it got. */
    const dial = async (daemonId: string, role: 'daemon' | 'client') => {
      const before = objectState.sockets.length;
      should((await relayFetch(socketRequest(daemonId, role), value, runtime)).status).equal(101);
      const refusal = runtime.pairs.at(-1)?.server;
      // A refusal is upgraded too, so it can be explained; admission is the rendezvous accepting a socket.
      return objectState.sockets.length > before
        ? { admitted: true as const, socket: objectState.sockets[before] }
        : { admitted: false as const, code: refusal?.closed?.code, reason: refusal?.closed?.reason };
    };
    return {
      storage,
      objectState,
      runtime,
      relay,
      value,
      reconciles,
      counts,
      dial,
      advance: (milliseconds: number) => {
        clock += milliseconds;
      },
    };
  }

  /** Claim the rendezvous through the Worker with a real daemon key. */
  async function claimThroughWorker(
    hosted: Awaited<ReturnType<typeof hostedRelay>>,
    known?: Awaited<ReturnType<typeof newDaemonIdentity>>,
  ) {
    const identity = known ?? (await newDaemonIdentity());
    const dialled = await hosted.dial(identity.daemonId, 'daemon');
    if (!dialled.admitted || dialled.socket === undefined) throw new Error('the daemon was not admitted');
    const challengeMessage = controlOf(dialled.socket.drain()[0]);
    if (challengeMessage?.t !== 'challenge') throw new Error('expected a challenge');
    const challenge = fromBase64UrlFixed(challengeMessage.nonce, NONCE_BYTES);
    if (challenge === null) throw new Error('challenge nonce is malformed');
    const context = claimContextForChallenge(identity.daemonId, host, challengeMessage.host, challenge);
    if (context === null) throw new Error('the daemon refused the host it was challenged for');
    const claim = encodeClaim(await signRendezvousClaim(relayCrypto, identity, context));
    await hosted.relay.object.webSocketMessage(
      dialled.socket,
      bytesOf({
        kind: FRAME_KINDS.control,
        sessionId: RENDEZVOUS_SESSION_ID,
        sequence: 0,
        payload: encodeControlMessage({ t: 'claim', protocol: RELAY_PROTOCOL_ID, ...claim }),
      }),
    );
    should(controlOf(dialled.socket.drain()[0])).match({ t: 'claimed' });
    return { identity, socket: dialled.socket };
  }

  it('should replay the 2026-10-19 lockout and let the daemon back in on the next sweep', async () => {
    const hosted = await hostedRelay();
    const identity = await newDaemonIdentity();
    // Four times over: the daemon holds the slot with three phones on it, then Cloudflare resets the
    // object — every socket gone, and not one `webSocketClose` delivered. Each reset strands four.
    for (let reset = 0; reset < 4; reset += 1) {
      await claimThroughWorker(hosted, identity);
      for (let phone = 0; phone < 3; phone += 1)
        should((await hosted.dial(identity.daemonId, 'client')).admitted).be.true();
      hosted.objectState.sockets.length = 0;
      hosted.relay.object = new RendezvousDurableObject(hosted.objectState, hosted.value, hosted.runtime);
      hosted.advance(4_000);
    }
    should(hosted.counts()).deepEqual({ global: 16, reservations: 16 });

    hosted.advance(4_000);
    should(await hosted.dial(identity.daemonId, 'daemon')).match({
      admitted: false,
      code: RELAY_CLOSE_CODES.hostedCapacity,
      reason: 'hosted relay per-daemon connection ceiling is reached',
    });

    // The alarm the dead sockets left behind still fires. The rendezvous reports what it holds — nothing —
    // and the control object takes back every reservation past the handoff grace.
    hosted.advance(HOSTED_RELAY_RESERVATION_HANDOFF_GRACE_MILLISECONDS);
    await hosted.relay.object.alarm();
    should(hosted.reconciles.at(-1)).deepEqual({ daemonId: identity.daemonId, live: [] });
    should(hosted.counts()).deepEqual({ global: 0, reservations: 0 });

    const back = await claimThroughWorker(hosted, identity);
    should(hosted.counts()).deepEqual({ global: 1, reservations: 1 });
    // And the ordinary close still gives that one back, so the count returns to zero.
    await hosted.relay.object.webSocketClose(back.socket);
    should(hosted.counts()).deepEqual({ global: 0, reservations: 0 });
  });

  it('should bring the count back to zero after every refused or departed arrival', async () => {
    const hosted = await hostedRelay();
    const identity = await newDaemonIdentity();
    // No daemon yet: the phone is admitted by the Worker, refused 4404 by the rendezvous, and released.
    await hosted.dial(identity.daemonId, 'client');
    should(hosted.counts()).deepEqual({ global: 0, reservations: 0 });
    const { socket } = await claimThroughWorker(hosted, identity);
    // A second daemon socket while the first is live and answering is refused, and gives its slot back.
    hosted.objectState.lastSeen.set(socket, new Date(hosted.runtime.clock));
    const second = await hosted.dial(identity.daemonId, 'daemon');
    if (second.admitted && second.socket !== undefined) await hosted.relay.object.webSocketClose(second.socket);
    should(hosted.counts()).deepEqual({ global: 1, reservations: 1 });
    await hosted.relay.object.webSocketError(socket);
    should(hosted.counts()).deepEqual({ global: 0, reservations: 0 });
  });

  it('should renew the reservations its live sockets carry, and only reclaim the ones they do not', async () => {
    const hosted = await hostedRelay();
    const { identity, socket } = await claimThroughWorker(hosted);
    const phone = await hosted.dial(identity.daemonId, 'client');
    if (!phone.admitted || phone.socket === undefined) throw new Error('the phone was not admitted');
    // The phone's socket is lost on its own; the daemon's is still held.
    hosted.objectState.sockets.splice(hosted.objectState.sockets.indexOf(phone.socket), 1);
    hosted.advance(HOSTED_RELAY_RESERVATION_HANDOFF_GRACE_MILLISECONDS);
    hosted.objectState.lastSeen.set(socket, new Date(hosted.runtime.clock));
    await hosted.relay.object.alarm();
    should(hosted.counts()).deepEqual({ global: 1, reservations: 1 });
    const reservationId = (socket.deserializeAttachment() as { reservationId: string }).reservationId;
    should(hosted.reconciles).deepEqual([{ daemonId: identity.daemonId, live: [reservationId] }]);
    should(hosted.storage.values.get(`reservation:${reservationId}`)).match({ confirmedAt: hosted.runtime.clock });
    should(socket.closed).be.null();
  });

  it('should renew at most once a minute and try again on the next sweep when the control object is down', async () => {
    const hosted = await hostedRelay();
    const { socket } = await claimThroughWorker(hosted);
    const sweep = async () => {
      hosted.objectState.lastSeen.set(socket, new Date(hosted.runtime.clock));
      await hosted.relay.object.alarm();
    };
    await sweep();
    hosted.advance(HOSTED_RESERVATION_RENEW_MS - 1);
    await sweep();
    should(hosted.reconciles).have.length(1);
    hosted.advance(1);
    await sweep();
    should(hosted.reconciles).have.length(2);

    // A renewal the control object did not take is not remembered as done, so the next sweep asks again.
    const control = hosted.value.RELAY_CONTROL;
    if (control === undefined) throw new Error('hosted relay has no control binding');
    const failing = new RendezvousDurableObject(
      hosted.objectState,
      {
        ...hosted.value,
        RELAY_CONTROL: {
          idFromName: name => name,
          get: id => ({
            fetch: async request =>
              new URL(request.url).pathname === '/internal/reconcile'
                ? new Response(null, { status: 503 })
                : control.get(id).fetch(request),
          }),
        },
      },
      hosted.runtime,
    );
    hosted.relay.object = failing;
    await sweep();
    hosted.relay.object = new RendezvousDurableObject(hosted.objectState, hosted.value, hosted.runtime);
    await sweep();
    should(hosted.reconciles).have.length(3);
  });

  it('should never report reservations from a self-hosted rendezvous', async () => {
    const harness = makeObject();
    const { daemonSocket } = await claimRendezvous(harness);
    harness.objectState.lastSeen.set(daemonSocket, new Date(harness.runtime.clock));
    await harness.object.alarm();
    should(daemonSocket.closed).be.null();
  });
});
