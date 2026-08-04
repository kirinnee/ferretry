import { describe, it } from 'bun:test';
import should from 'should';
import {
  type RelayEnvironment,
  type RelayRuntime,
  RendezvousDurableObject,
  workersRuntime,
} from '../../src/adapters/index.ts';
import {
  type ControlMessage,
  claimContextForChallenge,
  decodeControlMessage,
  encodeClaim,
  encodeControlMessage,
  encodeFrame,
  FRAME_KINDS,
  fromBase64UrlFixed,
  HEARTBEAT_GRACE_SECONDS,
  initialRendezvousState,
  NONCE_BYTES,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type RelayFrame,
  type SessionId,
  sessionIdFromBytes,
  signRendezvousClaim,
} from '../../src/lib/index.ts';
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

function socketRequest(daemonId: string, role: 'daemon' | 'client', reservationId?: string): Request {
  return new Request(`https://${host}/v1/rendezvous/${daemonId}/${role}`, {
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
async function claimRendezvous(harness: ReturnType<typeof makeObject>, reservationId?: string) {
  const identity = await newDaemonIdentity();
  await harness.object.fetch(socketRequest(identity.daemonId, 'daemon', reservationId));
  const daemonSocket = harness.objectState.sockets[0];
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
    should(daemonSocket.drain()).deepEqual([frame]);
    const meterCalls = hosted.calls.filter(call => call.path === '/internal/meter');
    should(meterCalls.at(-1)?.input).deepEqual({ daemonId: identity.daemonId, bytes: encoded.byteLength });
    should(meterCalls.some(call => (call.input as { bytes?: number }).bytes === 0)).be.true();
  });

  it('should send a control refusal before closing when metering denies or disappears', async () => {
    for (const answer of [
      () => ({ ok: false, code: RELAY_CLOSE_CODES.hostedBandwidth, reason: 'daily cap reached' }),
      () => ({ invalid: true }),
    ]) {
      const hosted = hostedEnvironment(answer);
      const harness = makeObject({}, hosted.environment);
      const daemonId = `fy_daemon_${'a'.repeat(43)}`;
      const client = new FakeSocket();
      client.serializeAttachment({ socketId: 'client', reservationId: 'client_reservation' });
      harness.objectState.sockets.push(client);
      const sessionId = sessionIdFromBytes(new Uint8Array(16).fill(1));
      if (sessionId === null) throw new Error('session fixture is invalid');
      harness.objectState.storage.values.set('rendezvous', {
        ...initialRendezvousState(daemonId),
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
      await harness.object.webSocketMessage(
        client,
        bytesOf({ kind: FRAME_KINDS.data, sessionId, sequence: 1, payload: new Uint8Array([1]) }),
      );
      should(controlOf(client.frames()[0])).match({ t: 'error' });
      should(client.closed?.code).be.oneOf(RELAY_CLOSE_CODES.hostedBandwidth, RELAY_CLOSE_CODES.relayInternal);
    }
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
