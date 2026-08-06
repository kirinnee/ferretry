/**
 * THE WHOLE CLAIM, FROM THE BROWSER'S END.
 *
 * `packages/relay` proves its own session against its own primitives, and
 * `packages/daemon` proves the daemon half. Neither proves the thing this unit
 * exists for: that the browser's client, the actual rendezvous code, and the
 * actual daemon link are three implementations of ONE protocol. So all three real
 * halves are wired together here — the PWA's `RelayClientSession` through the real
 * `RendezvousDurableObject` to the daemon's real `RelayLink` — with real WebCrypto
 * at every corner.
 *
 * And then the assertion that matters, which is not "it worked":
 *
 *     THE RENDEZVOUS FORWARDED EVERY BYTE AND COULD NOT READ ONE OF THEM.
 *
 * Every frame the rendezvous handled is kept, and the device token and the request
 * and answer bodies are searched for across all of them. If a relay can read a
 * session it is wrong however well it works.
 *
 * The three source halves are imported by relative path deliberately. A test that
 * imported a re-export of one of them could pass against a copy; these are the
 * files that ship.
 */

import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import should from 'should';
import { type ApiRequest, type ApiResponse, headersFrom } from '../../../daemon/src/lib/api/http.ts';
import {
  RelayLink,
  type RelayLinkDependencies,
  type RelayPairingRedeemer,
} from '../../../daemon/src/lib/relay/link.ts';
import {
  type RelayEnvironment,
  RendezvousDurableObject,
  WebCryptoRelayCrypto,
} from '../../../relay/src/adapters/index.ts';
import { daemonIdFromPublicKey, RELAY_CLOSE_CODES, utf8Text } from '../../../relay/src/lib/index.ts';
import { newDaemonIdentity } from '../../../relay/tests/support/identities.ts';
import { FakeObjectState, type FakeSocket, testRuntime } from '../../../relay/tests/support/workers-fakes.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import {
  type RelayCarrierSocket,
  openRelaySession,
  relayResponse,
  relayTunnelRequest,
} from '../../src/lib/relay-carrier.ts';
import { type RelayClientSession, RelaySessionError } from '../../src/lib/relay-session.ts';

const HOST = 'relay.example';
const RELAY_URL = `https://${HOST}`;
const DAEMON_URL = 'https://studio.example';
const DEVICE_TOKEN = 'fy_device_this-credential-must-never-reach-the-carrier';
const SECRET_ANSWER = 'the session list a relay operator may not read';

const crypto = new WebCryptoRelayCrypto();

const environment: RelayEnvironment = {
  RENDEZVOUS: { idFromName: name => name, get: () => ({ fetch: async () => new Response(null) }) },
};

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/**
 * The three real halves, carrying frames between each other.
 *
 * The rendezvous is driven by explicit calls rather than by a socket, so this pumps:
 * every frame either endpoint sends is handed to the rendezvous, and everything the
 * rendezvous put in either endpoint's outbox is handed to that endpoint. Work is
 * serialised through one queue because §7 makes a frame's sequence number its AEAD
 * nonce — delivering two frames concurrently would prove the wrong thing.
 */
class RelayBridge {
  /** Every frame the rendezvous handled, in both directions. Its entire view. */
  readonly observed: Uint8Array[] = [];
  readonly rendezvous: RendezvousDurableObject;
  readonly objectState = new FakeObjectState();
  #queue: (() => Promise<void>)[] = [];
  #running = false;
  #daemonSocket: FakeSocket | undefined;
  #clientSocket: FakeSocket | undefined;
  #link: RelayLink | undefined;
  #session: { receiveBinary(bytes: Uint8Array): Promise<void>; receiveText(text: string): void } | undefined;

  constructor() {
    this.rendezvous = new RendezvousDurableObject(this.objectState, environment, testRuntime());
  }

