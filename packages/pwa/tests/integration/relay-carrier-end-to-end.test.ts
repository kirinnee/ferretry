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
import type { SocketDownstream, SocketFrame, SocketUpgradeDecision } from '../../../daemon/src/lib/api/socket.ts';
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
import { daemonIdFromPublicKey, RELAY_CLOSE_CODES, utf8Bytes, utf8Text } from '../../../relay/src/lib/index.ts';
import { newDaemonIdentity } from '../../../relay/tests/support/identities.ts';
import { FakeObjectState, type FakeSocket, testRuntime } from '../../../relay/tests/support/workers-fakes.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  DaemonCarrierRouter,
  openRelaySession,
  type RelayCarrierSocket,
  relayResponse,
  relayTunnelRequest,
} from '../../src/lib/relay-carrier.ts';
import { redeemPairingOverRelay } from '../../src/lib/relay-pairing.ts';
import { RELAY_DATA_BYTE_BUDGET, type RelayClientSession, RelaySessionError } from '../../src/lib/relay-session.ts';
import type { DaemonFetch } from '../../src/lib/runtime-models.ts';
import { browserTerminalStreamAttach, type TerminalStream, terminalStreamPath } from '../../src/lib/web-terminals.ts';

const HOST = 'relay.example';
const RELAY_URL = `https://${HOST}`;
const DAEMON_URL = 'https://studio.example';
const DEVICE_TOKEN = 'fy_device_this-credential-must-never-reach-the-carrier';
const SECRET_ANSWER = 'the session list a relay operator may not read';
const PAIRING_CODE = '7F3K-Q2ND';
const DEVICE_NAME = 'Ferretry PWA';
/** A grant the pairing API's own schema accepts, because `paired.response` is validated by it. */
const MINTED_TOKEN = `fy_device_${'m'.repeat(43)}`;

const crypto = new WebCryptoRelayCrypto();

const environment: RelayEnvironment = {
  RENDEZVOUS: { idFromName: name => name, get: () => ({ fetch: async () => new Response(null) }) },
};

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/**
 * One dialled browser socket, as the two things the pump needs from it.
 *
 * The socket is read through a function rather than held, because a dial reaches the rendezvous a
 * turn after `dial` returns and the endpoint has to be registered before then — otherwise the very
 * first frame the rendezvous puts in its outbox has nobody to deliver it to.
 */
