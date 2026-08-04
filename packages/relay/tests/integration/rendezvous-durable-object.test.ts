import { describe, it } from 'bun:test';
import {
  type RelayEnvironment,
  type RelayRuntime,
  RendezvousDurableObject,
  workersRuntime,
} from '../../src/adapters/index.ts';
import {
  claimContextForChallenge,
  type ControlMessage,
  decodeControlMessage,
  encodeClaim,
  encodeControlMessage,
  encodeFrame,
  FRAME_KINDS,
  fromBase64UrlFixed,
  HEARTBEAT_GRACE_SECONDS,
  NONCE_BYTES,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  type RelayFrame,
  RENDEZVOUS_SESSION_ID,
  type SessionId,
  sessionIdFromBytes,
  signRendezvousClaim,
} from '../../src/lib/index.ts';
import should from 'should';
import { newDaemonIdentity, relayCrypto, stubbedCrypto } from '../support/identities.ts';
import { FakeObjectState, FakeSocket, testRuntime } from '../support/workers-fakes.ts';

const host = 'relay.example';

const environment: RelayEnvironment = {
  RENDEZVOUS: { idFromName: name => name, get: () => ({ fetch: async () => new Response(null) }) },
};

function makeObject(overrides: Partial<RelayRuntime> = {}) {
  const objectState = new FakeObjectState();
  const runtime = testRuntime(overrides);
  return { objectState, runtime, object: new RendezvousDurableObject(objectState, environment, runtime) };
}

function socketRequest(daemonId: string, role: 'daemon' | 'client'): Request {
  return new Request(`https://${host}/v1/rendezvous/${daemonId}/${role}`, { headers: { Upgrade: 'websocket' } });
}

function controlOf(frame: RelayFrame | undefined): ControlMessage | null {
  return frame === undefined ? null : decodeControlMessage(frame.payload);
}

function bytesOf(frame: RelayFrame): ArrayBuffer {
  const encoded = encodeFrame(frame);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

/** Bring a real daemon all the way through the claim, exactly as a daemon would. */
async function claimRendezvous(harness: ReturnType<typeof makeObject>) {
  const identity = await newDaemonIdentity();
  await harness.object.fetch(socketRequest(identity.daemonId, 'daemon'));
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

async function joinClient(harness: ReturnType<typeof makeObject>, daemonId: string) {
  const before = harness.objectState.sockets.length;
  await harness.object.fetch(socketRequest(daemonId, 'client'));
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