  /** Bring the daemon in first: §9 refuses a client at a rendezvous no daemon holds. */
  /**
   * @param dispatch how the daemon answers a §14 request session.
   * @param pairing how it answers a §14 pairing session. Refuses by default, because a redemption
   *   that succeeded by accident is exactly the thing these cases are here to catch.
   * @param sockets how it answers a §14 stream session's protocol switch.
   */
  async admitDaemon(
    identity: Awaited<ReturnType<typeof newDaemonIdentity>>,
    dispatch: RelayApiDispatch,
    pairing: RelayPairingRedeemer = { redeemOverRelay: async () => ({ kind: 'refused' }) },
    sockets: RelayLinkDependencies['sockets'] = async () => ({ outcome: 'unclaimed' }),
  ): Promise<void> {
    await this.rendezvous.fetch(
      new Request(`${RELAY_URL}/v1/rendezvous/${identity.daemonId}/daemon`, { headers: { Upgrade: 'websocket' } }),
    );
    const socket = this.objectState.sockets.at(-1);
    if (socket === undefined) throw new Error('the rendezvous accepted no daemon socket');
    this.#daemonSocket = socket;
    this.#link = new RelayLink({
      crypto,
      identity,
      relayHost: HOST,
      socket: {
        send: bytes => this.#toRendezvous(socket, bytes),
        sendText: () => undefined,
        close: () => undefined,
      },
      dispatch,
      devices: { identifyDevice: token => (token === DEVICE_TOKEN ? 'phone' : undefined) },
      pairing,
      sockets,
      // A REAL `setTimeout` LEFT ARMED WOULD OUTLIVE THE CASE. §14 gives every session a ten-second
      // credential deadline, and this suite settles in microseconds — so the timer would never fire
      // and would keep the process alive after the assertions passed. Cancelled explicitly rather
      // than relied on: a suite that hangs is a suite nobody reads the output of.
      scheduler: {
        after: (milliseconds, action) => {
          const handle = setTimeout(action, milliseconds);
          return { cancel: () => clearTimeout(handle) };
        },
      },
    });
    this.#drain();
    await this.settle();
  }

  /** The dial the browser's carrier uses. It reaches the rendezvous, never the daemon. */
  dial(daemonId: string): RelayCarrierSocket {
    const adapted: RelayCarrierSocket = {
      onOpen: null,
      onText: null,
      onBinary: null,
      onClose: null,
      send: bytes => {
        const socket = this.#clientSocket;
        if (socket !== undefined) this.#toRendezvous(socket, bytes);
      },
      sendText: () => undefined,
      close: () => undefined,
    };
    this.#session = {
      receiveBinary: async bytes => await Promise.resolve(adapted.onBinary?.(bytes)),
      receiveText: text => adapted.onText?.(text),
    };
    this.#enqueue(async () => {
      await this.rendezvous.fetch(
        new Request(`${RELAY_URL}/v1/rendezvous/${daemonId}/client`, { headers: { Upgrade: 'websocket' } }),
      );
      const socket = this.objectState.sockets.at(-1);
      this.#clientSocket = socket;
      adapted.onOpen?.();
      this.#drain();
      // A rendezvous no daemon holds closes the client socket during the upgrade
      // (§9, `4404`). Reporting that close is what turns it into a refusal the
      // browser can show rather than a socket that never says anything.
      if (socket?.closed != null) adapted.onClose?.(socket.closed.code ?? 0, socket.closed.reason ?? '');
    });
    return adapted;
  }

  /** Wait until nothing is left to carry. */
  async settle(): Promise<void> {
    for (let spin = 0; spin < 200; spin += 1) {
      if (!this.#running && this.#queue.length === 0) return;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error('the bridge never went quiet');
  }

  #toRendezvous(socket: FakeSocket, bytes: Uint8Array): void {
    this.observed.push(Uint8Array.from(bytes));
    this.#enqueue(async () => {
      await this.rendezvous.webSocketMessage(socket, buffer(bytes));
      this.#drain();
    });
  }

  /** Hand each endpoint whatever the rendezvous put in its outbox, in order. */
  #drain(): void {
    for (const [socket, deliver] of [
      [this.#clientSocket, (bytes: Uint8Array) => this.#session?.receiveBinary(bytes)],
      [this.#daemonSocket, (bytes: Uint8Array) => this.#link?.receiveBinary(bytes)],
    ] as const) {
      if (socket === undefined) continue;
      const outbox = socket.sent.splice(0, socket.sent.length);
      for (const data of outbox) {
        if (typeof data === 'string') continue;
        const bytes = new Uint8Array(data);
        this.observed.push(bytes);
        this.#enqueue(async () => {
          await deliver(bytes);
          this.#drain();
        });
      }
    }
  }

  #enqueue(task: () => Promise<void>): void {
    this.#queue.push(task);
    void this.#run();
  }

  async #run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    while (this.#queue.length > 0) {
      const task = this.#queue.shift();
      if (task !== undefined) await task();
    }
    this.#running = false;
  }
}

type RelayApiDispatch = (request: ApiRequest) => Promise<ApiResponse>;

const answered =
  (body: string): RelayApiDispatch =>
  async () => ({
    status: 200,
    headers: headersFrom({ 'content-type': 'application/json' }),
    body,
  });

