/**
 * A RELAYED EVENT STREAM, END TO END ON THE DAEMON SIDE.
 *
 * The E2E harness proved a real browser opens a §14 stream session over a real rendezvous and then
 * receives nothing: the daemon appended two durable events, the rendezvous saw the third client
 * arrival, and the viewer's cursor never moved. From outside a sealed channel that is as far as
 * anyone can narrow it — the harness cannot see the records, which is the whole point of the
 * channel. So this test stands INSIDE the daemon and answers the half nobody could observe.
 *
 * Nothing between the client's record and the pane is faked. The real `ApiSocketDispatcher` decides
 * the upgrade over the real authorization boundary; the real `fleetEventSocketRoutes` parses the
 * scope; the real `FleetEventStreamService` subscribes and frames; and the real `RelayLink` seals
 * every record under real AES-256-GCM. The only fakes are the two things a daemon does not own here:
 * the socket, and the journal underneath the event source.
 *
 * If this passes, a relayed viewer that sees nothing is not the daemon's half, and the evidence for
 * saying so is a decrypted `data` record carrying the event the source emitted.
 */

import { beforeAll, describe, it } from 'bun:test';
import {
  type ChannelState,
  type ControlMessage,
  completeClientHandshake,
  type DaemonIdentity,
  decodeDaemonHello,
  decodeFrame,
  encodeControlMessage,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  HANDSHAKE_FRAME_SEQUENCE,
  NONCE_BYTES,
  openChannel,
  openRecord,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type RelayFrame,
  type SessionId,
  sealRecord,
  sessionIdFromBytes,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
  utf8Text,
} from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import should from 'should';
import { NodePairingCryptography } from '../../../src/adapters/pairing/node-pairing-cryptography.ts';
import { WebCryptoRelayIdentityKeys } from '../../../src/adapters/relay/web-crypto-relay-identity.ts';
import type { ApiResponse } from '../../../src/lib/api/http.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import { ApiSocketDispatcher, type SocketRoute } from '../../../src/lib/api/socket.ts';
import { SocketTicketRegistry } from '../../../src/lib/api/socket-ticket.ts';
import type { PairingRedemption } from '../../../src/lib/pairing/index.ts';
import { RelayLink, type RelayLinkSocket } from '../../../src/lib/relay/index.ts';
import { fleetEventSocketRoutes } from '../../../src/lib/runtime/mounts/fleet-events.ts';
import { FleetEventStreamService } from '../../../src/lib/session/events/index.ts';
import type { StoredSessionEvent } from '../../../src/lib/session/reads/index.ts';

const relayCrypto = new WebCryptoRelayCrypto();
const DEVICE_TOKEN = 'fy_device_known';
const DEVICE_ID = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';
const SESSION = 'wire-1';

let identity: DaemonIdentity;

beforeAll(async () => {
  identity = await new WebCryptoRelayIdentityKeys().load(new NodePairingCryptography().newIdentity().privateKeyPem);
});