interface ClientEndpoint {
  socket(): FakeSocket | undefined;
  receiveBinary(bytes: Uint8Array): Promise<void>;
}

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
  #link: RelayLink | undefined;
  /**
   * EVERY CLIENT SOCKET THIS RENDEZVOUS IS HOLDING, not the most recent one.
   *
   * §14 has one tab hold a request session and a stream session on the SAME rendezvous at once, and
   * a single-socket pump cannot carry that: the second dial replaced the first, so the request
   * session that measured the carrier stopped receiving anything the moment a terminal attached. It
   * reads as a fixture detail and it is the protocol's own shape, so it is modelled rather than
   * worked around.
   */
  readonly #clients: ClientEndpoint[] = [];

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
      devices: { identifyDevice: token => (token === DEVICE_TOKEN || token === MINTED_TOKEN ? 'phone' : undefined) },
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
    // CAPTURED PER DIAL rather than read off the bridge: a session sends on the socket IT was given,
    // and a later dial must not silently redirect an earlier session's frames onto a newer socket.
    let mine: FakeSocket | undefined;
    const adapted: RelayCarrierSocket = {
      onOpen: null,
      onText: null,
      onBinary: null,
      onClose: null,
      send: bytes => {
        if (mine !== undefined) this.#toRendezvous(mine, bytes);
      },
      sendText: () => undefined,
      close: () => undefined,
    };
    this.#clients.push({
      socket: () => mine,
      receiveBinary: async bytes => await Promise.resolve(adapted.onBinary?.(bytes)),
    });
    this.#enqueue(async () => {
      await this.rendezvous.fetch(
        new Request(`${RELAY_URL}/v1/rendezvous/${daemonId}/client`, { headers: { Upgrade: 'websocket' } }),
      );
      mine = this.objectState.sockets.at(-1);
      adapted.onOpen?.();
      this.#drain();
      // A rendezvous no daemon holds closes the client socket during the upgrade
      // (§9, `4404`). Reporting that close is what turns it into a refusal the
      // browser can show rather than a socket that never says anything.
      if (mine?.closed != null) adapted.onClose?.(mine.closed.code ?? 0, mine.closed.reason ?? '');
    });
    return adapted;
  }

  /**
   * Wait until nothing is left to carry, AND until the endpoints have stopped reacting to it.
   *
   * AN EMPTY QUEUE IS NOT THE SAME AS A DELIVERED FRAME, and the difference is the browser's own
   * adapter: `driveRelaySession` wires `onBinary` as `bytes => void session.receiveBinary(bytes)`,
   * discarding the promise, because a `WebSocket` message handler has nowhere to return one to. So a
   * frame handed to this endpoint is decrypted and applied AFTER the task that delivered it resolved,
   * and a settle that returned at the first quiet moment read a live stream as one that had carried
   * nothing at all. Every case that awaited an answer hid this, because the answer was its own
   * promise; a stream frame has no promise to await, which is exactly what makes it a stream.
   *
   * So quiet has to be observed rather than caught once: the counter only reaches its target when
   * several consecutive turns pass with nothing enqueued, and any work at all resets it.
   */
  async settle(): Promise<void> {
    let quiet = 0;
    for (let spin = 0; spin < 1_000; spin += 1) {
      if (this.#running || this.#queue.length > 0) quiet = 0;
      else if (++quiet >= 8) return;
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
    const endpoints: (readonly [FakeSocket | undefined, (bytes: Uint8Array) => Promise<void> | void])[] = [
      ...this.#clients.map(client => [client.socket(), (bytes: Uint8Array) => client.receiveBinary(bytes)] as const),
      [this.#daemonSocket, (bytes: Uint8Array) => this.#link?.receiveBinary(bytes)] as const,
    ];
    for (const [socket, deliver] of endpoints) {
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

/**
 * WHICH SECRETS THE RENDEZVOUS COULD ACTUALLY READ, searched over the BYTES it handled.
 *
 * THE PREVIOUS SHAPE COULD NOT FAIL ON THE FRAMES IT EXISTED TO POLICE. It rendered each frame as
 * `utf8Text(bytes) ?? bytes.join(',')` and asked for a substring — and `utf8Text` decodes with
 * `fatal: true`, so a sealed record, whose ciphertext is essentially never valid UTF-8, became the
 * decimal text `"81,244,7,…"`. An ASCII needle can never appear in that, so every `not.containEql`
 * against a binary frame passed by construction. A credential riding in the unsealed part of a
 * binary frame — a path in an AAD header, a token spliced beside ciphertext — is exactly the leak
 * this file's headline claim is about, and it was the one shape the search could not see.
 *
 * So the haystack is the raw bytes and the needle is encoded, never the other way round. Each
 * secret is looked for as its UTF-8 bytes and as the ASCII of its base64 — the two encodings a leak
 * plausibly takes on a wire that carries base64url payloads — the same pair
 * `tests/e2e/support/relay-harness.ts` searches for, so the in-process tier and the compiled-browser
 * tier now make the same claim by the same method.
 *
 * A hit reports the LABEL and the frame index and NEVER the value: a leak report that printed the
 * credential would be a second copy of the defect it is reporting.
 */
const carrierLeaks = (
  /** Structural rather than the class, so the negative control below can hand it frames directly. */
  bridge: { readonly observed: readonly Uint8Array[] },
  secrets: Readonly<Record<string, string>>,
): readonly string[] => {
  const haystack = bridge.observed.map(bytes => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const leaks: string[] = [];
  for (const [label, secret] of Object.entries(secrets)) {
    // An empty needle is in every frame. Refuse it rather than report a leak nobody has.
    if (secret === '') throw new Error(`the leak search was given an empty needle for ${label}`);
    const needles = [Buffer.from(secret, 'utf8'), Buffer.from(Buffer.from(secret, 'utf8').toString('base64'), 'utf8')];
    for (const [index, frame] of haystack.entries()) {
      if (needles.some(needle => frame.includes(needle))) {
        leaks.push(`${label} appeared in relay-observable frame #${String(index)}`);
        break;
      }
    }
  }
  return leaks;
};

/**
 * The frames the rendezvous handled, as text, for a DIAGNOSTIC and never for a privacy claim.
 *
 * Kept apart from {@link carrierLeaks} on purpose. Text is what a person reads when a case fails;
 * it is not what an absence assertion may be made against, and collapsing the two is what produced
 * the vacuous search above.
 */
const carrierText = (bridge: { readonly observed: readonly Uint8Array[] }): string =>
  bridge.observed.map(bytes => utf8Text(bytes) ?? `<${String(bytes.byteLength)} sealed bytes>`).join('\0');

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
    should(bridge.observed.length).be.greaterThan(4);
    should(
      carrierLeaks(bridge, {
        'the device token': DEVICE_TOKEN,
        'the name of the credential field': 'deviceToken',
        'the answer body': SECRET_ANSWER,
        'the route the request asked for': '/v1/sessions',
      }),
    ).be.empty();
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

    should(carrierLeaks(bridge, { 'the device token': DEVICE_TOKEN })).be.empty();
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
    should(carrierLeaks(bridge, { 'the device token': DEVICE_TOKEN })).be.empty();
  });
});

describe('first pairing and live streams, through the real rendezvous', () => {
  /**
   * THE CLAIM THIS FEATURE EXISTS FOR, proved against all three real halves.
   *
   * A browser holding nothing but a QR's fingerprint and a two-minute code redeems it across a
   * rendezvous that can read neither, and comes out the other side with the device grant it needs to
   * reconnect. `docs/relay-protocol.md` §14 "Pairing sessions" is what is being demonstrated, and the
   * assertions that matter are the two the document is written around: the CODE and the DEVICE NAME
   * never appear in anything the rendezvous handled, and neither does the token it minted.
   */
  it('should redeem a first pairing without the carrier reading the code, the name or the token', async () => {
    const identity = await newDaemonIdentity();
    const bridge = new RelayBridge();
    const response = {
      deviceToken: MINTED_TOKEN,
      daemonId: identity.daemonId,
      daemonName: 'Studio',
      capabilities: [],
      carriers: [{ kind: 'relay' as const, url: RELAY_URL }],
    };
    let redeemed: { code: string; deviceName: string } | undefined;
    await bridge.admitDaemon(identity, answered('{}'), {
      redeemOverRelay: async attempt => {
        redeemed = { code: attempt.code, deviceName: attempt.deviceName };
        return { kind: 'paired', response };
      },
    });

    const paired = await redeemPairingOverRelay({
      crypto,
      seed: { daemonUrl: DAEMON_URL, daemonId: identity.daemonId, code: PAIRING_CODE },
      deviceName: DEVICE_NAME,
      rendezvous: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
      dial: () => bridge.dial(identity.daemonId),
      heartbeat: () => () => undefined,
    });
    await bridge.settle();

    // The daemon received exactly what the browser sent, so the exchange really happened.
    should(redeemed).eql({ code: PAIRING_CODE, deviceName: DEVICE_NAME });
    should(paired.deviceToken).equal(MINTED_TOKEN);
    // And the rendezvous carried every byte of it while reading none.
    should(
      carrierLeaks(bridge, {
        'the pairing code': PAIRING_CODE,
        'the device name the browser sent': DEVICE_NAME,
        'the minted device token': MINTED_TOKEN,
      }),
    ).be.empty();
  });

  /**
   * §14 makes success and refusal indistinguishable to an observer: "one sealed record, then the
   * same close". An operator who could count frames and tell a spent code from a wrong one would
   * have the oracle the single generic reason exists to deny them.
   */
  it('should give a refused pairing the same frame count as a successful one', async () => {
    const count = async (outcome: 'paired' | 'refused'): Promise<number> => {
      const identity = await newDaemonIdentity();
      const bridge = new RelayBridge();
      await bridge.admitDaemon(identity, answered('{}'), {
        redeemOverRelay: async () =>
          outcome === 'refused'
            ? { kind: 'refused' }
            : {
                kind: 'paired',
                response: {
                  deviceToken: MINTED_TOKEN,
                  daemonId: identity.daemonId,
                  daemonName: 'Studio',
                  capabilities: [],
                  carriers: [],
                },
              },
      });
      await redeemPairingOverRelay({
        crypto,
        seed: { daemonUrl: DAEMON_URL, daemonId: identity.daemonId, code: PAIRING_CODE },
        deviceName: DEVICE_NAME,
        rendezvous: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
        dial: () => bridge.dial(identity.daemonId),
        heartbeat: () => () => undefined,
      }).catch(() => undefined);
      await bridge.settle();
      return bridge.observed.length;
    };

    should(await count('refused')).equal(await count('paired'));
  });

  /**
   * The other half of the journey: the token a relayed pairing minted opens an ORDINARY session.
   *
   * §14 gives a pairing session no edge to serving — "A device that paired reconnects as an ordinary
   * request session with the token it was just issued" — so this is the reconnect, and it is the
   * proof that the grant crossing the sealed record is a grant the daemon actually honours.
   */
  it('should let the token a relayed pairing minted open an authenticated session', async () => {
    const identity = await newDaemonIdentity();
    const bridge = new RelayBridge();
    await bridge.admitDaemon(identity, answered(SECRET_ANSWER), {
      redeemOverRelay: async () => ({
        kind: 'paired',
        response: {
          deviceToken: MINTED_TOKEN,
          daemonId: identity.daemonId,
          daemonName: 'Studio',
          capabilities: [],
          carriers: [],
        },
      }),
    });
    const paired = await redeemPairingOverRelay({
      crypto,
      seed: { daemonUrl: DAEMON_URL, daemonId: identity.daemonId, code: PAIRING_CODE },
      deviceName: DEVICE_NAME,
      rendezvous: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
      dial: () => bridge.dial(identity.daemonId),
      heartbeat: () => () => undefined,
    });
    await bridge.settle();

    const session = await openRelaySession({
      crypto,
      dial: () => bridge.dial(identity.daemonId),
      daemon: daemonConnection({
        daemonId: identity.daemonId,
        baseUrl: DAEMON_URL,
        deviceToken: paired.deviceToken,
      }),
      method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
      heartbeat: () => () => undefined,
    });
    should(session.live()).be.true();
    should(carrierLeaks(bridge, { 'the grant the pairing just issued': paired.deviceToken })).be.empty();
  });
});

/* ---------- §14 stream sessions, as the app actually opens one -------------- */

/** A terminal identity `TerminalIdSchema` accepts, because `terminalStreamPath` parses what it is given. */
const TERMINAL_ID = 'a1b2c3d4e5f6';
const SESSION_ID = 'fy_studio_one';
/** The shell's own output: bytes, because §14 gives a terminal's daemon-to-browser direction bytes. */
const SHELL_OUTPUT = utf8Bytes('\x1b[2Jferretry@studio:~$ ');
const KEYSTROKES = utf8Bytes('ls -la\r');
/** The one text frame this route carries, and it goes the other way: the viewer's resize control. */
const RESIZE_CONTROL = JSON.stringify({ t: 'resize', cols: 120, rows: 40 });

/** One arrived client frame in the two shapes a stream handler actually reads, whatever the transport hands it. */
const clientFrame = (frame: SocketFrame): string | Uint8Array => {
  if (typeof frame === 'string') return frame;
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
};

interface RelayedTerminal {
  readonly bridge: RelayBridge;
  readonly stream: TerminalStream;
  readonly streamPath: string;
  /** The request the DAEMON's own socket route table was asked to decide. */
  readonly upgrade: () => ApiRequest | undefined;
  /** The live socket the daemon's handler was attached to, so a test can close from that end. */
  readonly downstream: () => SocketDownstream | undefined;
  readonly attached: () => number;
  readonly released: () => number;
  /** Everything the daemon's handler was handed by the viewer, in order. */
  readonly fromClient: readonly (string | Uint8Array)[];
  readonly opens: () => number;
  readonly received: readonly Uint8Array[];
  readonly closed: readonly { readonly code: number; readonly reason: string }[];
  readonly refused: readonly { readonly status: number; readonly body: string }[];
  /** Every URL the direct carrier's HTTP fetcher was asked for. A relayed terminal asks for none. */
  readonly overHttp: readonly string[];
}

/**
 * ONE RELAYED TERMINAL, OPENED THE WAY THE APP OPENS ONE.
 *
 * Nothing here short-circuits the carrier decision. `DaemonCarrierRouter` walks DIRECT first exactly
 * as §1 requires, the daemon's own address fails as a transport failure — which is the situation a
 * relay exists for and the one thing a browser cannot fake — and only then is the rendezvous the
 * measured carrier. The attach is `browserTerminalStreamAttach`, the same function the composition
 * root hands the terminal deck, so this rig exercises the production composition rather than a
 * hand-built stream session that would pass whatever the app did.
 *
 * WHICH IS THE POINT: `browserTerminalStreamAttach` falls back to a direct `wss://` when `openStream`
 * answers `null`, and that fallback first buys a socket ticket over HTTP. `overHttp` below refuses
 * that purchase and records it, so a composition that stopped putting terminals on the rendezvous
 * fails these cases loudly instead of quietly opening a socket at an address a relayed browser
 * cannot reach.
 */
const openRelayedTerminal = async (): Promise<RelayedTerminal> => {
  const identity = await newDaemonIdentity();
  const daemon = daemonConnection({
    daemonId: identity.daemonId,
    baseUrl: DAEMON_URL,
    deviceToken: DEVICE_TOKEN,
    carriers: [
      { kind: 'direct', daemonUrl: DAEMON_URL },
      { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
    ],
  });
  const scope = daemonSessionScope(daemon, SESSION_ID);
  const streamPath = terminalStreamPath(daemon, scope, TERMINAL_ID);

  const bridge = new RelayBridge();
  const fromClient: (string | Uint8Array)[] = [];
  let upgrade: ApiRequest | undefined;
  let downstream: SocketDownstream | undefined;
  let attached = 0;
  let released = 0;
  await bridge.admitDaemon(identity, answered('{}'), undefined, async request => {
    upgrade = request;
    if (request.path !== streamPath) return { outcome: 'unclaimed' } satisfies SocketUpgradeDecision;
    return {
      outcome: 'accepted',
      attach: async socket => {
        downstream = socket;
        return {
          open: async () => {
            attached += 1;
            // Produced by the handler rather than by the case, so what crosses is what a mounted
            // stream would have written: this bridge is `SocketDownstream` and nothing else.
            socket.send(SHELL_OUTPUT);
            await Promise.resolve();
          },
          fromClient: frame => fromClient.push(clientFrame(frame)),
          close: () => {
            released += 1;
          },
        };
      },
    } satisfies SocketUpgradeDecision;
  });

  const overHttp: string[] = [];
  const ticketFetch: DaemonFetch = async input => {
    overHttp.push(input.toString());
    throw new Error('a relayed terminal must not buy a socket ticket');
  };
  const router = new DaemonCarrierRouter({
    crypto,
    // The daemon's own address is offered and does not answer. §1's probe IS the request, and a
    // transport failure is what "not reachable" means — an HTTP status would not move the walk on.
    network: async () => {
      throw new TypeError('Failed to fetch');
    },
    dial: () => bridge.dial(identity.daemonId),
    heartbeat: () => () => undefined,
  });
  const measured = await router.send(daemon, `${DAEMON_URL}/v1/carriers`);
  await bridge.settle();
  should(measured.status).equal(200);
  should(router.activeMethod(daemon.daemonId)?.kind).equal('relay');

  const received: Uint8Array[] = [];
  const closed: { code: number; reason: string }[] = [];
  const refused: { status: number; body: string }[] = [];
  let opens = 0;
  const attach = browserTerminalStreamAttach(
    async (target, request) => await router.openStream(target, request),
    ticketFetch,
    () => router.activeMethod(daemon.daemonId),
  );
  const stream = await attach(daemon, scope, TERMINAL_ID, {
    onOpen: () => {
      opens += 1;
    },
    onBytes: bytes => received.push(bytes),
    onClosed: (code, reason) => closed.push({ code, reason }),
    onRefused: (status, body) => refused.push({ status, body }),
  });
  await bridge.settle();

  return {
    bridge,
    stream,
    streamPath,
    upgrade: () => upgrade,
    downstream: () => downstream,
    attached: () => attached,
    released: () => released,
    fromClient,
    opens: () => opens,
    received,
    closed,
    refused,
    overHttp,
  };
};

const bytesOf = (frame: string | Uint8Array | undefined): number[] =>
  typeof frame === 'string' ? [] : [...(frame ?? [])];

describe('a relayed terminal stream, browser to daemon, through the real rendezvous', () => {
  /**
   * THE OTHER HALF OF §14, AND THE ONE A REQUEST SESSION CANNOT STAND IN FOR.
   *
   * A relayed request is one record and one answer; a stream is a protocol switch that never
   * happened — "the socket IS the session" — carrying bytes in both directions for as long as the
   * viewer watches. This is that, end to end: the browser's `DaemonCarrierRouter` opening its own
   * stream session, the real rendezvous forwarding it, and the daemon's real `RelayLink` handing it
   * to the daemon's real socket route table.
   */
  it('should carry a terminal in both directions over the rendezvous the walk measured', async () => {
    const terminal = await openRelayedTerminal();

    // The DAEMON's own socket route table decided this, off a request the relay built and nothing
    // else. `loopback` false and a rate-limit identity minted from the SESSION are the two properties
    // that stop a relayed viewer being read as somebody standing at the machine.
    should(terminal.upgrade()?.path).equal(terminal.streamPath);
    should(terminal.upgrade()?.method).equal('GET');
    should(terminal.upgrade()?.headers.get('authorization')).equal(`Bearer ${DEVICE_TOKEN}`);
    should(terminal.upgrade()?.loopback).be.false();
    should(terminal.upgrade()?.clientAddress).match(/^relay-session:/u);
    should(terminal.attached()).equal(1);
    should(terminal.opens()).equal(1);
    should(terminal.refused).be.empty();
    // NOT ONE HTTP CALL. A direct fallback buys a ticket before it opens a socket, so an empty list
    // is what says this terminal is on the rendezvous rather than on a `wss://` at the daemon.
    should(terminal.overHttp).be.empty();

    // daemon → browser: the handler's own write, arriving as the bytes it wrote.
    should(terminal.received.length).equal(1);
    should(bytesOf(terminal.received[0])).eql([...SHELL_OUTPUT]);

    // browser → daemon: a keystroke run and one complete control frame, in that order.
    terminal.stream.write(KEYSTROKES);
    terminal.stream.control(RESIZE_CONTROL);
    await terminal.bridge.settle();

    should(terminal.fromClient.length).equal(2);
    should(bytesOf(terminal.fromClient[0])).eql([...KEYSTROKES]);
    should(terminal.fromClient[1]).equal(RESIZE_CONTROL);

    // ── and the assertion this whole file exists for, now for a live stream ──
    should(
      carrierLeaks(terminal.bridge, {
        'the device token': DEVICE_TOKEN,
        'the stream path the browser asked to open': terminal.streamPath,
        'the resize control the viewer sent': RESIZE_CONTROL,
        'what the shell printed': 'ferretry@studio',
      }),
    ).be.empty();
  });

  /**
   * §14: "a `bytes` record carries a run of an ordered byte stream … a terminal neither knows nor
   * cares whether a paste arrived as one write or three."
   *
   * A direct socket would put this on the wire as ONE frame, so a split that arrives as several
   * records and reassembles into the same run is evidence about the carrier and not only about the
   * terminal. The budget is the protocol package's own derivation on both ends: a client that split
   * at a number of its own would produce a record the daemon refuses with `4400`.
   */
  it('should split a paste larger than one record and deliver it as one byte run', async () => {
    const terminal = await openRelayedTerminal();
    const paste = new Uint8Array(RELAY_DATA_BYTE_BUDGET + 1).fill(0x61);

    terminal.stream.write(paste);
    await terminal.bridge.settle();

    should(terminal.fromClient.length).equal(2);
    should(bytesOf(terminal.fromClient[0]).length).equal(RELAY_DATA_BYTE_BUDGET);
    should(bytesOf(terminal.fromClient[1]).length).equal(1);
    should([...bytesOf(terminal.fromClient[0]), ...bytesOf(terminal.fromClient[1])]).eql([...paste]);
  });

  /**
   * The stream's OWN close code reaches the viewer, and the session's does not.
   *
   * §14 puts the close taxonomy inside the channel because it is content — a relay that could read
   * close reasons could read why viewers leave — and the daemon then ends the session with `4440`.
   * A viewer handed that `4440` would read it as a carrier that dropped and reconnect against a
   * stream the daemon deliberately ended, so `1013` arriving alone is the whole claim.
   */
  it('should end a relayed terminal with the stream code the daemon chose, not the session close', async () => {
    const terminal = await openRelayedTerminal();

    terminal.downstream()?.close(1013, 'stream reader fell behind');
    await terminal.bridge.settle();

    should(terminal.closed).eql([{ code: 1013, reason: 'stream reader fell behind' }]);
    should(terminal.released()).equal(1);
  });

  /**
   * And the same taxonomy in the other direction: a deliberate leave is never spelled as a network
   * failure, and the daemon releases the handler it attached rather than waiting for a socket that
   * is never going to drop.
   */
  it('should tell the daemon when the viewer leaves, and release what it attached', async () => {
    const terminal = await openRelayedTerminal();

    terminal.stream.close(1000, 'the viewer left this stream');
    await terminal.bridge.settle();

    should(terminal.released()).equal(1);
    should(terminal.closed).eql([{ code: 1000, reason: 'the viewer left this stream' }]);
    /**
     * THE LEAVE IS SEALED IN BOTH DIRECTIONS — and this assertion is here because it was not.
     *
     * `RelayClientSession.closeStream` (`src/lib/relay-session.ts`) seals `{t:'stream-close', code,
     * reason}`, which was always right. The daemon's answer to it was not: it interpolated that same
     * reason into the session's concluding CONTROL frame, and a control message is unsealed by
     * design because the rendezvous has to route it. So the reason a person stopped watching was
     * readable by the carrier, contradicting the invariant stated beside `RELAY_STREAM_CLOSES` in
     * that same file — "a relay that could read close reasons could read why people stop watching."
     *
     * `packages/daemon/src/lib/relay/link.ts` now concludes every session with
     * `RELAY_SESSION_CONCLUDED_CLOSE_REASON`, one protocol-owned string with nowhere to interpolate,
     * so `4440` says only that the session ended. The real code and reason have already crossed
     * inside the sealed record, which is what `4440` has always meant.
     *
     * THIS FOUND IT, AND THE OLD HELPER COULD NOT HAVE. Every frame it searched was rendered by
     * `utf8Text(bytes) ?? bytes.join(',')`, and a sealed frame is not valid UTF-8, so it compared an
     * ASCII needle against decimal digits and passed. The search is over raw bytes now, and the
     * negative control below is what proves it can still fail.
     */
    should(
      carrierLeaks(terminal.bridge, {
        'the reason the viewer gave': 'the viewer left this stream',
        'the device token': DEVICE_TOKEN,
        'what the shell printed': 'ferretry@studio',
      }),
    ).be.empty();
  });

  /**
   * THE NEGATIVE CONTROL, and without it every assertion above is a claim about a search nobody has
   * proved can fail.
   *
   * The search these cases rest on used to be blind to exactly one thing: a secret sitting in a
   * frame whose bytes are not valid UTF-8, which is every sealed record on the wire. So this feeds
   * the search a frame of that exact shape — a lone `0x80` continuation byte, which no UTF-8
   * decoder will accept, with an ASCII credential in the middle of it — and requires a hit. A
   * search that cannot find a needle it was handed directly is a search whose silence means
   * nothing, and this case turns that from an argument into a failure.
   *
   * The base64 needle is here for the same reason: §14 payloads travel base64url inside a JSON
   * envelope, so a credential leaking through a payload field arrives base64-encoded rather than
   * raw, and a search that only knew the raw form would miss the likelier of the two.
   */
  it('should find a secret hidden inside a frame no UTF-8 decoder will read', () => {
    // 0x80 is a continuation byte with no lead byte, and 0xff appears in no UTF-8 sequence at all,
    // so both frames below decode to nothing — the exact shape of every sealed record on the wire.
    const rawFrame = { observed: [Uint8Array.from([0x80, ...utf8Bytes(DEVICE_TOKEN), 0xff])] };
    const base64Frame = {
      observed: [Uint8Array.from([0x80, ...utf8Bytes(Buffer.from(DEVICE_TOKEN, 'utf8').toString('base64')), 0xff])],
    };

    // Unreadable as text — which is precisely why the text rendering may not carry a privacy claim.
    should(carrierText(rawFrame)).not.containEql(DEVICE_TOKEN);
    should(carrierText(base64Frame)).not.containEql(DEVICE_TOKEN);
    // And found anyway, in both of the encodings a leak plausibly takes.
    should(carrierLeaks(rawFrame, { 'the device token': DEVICE_TOKEN })).eql([
      'the device token appeared in relay-observable frame #0',
    ]);
    should(carrierLeaks(base64Frame, { 'the device token': DEVICE_TOKEN })).eql([
      'the device token appeared in relay-observable frame #0',
    ]);
    // A secret nothing carried is still absent, so the search is not simply answering "yes".
    should(carrierLeaks(rawFrame, { 'a credential nobody sent': MINTED_TOKEN })).be.empty();
    // An empty needle would match every frame ever recorded; the search refuses it rather than
    // reporting a leak that is an artefact of asking for nothing.
    should(() => carrierLeaks(rawFrame, { nothing: '' })).throw(/empty needle/u);
  });
});