/** Everything the rendezvous handled, as one searchable string. */
const carrierSaw = (bridge: RelayBridge): string =>
  bridge.observed.map(bytes => utf8Text(bytes) ?? bytes.join(',')).join(' ');

describe('a relayed session, browser to daemon, through the real rendezvous', () => {
  it('should carry a request and its answer without the carrier reading either', async () => {
    const identity = await newDaemonIdentity();
    // The fingerprint the browser pins is the SAME one the daemon signs with. A
    // second relay identity would carry a fingerprint no paired browser has, and
    // every handshake would be refused — correctly, and unfixably from outside.
    should(await daemonIdFromPublicKey(crypto, identity.publicKeySpki)).equal(identity.daemonId);
    // And it agrees with the fingerprint PAIRING prints in the QR, which is computed
    // by Node rather than by WebCrypto (`node-pairing-cryptography.ts`). Two spellings
    // of one fingerprint are two identities, and they would never meet: the browser
    // would pin the QR's and refuse the key the daemon actually presented.
    should(`fy_daemon_${createHash('sha256').update(identity.publicKeySpki).digest('base64url')}`).equal(
      identity.daemonId,
    );

    const bridge = new RelayBridge();
    let served: ApiRequest | undefined;
    await bridge.admitDaemon(identity, async request => {
      served = request;
      return await answered(SECRET_ANSWER)(request);
    });

    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
    });
    const session: RelayClientSession = await openRelaySession({
      crypto,
      dial: () => bridge.dial(identity.daemonId),
      daemon,
      method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
      heartbeat: () => () => undefined,
    });
    should(session.live()).be.true();

    const response = relayResponse(
      await session.request(
        relayTunnelRequest(`${DAEMON_URL}/v1/sessions?sessionId=fy_one&sessionId=fy_two`, {
          headers: { authorization: `Bearer ${DEVICE_TOKEN}`, 'content-type': 'application/json' },
        }),
      ),
    );
    await bridge.settle();

    should(response.status).equal(200);
    should(await response.text()).equal(SECRET_ANSWER);

    // The daemon served it out of its OWN route table, with the credential this
    // module put on and the repeated query parameter an object could not have held.
    should(served?.path).equal('/v1/sessions');
    should(served?.query.get('sessionId')).eql(['fy_one', 'fy_two']);
    should(served?.headers.get('authorization')).equal(`Bearer ${DEVICE_TOKEN}`);
    should(served?.loopback).be.false();

    // ── and now the only assertion that makes any of it worth having ──
    const seen = carrierSaw(bridge);
    should(bridge.observed.length).be.greaterThan(4);
    should(seen).not.containEql(DEVICE_TOKEN);
    should(seen).not.containEql('deviceToken');
    should(seen).not.containEql(SECRET_ANSWER);
    should(seen).not.containEql('/v1/sessions');
    // The fingerprint IS visible, in the URL, because it is what addresses the
    // rendezvous. §10 discloses that rather than pretending otherwise.
    should(identity.daemonId.startsWith('fy_daemon_')).be.true();
  });

  it('should refuse a daemon whose key is not the one the pairing pinned, without sending the token', async () => {
    const identity = await newDaemonIdentity();
    const impostor = await newDaemonIdentity();
    const bridge = new RelayBridge();
    // The rendezvous is held by the impostor and addressed by ITS fingerprint, so
    // the carrier is behaving perfectly. The browser pinned somebody else.
    await bridge.admitDaemon(impostor, answered('never reached'));

    // The browser pinned `identity`; the carrier hands it `impostor`. That is a
    // misrouted session, which is exactly the case the fingerprint check exists for.
    const pinnedElsewhere = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
    });

    await should(
      openRelaySession({
        crypto,
        dial: () => bridge.dial(impostor.daemonId),
        daemon: pinnedElsewhere,
        method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
        heartbeat: () => () => undefined,
      }),
    ).be.rejected();
    await bridge.settle();

    should(carrierSaw(bridge)).not.containEql(DEVICE_TOKEN);
  });

  it('should refuse a client at a rendezvous no daemon holds rather than parking it', async () => {
    const identity = await newDaemonIdentity();
    const bridge = new RelayBridge();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
    });

    const refusal = await openRelaySession({
      crypto,
      dial: () => bridge.dial(identity.daemonId),
      daemon,
      method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
      heartbeat: () => () => undefined,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    should(refusal).be.instanceof(RelaySessionError);
    should((refusal as RelaySessionError).code).equal(RELAY_CLOSE_CODES.daemonAbsent);
    should(carrierSaw(bridge)).not.containEql(DEVICE_TOKEN);
  });
});