/** One journal, as the daemon's own storage publishes one: replay, a tail, and live appends. */
function journal() {
  const listeners = new Set<(event: StoredSessionEvent) => void>();
  return {
    listeners,
    append(event: StoredSessionEvent): void {
      for (const listener of listeners) listener(event);
    },
    source: {
      replay: async () => [],
      fleetBacklog: async () => ({ sessionIds: [SESSION], events: [] }),
      subscribe: (listener: (event: StoredSessionEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

const storedEvent = (sequence: number): StoredSessionEvent => ({
  sessionId: SESSION,
  sequence,
  time: new Date(Date.UTC(2026, 7, 6, 12, 0, sequence)).toISOString(),
  type: 'session.waiting',
  data: { reason: 'the signal pair the harness fires' },
});

/** The real socket dispatcher over the real event route, with a guard that governs nothing. */
function socketDispatcher(events: FleetEventStreamService): ApiSocketDispatcher {
  const routes: readonly SocketRoute[] = fleetEventSocketRoutes(
    { handler: (scope, downstream) => events.handler(scope, downstream) },
    // The session directory as the route uses it: it asks only whether the scope names a session
    // this daemon holds, and refuses with a 404 when it does not.
    { get: async () => ({ id: SESSION }) as never, list: async () => ({ sessions: [] }) as never },
  );
  return new ApiSocketDispatcher(
    new ApiRouter(routes),
    { admin: 'fy_admin_host_only', devices: { identify: token => (token === DEVICE_TOKEN ? DEVICE_ID : undefined) } },
    new SocketTicketRegistry({ now: () => Date.now() }, { ticket: () => 'unused' }),
    // `/v1/events` names no capability, so the boundary never asks — and a guard that refuses
    // everything proves that, because a route that DID demand one would fail this test loudly.
    {
      decide: () => ({ allowed: false, refusal: 'undetermined' as const }),
      governance: () => ({
        governed: true,
        passwordSet: false,
        confirmChange: true,
        decide: () => ({ allowed: false, refusal: 'undetermined' as const }),
      }),
      explain: () => undefined,
    },
  );
}

interface Wire {
  readonly frames: RelayFrame[];
  readonly socket: RelayLinkSocket;
}

function wire(): Wire {
  const frames: RelayFrame[] = [];
  return {
    frames,
    socket: {
      send: bytes => {
        const decoded = decodeFrame(bytes);
        if (!decoded.ok) throw new Error(`the daemon sent an undecodable frame: ${decoded.reason}`);
        frames.push(decoded.frame);
      },
      sendText: () => undefined,
      close: () => undefined,
    },
  };
}

const control = (message: ControlMessage, sessionId: SessionId = RENDEZVOUS_SESSION_ID): Uint8Array =>
  encodeFrame({ kind: FRAME_KINDS.control, sessionId, sequence: 0, payload: encodeControlMessage(message) });

const session = (): SessionId => {
  const id = sessionIdFromBytes(new Uint8Array([4, 4, 4, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  if (id === null) throw new Error('unreachable: 16 bytes');
  return id;
};

/** Every record the daemon has sent, opened in order as the browser's own client would. */
async function readRecords(sent: Wire, channel: ChannelState): Promise<unknown[]> {
  let state = channel;
  const messages: unknown[] = [];
  for (const frame of sent.frames.filter(candidate => candidate.kind === FRAME_KINDS.data)) {
    const opened = await openRecord(relayCrypto, state, frame);
    if (!opened.ok) throw new Error(opened.reason);
    state = opened.state;
    const text = utf8Text(opened.plaintext);
    if (text === null) throw new Error('a record carried invalid UTF-8');
    messages.push(JSON.parse(text));
  }
  return messages;
}

describe('a live event stream carried by a rendezvous', () => {
  it('should open through the real socket dispatcher and seal every event the journal appends', async () => {
    // Arrange — the daemon's real event surface behind its real upgrade boundary.
    const feed = journal();
    const events = new FleetEventStreamService(feed.source, {
      after: (milliseconds, action) => {
        const timer = setTimeout(action, milliseconds);
        return { cancel: () => clearTimeout(timer) };
      },
    });
    const sent = wire();
    const link = new RelayLink({
      crypto: relayCrypto,
      identity,
      relayHost: 'relay.example',
      socket: sent.socket,
      dispatch: async (): Promise<ApiResponse> => ({ status: 404, headers: new Map(), body: '' }),
      sockets: async request => await socketDispatcher(events).upgrade(request),
      devices: { identifyDevice: token => (token === DEVICE_TOKEN ? DEVICE_ID : undefined) },
      pairing: { redeemOverRelay: async (): Promise<PairingRedemption> => ({ kind: 'refused' }) },
      scheduler: {
        after: (milliseconds, action) => {
          const timer = setTimeout(action, milliseconds);
          return { cancel: () => clearTimeout(timer) };
        },
      },
    });

    // Arrange — one keyed session, exactly as the rendezvous would drive it.
    const sessionId = session();
    await link.receiveBinary(
      control({
        t: 'challenge',
        protocol: RELAY_PROTOCOL_ID,
        nonce: toBase64Url(relayCrypto.randomBytes(NONCE_BYTES)),
        host: 'relay.example',
        deadlineSeconds: 10,
      }),
    );
    await link.receiveBinary(
      control({
        t: 'claimed',
        protocol: RELAY_PROTOCOL_ID,
        limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
      }),
    );
    await link.receiveBinary(control({ t: 'open' }, sessionId));
    const pending = await startClientHandshake(relayCrypto, sessionId, identity.daemonId);
    await link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId,
        sequence: HANDSHAKE_FRAME_SEQUENCE,
        payload: encodeHandshakeMessage(pending.hello),
      }),
    );
    const answer = sent.frames.filter(frame => frame.kind === FRAME_KINDS.handshake).at(-1);
    if (answer === undefined) throw new Error('the daemon sent no handshake answer');
    const hello = decodeDaemonHello(answer.payload);
    if (hello === null) throw new Error('the daemon hello did not parse');
    const completed = await completeClientHandshake(relayCrypto, pending, hello);
    if (!completed.ok) throw new Error(completed.reason);
    const clientToDaemon = openChannel(sessionId, completed.keys, 'client');
    const daemonToClient = openChannel(sessionId, completed.keys, 'client');

    // Act — the credential record opens the stream in the same breath, exactly as §14 says.
    const sealed = await sealRecord(
      relayCrypto,
      clientToDaemon,
      utf8Bytes(
        JSON.stringify({
          t: 'stream',
          protocol: RELAY_PROTOCOL_ID,
          deviceToken: DEVICE_TOKEN,
          path: '/v1/events',
          query: [
            ['sessionId', SESSION],
            ['after', '0'],
          ],
        }),
      ),
    );
    if (!sealed.ok) throw new Error(sealed.reason);
    await link.receiveBinary(encodeFrame(sealed.frame));

    // Assert — the upgrade was ACCEPTED. A refusal here would be a `stream-refused` carrying the
    // status, which is the answer that tells a viewer why rather than leaving it watching nothing.
    const accepted = await readRecords(sent, daemonToClient);
    should(accepted).have.length(1);
    should(accepted[0]).deepEqual({ t: 'stream-opened', protocol: RELAY_PROTOCOL_ID });

    // Act — the journal appends, exactly as a `waiting` then `working` signal pair makes it.
    feed.append(storedEvent(1));
    feed.append(storedEvent(2));
    // The link seals on its own queue, and `receiveBinary` is what waits for it.
    await link.receiveBinary(
      control({
        t: 'claimed',
        protocol: RELAY_PROTOCOL_ID,
        limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
      }),
    );

    // Assert — both events crossed, sealed, as `data` records carrying the feed's own frame shape.
    const delivered = await readRecords(sent, daemonToClient);
    should(delivered).have.length(3);
    should(delivered.slice(1)).matchEach((message: { t: string; text: string }) => {
      should(message.t).equal('data');
      const frame = JSON.parse(message.text) as { kind: string; event: { sessionId: string; sequence: number } };
      should(frame.kind).equal('event');
      should(frame.event.sessionId).equal(SESSION);
    });
    should(link.report().sessions).equal(1);
  });

  it('should answer a refused subscription with its status, so a refusal never reads as silence', async () => {
    // WHY THIS CASE EXISTS. "The stream opened and carried no frames" is the report a viewer makes
    // when it cannot tell an accepted-but-empty stream from a refused one. It must never be
    // ambiguous on this side: every way the event route can say no becomes a sealed `stream-refused`
    // carrying the status, BEFORE anything switches, and the session then concludes with `4440`.
    const feed = journal();
    const events = new FleetEventStreamService(feed.source, {
      after: (milliseconds, action) => {
        const timer = setTimeout(action, milliseconds);
        return { cancel: () => clearTimeout(timer) };
      },
    });
    const sent = wire();
    const link = new RelayLink({
      crypto: relayCrypto,
      identity,
      relayHost: 'relay.example',
      socket: sent.socket,
      dispatch: async (): Promise<ApiResponse> => ({ status: 404, headers: new Map(), body: '' }),
      sockets: async request => await socketDispatcher(events).upgrade(request),
      devices: { identifyDevice: token => (token === DEVICE_TOKEN ? DEVICE_ID : undefined) },
      pairing: { redeemOverRelay: async (): Promise<PairingRedemption> => ({ kind: 'refused' }) },
      scheduler: {
        after: (milliseconds, action) => {
          const timer = setTimeout(action, milliseconds);
          return { cancel: () => clearTimeout(timer) };
        },
      },
    });

    const sessionId = session();
    await link.receiveBinary(
      control({
        t: 'challenge',
        protocol: RELAY_PROTOCOL_ID,
        nonce: toBase64Url(relayCrypto.randomBytes(NONCE_BYTES)),
        host: 'relay.example',
        deadlineSeconds: 10,
      }),
    );
    await link.receiveBinary(
      control({
        t: 'claimed',
        protocol: RELAY_PROTOCOL_ID,
        limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
      }),
    );
    await link.receiveBinary(control({ t: 'open' }, sessionId));
    const pending = await startClientHandshake(relayCrypto, sessionId, identity.daemonId);
    await link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId,
        sequence: HANDSHAKE_FRAME_SEQUENCE,
        payload: encodeHandshakeMessage(pending.hello),
      }),
    );
    const answer = sent.frames.filter(frame => frame.kind === FRAME_KINDS.handshake).at(-1);
    if (answer === undefined) throw new Error('the daemon sent no handshake answer');
    const hello = decodeDaemonHello(answer.payload);
    if (hello === null) throw new Error('the daemon hello did not parse');
    const completed = await completeClientHandshake(relayCrypto, pending, hello);
    if (!completed.ok) throw new Error(completed.reason);

    // Act — a fleet-scoped stream asking to resume a cursor no fleet feed owns, which the route
    // refuses precisely so it cannot pretend to resume something it cannot.
    const sealed = await sealRecord(
      relayCrypto,
      openChannel(sessionId, completed.keys, 'client'),
      utf8Bytes(
        JSON.stringify({
          t: 'stream',
          protocol: RELAY_PROTOCOL_ID,
          deviceToken: DEVICE_TOKEN,
          path: '/v1/events',
          query: [['after', '42']],
        }),
      ),
    );
    if (!sealed.ok) throw new Error(sealed.reason);
    await link.receiveBinary(encodeFrame(sealed.frame));

    // Assert — a status and a body a viewer can act on, then the conclusion. Never an open stream
    // that says nothing.
    const answered = (await readRecords(sent, openChannel(sessionId, completed.keys, 'client'))) as {
      t: string;
      status: number;
      body: string;
    }[];
    should(answered).have.length(1);
    should(answered[0]?.t).equal('stream-refused');
    should(answered[0]?.status).equal(400);
    should(answered[0]?.body).containEql('fleet_cursor_unavailable');
    should(link.report().sessions).equal(0);
  });
});
