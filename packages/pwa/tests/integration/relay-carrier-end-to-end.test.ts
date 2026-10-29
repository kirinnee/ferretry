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
 * Every frame the rendezvous handled is kept, and the device id, its public key and the
 * request and answer bodies are searched for across all of them. If a relay can read a
 * session it is wrong however well it works.
 *
 * The three source halves are imported by relative path deliberately. A test that
 * imported a re-export of one of them could pass against a copy; these are the
 * files that ship.
 */

import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrowserInputEvent, BrowserScreencastFrame } from '@ferretry/protocol';
import should from 'should';
import { type ApiRequest, type ApiResponse, headersFrom } from '../../../daemon/src/lib/api/http.ts';
import type { SocketDownstream, SocketFrame, SocketUpgradeDecision } from '../../../daemon/src/lib/api/socket.ts';
import type { FrameClock } from '../../../daemon/src/lib/browser/transport/contracts.ts';
import type {
  BrowserViewerHost,
  ViewerAttachment,
} from '../../../daemon/src/lib/browser/transport/viewer-contracts.ts';
import { BrowserViewerStream } from '../../../daemon/src/lib/browser/transport/viewer-stream.ts';
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
import {
  daemonIdFromPublicKey,
  RELAY_CLOSE_CODES,
  toBase64Url,
  utf8Bytes,
  utf8Text,
} from '../../../relay/src/lib/index.ts';
import { newDaemonIdentity } from '../../../relay/tests/support/identities.ts';
import { FakeObjectState, type FakeSocket, testRuntime } from '../../../relay/tests/support/workers-fakes.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { daemonRequest } from '../../src/lib/daemon-transport.ts';
import {
  DaemonCarrierRouter,
  openRelaySession,
  type RelayCarrierSocket,
  relayResponse,
  relayTunnelRequest,
} from '../../src/lib/relay-carrier.ts';
import { redeemPairingInSession } from '../../src/lib/relay-pairing.ts';
import {
  RELAY_DATA_BYTE_BUDGET,
  type RelayClientSession,
  RelaySessionError,
  type SessionDeviceClaim,
} from '../../src/lib/relay-session.ts';
import { decodeRemoteBrowserFrame, remoteBrowserStreamSocketFactory } from '../../src/lib/remote-browser.ts';
import type { DaemonFetch } from '../../src/lib/runtime-models.ts';
import { browserTerminalStreamAttach, type TerminalStream } from '../../src/lib/web-terminals.ts';
import { startTypingPage, typingReachesThePage } from './support/real-chrome-typing.ts';

const HOST = 'relay.example';
const RELAY_URL = `https://${HOST}`;
const DAEMON_URL = 'https://studio.example';
/** The grant a session proves. An identity, not a credential — and still nothing a relay should read. */
const DEVICE_ID = 'fy_device_id_mustNeverReachCarrier1';
const SECRET_ANSWER = 'the session list a relay operator may not read';
const PAIRING_CODE = '7F3K-Q2ND';
const DEVICE_NAME = 'Ferretry PWA';
/** A grant id the pairing API's own schema accepts, because `paired.response` is validated by it. */
const MINTED_DEVICE_ID = 'fy_device_id_mintedByThePairing0001';

/**
 * HOW MANY CRYPTOGRAPHIC OPERATIONS ARE STILL RUNNING, on either end — the work {@link RelayBridge.settle}
 * cannot see in its queue.
 *
 * The browser's half of a session runs OUTSIDE the bridge: its adapter discards the promise of every
 * frame it is handed, so a key agreement, a device signature or a seal it starts in reply is invisible
 * to the queue. WebCrypto answers on a later task, and on a loaded runner that task can land after the
 * bridge has already counted itself quiet — the stream credential not yet sent, the daemon's viewer not
 * yet connected (run 40556779457, "expected undefined not to be undefined"). So every operation is
 * held while it runs, and a bridge is quiet only once none is.
 */
const cryptoInFlight = new Set<Promise<unknown>>();
const crypto: WebCryptoRelayCrypto = new Proxy(new WebCryptoRelayCrypto(), {
  get: (target, property) => {
    const member: unknown = Reflect.get(target, property);
    if (typeof member !== 'function') return member;
    return (...args: unknown[]) => {
      const result: unknown = member.apply(target, args);
      if (!(result instanceof Promise)) return result;
      const running: Promise<unknown> = result.finally(() => cryptoInFlight.delete(running));
      cryptoInFlight.add(running);
      return running;
    };
  },
});

/** A device key minted the way the browser mints one: non-extractable, real Ed25519. */
const mintDevice = async (deviceId: string) => {
  const minted = await crypto.generateDeviceKey();
  const claim: SessionDeviceClaim = {
    deviceId,
    key: crypto.deviceKeyHandle(minted.privateKey),
    appSession: toBase64Url(crypto.randomBytes(16)),
  };
  return { claim, publicKey: toBase64Url(minted.publicKeySpki), privateKey: minted.privateKey };
};

/** The one device every request and stream case below proves itself with. */
const DEVICE = await mintDevice(DEVICE_ID);
const AUTH = { kind: 'auth', device: DEVICE.claim } as const;

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
  /** The daemon's device registry as the link reads it: an id, and the ONE public key it may prove. */
  readonly deviceKeys = new Map<string, string>([[DEVICE_ID, DEVICE.publicKey]]);

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
    pairing: RelayPairingRedeemer = { redeemInSession: async () => ({ kind: 'refused' }) },
    sockets: RelayLinkDependencies['sockets'] = {
      upgrade: async () => ({ outcome: 'unclaimed' }),
      reauthorize: () => true,
    },
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
      devices: { deviceKey: async deviceId => this.deviceKeys.get(deviceId), seen: () => undefined },
      clock: { now: () => Date.now() },
      // No device is unpaired in these journeys, so nothing is ever ended through this.
      connections: { track: () => () => undefined },
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

  /** A socket to an address that does not answer: it closes `1006` before anything is said. */
  unreachable(): RelayCarrierSocket {
    const adapted: RelayCarrierSocket = {
      onOpen: null,
      onText: null,
      onBinary: null,
      onClose: null,
      send: () => undefined,
      sendText: () => undefined,
      close: () => undefined,
    };
    queueMicrotask(() => adapted.onClose?.(1006, 'the address did not answer'));
    return adapted;
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
   *
   * A cryptographic operation still running is not quiet either, whichever end started it (see
   * {@link cryptoInFlight}): the frame it produces is the next piece of work. It is AWAITED rather than
   * spun on, so a runner slow enough to stretch one operation over many turns is waited for, not counted
   * against the spin budget, and the count starts again from nothing once it has answered.
   */
  async settle(): Promise<void> {
    let quiet = 0;
    for (let spin = 0; spin < 1_000; spin += 1) {
      while (cryptoInFlight.size > 0) {
        await Promise.allSettled([...cryptoInFlight]);
        quiet = 0;
      }
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
      deviceId: DEVICE_ID,
    });
    const session: RelayClientSession = await openRelaySession({
      crypto,
      dial: () => bridge.dial(identity.daemonId),
      daemon,
      method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
      heartbeat: () => () => undefined,
      mode: AUTH,
    });
    should(session.live()).be.true();

    const response = relayResponse(
      await session.request(
        relayTunnelRequest(`${DAEMON_URL}/v1/sessions?sessionId=fy_one&sessionId=fy_two`, {
          // A header no browser holds a value for any more; sent anyway, to prove it never crosses.
          headers: { authorization: 'Bearer stale-value-from-an-old-app', 'content-type': 'application/json' },
        }),
      ),
    );
    await bridge.settle();

    should(response.status).equal(200);
    should(await response.text()).equal(SECRET_ANSWER);

    // The daemon served it out of its OWN route table, as the device the SESSION proved — never as
    // anything a header said — with the repeated query parameter an object could not have held.
    should(served?.path).equal('/v1/sessions');
    should(served?.query.get('sessionId')).eql(['fy_one', 'fy_two']);
    should(served?.headers.get('authorization')).be.undefined();
    should(served?.device).eql({ deviceId: DEVICE_ID, appSession: DEVICE.claim.appSession });
    should(served?.loopback).be.false();

    // ── and now the only assertion that makes any of it worth having ──
    should(bridge.observed.length).be.greaterThan(4);
    should(
      carrierLeaks(bridge, {
        'the device id': DEVICE_ID,
        'the device public key': DEVICE.publicKey,
        'the name of the credential field': 'deviceId',
        'the answer body': SECRET_ANSWER,
        'the route the request asked for': '/v1/sessions',
      }),
    ).be.empty();
    // The fingerprint IS visible, in the URL, because it is what addresses the
    // rendezvous. §10 discloses that rather than pretending otherwise.
    should(identity.daemonId.startsWith('fy_daemon_')).be.true();
  });

  it('should carry several photo-sized uploads and a poll at once on one session, every one answered', async () => {
    // The owner's failure, 2026-10-29: a batch of phone photos over the tunnel ended the session
    // "too many records waiting on credit" and every upload in it failed at once.
    const identity = await newDaemonIdentity();
    const bridge = new RelayBridge();
    const received = new Map<string, number>();
    await bridge.admitDaemon(identity, async request => {
      received.set(request.path, (await request.text()).length);
      return await answered('{"ok":true}')(request);
    });
    const session: RelayClientSession = await openRelaySession({
      crypto,
      dial: () => bridge.dial(identity.daemonId),
      daemon: daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID }),
      method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
      heartbeat: () => () => undefined,
      mode: AUTH,
    });
    // About three MiB of base64 each: forty-odd parts, more than one credit window.
    const photo = (index: number): string => JSON.stringify({ base64: String(index).repeat(3 * 1024 * 1024) });
    const uploads = [1, 2, 3].map(index =>
      session.request(
        relayTunnelRequest(`${DAEMON_URL}/v1/upload-${String(index)}`, { method: 'POST', body: photo(index) }),
      ),
    );
    const poll = session.request(relayTunnelRequest(`${DAEMON_URL}/v1/sessions`));
    const answers = await Promise.all([...uploads, poll]);
    await bridge.settle();

    should(answers.map(answer => answer.status)).eql([200, 200, 200, 200]);
    should(session.live()).be.true();
    for (const index of [1, 2, 3]) should(received.get(`/v1/upload-${String(index)}`)).equal(photo(index).length);
  }, 60_000);

  it('should refuse a daemon whose key is not the one the pairing pinned, without proving anything', async () => {
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
      deviceId: DEVICE_ID,
    });

    await should(
      openRelaySession({
        crypto,
        dial: () => bridge.dial(impostor.daemonId),
        daemon: pinnedElsewhere,
        method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
        heartbeat: () => () => undefined,
        mode: AUTH,
      }),
    ).be.rejected();
    await bridge.settle();

    should(carrierLeaks(bridge, { 'the device id': DEVICE_ID })).be.empty();
  });

  it('should refuse a session whose proof is by a key the daemon never registered for that id', async () => {
    const identity = await newDaemonIdentity();
    const bridge = new RelayBridge();
    await bridge.admitDaemon(identity, answered('never reached'));
    // Same id, a different key: what a stolen device id is worth now.
    const thief = await mintDevice(DEVICE_ID);
    const refusal = await openRelaySession({
      crypto,
      dial: () => bridge.dial(identity.daemonId),
      daemon: daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID }),
      method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
      heartbeat: () => () => undefined,
      mode: { kind: 'auth', device: thief.claim },
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    should((refusal as RelaySessionError).code).equal(RELAY_CLOSE_CODES.authRejected);
  });

  it('should refuse a client at a rendezvous no daemon holds rather than parking it', async () => {
    const identity = await newDaemonIdentity();
    const bridge = new RelayBridge();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
    });

    const refusal = await openRelaySession({
      crypto,
      dial: () => bridge.dial(identity.daemonId),
      daemon,
      method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
      heartbeat: () => () => undefined,
      mode: AUTH,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    should(refusal).be.instanceof(RelaySessionError);
    should((refusal as RelaySessionError).code).equal(RELAY_CLOSE_CODES.daemonAbsent);
    should(carrierLeaks(bridge, { 'the device id': DEVICE_ID })).be.empty();
  });
});

/**
 * A pairing redeemer that does what the daemon's does with an accepted attempt: refuse an unproven
 * one, and otherwise register the key it was handed under the grant it mints.
 */
const pairingThatRegisters = (
  bridge: RelayBridge,
  daemonId: string,
  observe: (attempt: { code: string; deviceName: string; deviceKey: string; proven: boolean }) => void = () =>
    undefined,
): RelayPairingRedeemer => ({
  redeemInSession: async attempt => {
    const proven = await attempt.prove();
    observe({ code: attempt.code, deviceName: attempt.deviceName, deviceKey: attempt.deviceKey, proven });
    if (!proven) return { kind: 'refused' };
    bridge.deviceKeys.set(MINTED_DEVICE_ID, attempt.deviceKey);
    return {
      kind: 'paired',
      response: {
        deviceId: MINTED_DEVICE_ID,
        daemonId,
        daemonName: 'Studio',
        capabilities: [],
        carriers: [{ kind: 'relay', url: RELAY_URL }],
        idleExpiryDays: 30,
      },
    };
  },
});

describe('first pairing and live streams, through the real rendezvous', () => {
  /**
   * THE CLAIM THIS FEATURE EXISTS FOR, proved against all three real halves.
   *
   * A browser holding nothing but a QR's fingerprint and a two-minute code redeems it across a
   * rendezvous that can read neither, and comes out the other side with the device grant it needs to
   * reconnect. `docs/relay-protocol.md` §14 "Pairing sessions" is what is being demonstrated, and the
   * assertions that matter are the ones the document is written around: the CODE, the DEVICE NAME and
   * the PUBLIC KEY being registered never appear in anything the rendezvous handled, and neither does
   * the grant it minted.
   */
  it('should redeem a first pairing without the carrier reading the code, the name, the key or the grant', async () => {
    const identity = await newDaemonIdentity();
    const bridge = new RelayBridge();
    const fresh = await mintDevice(MINTED_DEVICE_ID);
    let redeemed: { code: string; deviceName: string; deviceKey: string; proven: boolean } | undefined;
    await bridge.admitDaemon(
      identity,
      answered('{}'),
      pairingThatRegisters(bridge, identity.daemonId, attempt => {
        redeemed = attempt;
      }),
    );

    const paired = await redeemPairingInSession({
      crypto,
      seed: { daemonUrl: DAEMON_URL, daemonId: identity.daemonId, code: PAIRING_CODE },
      deviceName: DEVICE_NAME,
      method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
      publicKey: fresh.publicKey,
      key: fresh.claim.key,
      dial: () => bridge.dial(identity.daemonId),
      heartbeat: () => () => undefined,
    });
    await bridge.settle();

    // The daemon received exactly what the browser sent — and the session layer verified that the
    // browser HOLDS the key it registered, which is the half of pairing a code alone cannot prove.
    should(redeemed).eql({ code: PAIRING_CODE, deviceName: DEVICE_NAME, deviceKey: fresh.publicKey, proven: true });
    should(paired.deviceId).equal(MINTED_DEVICE_ID);
    // And the rendezvous carried every byte of it while reading none.
    should(
      carrierLeaks(bridge, {
        'the pairing code': PAIRING_CODE,
        'the device name the browser sent': DEVICE_NAME,
        'the public key being registered': fresh.publicKey,
        'the minted device id': MINTED_DEVICE_ID,
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
      await bridge.admitDaemon(
        identity,
        answered('{}'),
        outcome === 'refused'
          ? { redeemInSession: async () => ({ kind: 'refused' }) }
          : pairingThatRegisters(bridge, identity.daemonId),
      );
      const fresh = await mintDevice(MINTED_DEVICE_ID);
      await redeemPairingInSession({
        crypto,
        seed: { daemonUrl: DAEMON_URL, daemonId: identity.daemonId, code: PAIRING_CODE },
        deviceName: DEVICE_NAME,
        method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
        publicKey: fresh.publicKey,
        key: fresh.claim.key,
        dial: () => bridge.dial(identity.daemonId),
        heartbeat: () => () => undefined,
      }).catch(() => undefined);
      await bridge.settle();
      return bridge.observed.length;
    };

    should(await count('refused')).equal(await count('paired'));
  });

  /**
   * The other half of the journey: the KEY a relayed pairing registered opens an ORDINARY session.
   *
   * §14 gives a pairing session no edge to serving — a device that paired reconnects as an ordinary
   * request session, proving the key it just registered — so this is the reconnect, and it is the
   * proof that what crossed the sealed record is a grant the daemon actually honours.
   */
  it('should let the key a relayed pairing registered open an authenticated session', async () => {
    const identity = await newDaemonIdentity();
    const bridge = new RelayBridge();
    await bridge.admitDaemon(identity, answered(SECRET_ANSWER), pairingThatRegisters(bridge, identity.daemonId));
    const fresh = await mintDevice(MINTED_DEVICE_ID);
    const paired = await redeemPairingInSession({
      crypto,
      seed: { daemonUrl: DAEMON_URL, daemonId: identity.daemonId, code: PAIRING_CODE },
      deviceName: DEVICE_NAME,
      method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
      publicKey: fresh.publicKey,
      key: fresh.claim.key,
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
        deviceId: paired.deviceId,
      }),
      method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
      heartbeat: () => () => undefined,
      mode: { kind: 'auth', device: fresh.claim },
    });
    should(session.live()).be.true();
    should(carrierLeaks(bridge, { 'the grant the pairing just issued': paired.deviceId })).be.empty();

    // And the grant is the KEY, not the id: the same id with any other key opens nothing.
    const thief = await mintDevice(paired.deviceId);
    await should(
      openRelaySession({
        crypto,
        dial: () => bridge.dial(identity.daemonId),
        daemon: daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: paired.deviceId }),
        method: { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
        heartbeat: () => () => undefined,
        mode: { kind: 'auth', device: thief.claim },
      }),
    ).be.rejected();
  });
});

/* ---------- §14 stream sessions, as the app actually opens one -------------- */

/** A terminal identity `TerminalIdSchema` accepts, because the attach parses what it is given. */
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
  /** Every URL the router's plain network was asked for. A terminal asks it for nothing but liveness. */
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
 * There is no second, ticketed path any more: a terminal is a stream session on whichever carrier
 * the walk measured. `overHttp` records every plain-network call the router made, and the only one
 * allowed is the liveness read that follows a direct session failing — so a composition that bought a
 * ticket, or reached the daemon over plain HTTP, fails these cases loudly.
 */
const openRelayedTerminal = async (): Promise<RelayedTerminal> => {
  const identity = await newDaemonIdentity();
  const daemon = daemonConnection({
    daemonId: identity.daemonId,
    baseUrl: DAEMON_URL,
    deviceId: DEVICE_ID,
    carriers: [
      { kind: 'direct', daemonUrl: DAEMON_URL },
      { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
    ],
  });
  const scope = daemonSessionScope(daemon, SESSION_ID);
  const streamPath = `/v1/sessions/${encodeURIComponent(SESSION_ID)}/terminals/${TERMINAL_ID}/stream`;

  const bridge = new RelayBridge();
  const fromClient: (string | Uint8Array)[] = [];
  let upgrade: ApiRequest | undefined;
  let downstream: SocketDownstream | undefined;
  let attached = 0;
  let released = 0;
  await bridge.admitDaemon(identity, answered('{}'), undefined, {
    reauthorize: () => true,
    upgrade: async request => {
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
    },
  });

  const overHttp: string[] = [];
  const network: DaemonFetch = async input => {
    overHttp.push(input.toString());
    throw new TypeError('Failed to fetch');
  };
  const router = new DaemonCarrierRouter({
    preference: () => 'auto',
    crypto,
    deviceKey: async () => DEVICE.claim.key,
    network,
    // The daemon's own address is offered and does not answer, which is the situation a relay exists
    // for; every other dial reaches the rendezvous.
    dial: url => {
      if (new URL(url).hostname === new URL(DAEMON_URL).hostname) {
        const refused = bridge.unreachable();
        return refused;
      }
      return bridge.dial(identity.daemonId);
    },
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
  const attach = browserTerminalStreamAttach(async (target, request) => await router.openStream(target, request));
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
    should(terminal.upgrade()?.headers.get('authorization')).be.undefined();
    should(terminal.upgrade()?.device?.deviceId).equal(DEVICE_ID);
    should(terminal.upgrade()?.loopback).be.false();
    should(terminal.upgrade()?.clientAddress).match(/^relay-session:/u);
    should(terminal.attached()).equal(1);
    should(terminal.opens()).equal(1);
    should(terminal.refused).be.empty();
    // NOTHING OVER PLAIN HTTP but the one liveness read after direct failed: no ticket, no request.
    should(terminal.overHttp).eql([`${DAEMON_URL}/healthz`]);

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
        'the device id': DEVICE_ID,
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
        'the device id': DEVICE_ID,
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
    const rawFrame = { observed: [Uint8Array.from([0x80, ...utf8Bytes(DEVICE_ID), 0xff])] };
    const base64Frame = {
      observed: [Uint8Array.from([0x80, ...utf8Bytes(Buffer.from(DEVICE_ID, 'utf8').toString('base64')), 0xff])],
    };

    // Unreadable as text — which is precisely why the text rendering may not carry a privacy claim.
    should(carrierText(rawFrame)).not.containEql(DEVICE_ID);
    should(carrierText(base64Frame)).not.containEql(DEVICE_ID);
    // And found anyway, in both of the encodings a leak plausibly takes.
    should(carrierLeaks(rawFrame, { 'the device id': DEVICE_ID })).eql([
      'the device id appeared in relay-observable frame #0',
    ]);
    should(carrierLeaks(base64Frame, { 'the device id': DEVICE_ID })).eql([
      'the device id appeared in relay-observable frame #0',
    ]);
    // A secret nothing carried is still absent, so the search is not simply answering "yes".
    should(carrierLeaks(rawFrame, { 'a grant nobody sent': MINTED_DEVICE_ID })).be.empty();
    // An empty needle would match every frame ever recorded; the search refuses it rather than
    // reporting a leak that is an artefact of asking for nothing.
    should(() => carrierLeaks(rawFrame, { nothing: '' })).throw(/empty needle/u);
  });
});

/* ---------- the remote browser's live view, as the app opens it ------------- */

/** Pixels too large for one record, so the frame has to cross as several chunks. */
const PAGE_ID = 'page-relayed-7';
const PIXELS = Uint8Array.from({ length: RELAY_DATA_BYTE_BUDGET * 2 + 1234 }, (_, index) => (index * 7 + 3) & 0xff);
/** A run inside the pixels a relay must not be able to find, even though it forwarded all of them. */
const PIXEL_MARKER = 'FyRelayedPixelsMarker';
PIXELS.set(utf8Bytes(PIXEL_MARKER), 4_096);

const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** The browser session, as the daemon's viewer stream sees it: a frame source and an input sink. */
class ScreencastHost implements BrowserViewerHost {
  readonly dispatched: BrowserInputEvent[] = [];
  publish: ((frame: BrowserScreencastFrame) => void) | undefined;
  detached = 0;

  async attachViewer(_sessionId: string, onFrame: (frame: BrowserScreencastFrame) => void): Promise<ViewerAttachment> {
    this.publish = onFrame;
    return {
      detach: () => {
        this.detached += 1;
      },
    };
  }

  async dispatchHumanInput(_sessionId: string, input: BrowserInputEvent): Promise<void> {
    this.dispatched.push(input);
  }
}

const timerClock: FrameClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(handle) };
  },
};

describe('a relayed remote browser view, browser to daemon, through the real rendezvous', () => {
  /**
   * THE LIVE VIEW A PHONE ON 5G COULD NOT SEE.
   *
   * The viewer used to dial a ticketed WebSocket nobody could buy, so the display never streamed over
   * any carrier. Here it is the daemon's real `BrowserViewerStream` mounted on the daemon's real
   * `RelayLink`, the real rendezvous forwarding it, and the PWA's real stream socket — the one the
   * viewer component opens — reassembling frames larger than one record.
   */
  it('should stream browser frames larger than a record, skip an unchanged one, and carry input back', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [
        { kind: 'direct', daemonUrl: DAEMON_URL },
        { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
      ],
    });
    const scope = daemonSessionScope(daemon, SESSION_ID);
    const streamPath = `/v1/sessions/${encodeURIComponent(SESSION_ID)}/browser/stream`;
    const host = new ScreencastHost();
    const sentByDaemon: number[] = [];

    const bridge = new RelayBridge();
    await bridge.admitDaemon(identity, answered('{}'), undefined, {
      reauthorize: () => true,
      upgrade: async request => {
        if (request.path !== streamPath) return { outcome: 'unclaimed' } satisfies SocketUpgradeDecision;
        return {
          outcome: 'accepted',
          attach: async socket => {
            let viewer: BrowserViewerStream | undefined;
            const counted: SocketDownstream = {
              send: frame => {
                sentByDaemon.push(typeof frame === 'string' ? frame.length : frame.byteLength);
                return socket.send(frame);
              },
              close: (code, reason) => socket.close(code, reason),
              bufferedBytes: () => socket.bufferedBytes(),
            };
            return {
              // The composition root's own shape (`fyd.ts`): the viewer connects on open.
              open: async () => {
                viewer = await BrowserViewerStream.connect(host, SESSION_ID, counted, timerClock);
              },
              fromClient: frame => viewer?.fromClient(clientFrame(frame)),
              close: () => viewer?.close(),
            };
          },
        } satisfies SocketUpgradeDecision;
      },
    });

    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto,
      deviceKey: async () => DEVICE.claim.key,
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
      dial: url =>
        new URL(url).hostname === new URL(DAEMON_URL).hostname ? bridge.unreachable() : bridge.dial(identity.daemonId),
      heartbeat: () => () => undefined,
    });
    await router.send(daemon, `${DAEMON_URL}/v1/carriers`);
    await bridge.settle();
    should(router.activeMethod(daemon.daemonId)?.kind).equal('relay');

    const socket = remoteBrowserStreamSocketFactory(
      async (target, request) => await router.openStream(target, request),
    )(daemon, scope);
    const frames: ArrayBuffer[] = [];
    const closes: number[] = [];
    let opened = 0;
    socket.addEventListener('open', () => {
      opened += 1;
    });
    socket.addEventListener('message', event => {
      if (event instanceof MessageEvent && event.data instanceof ArrayBuffer) frames.push(event.data);
    });
    socket.addEventListener('close', event => {
      if (event instanceof CloseEvent) closes.push(event.code);
    });
    await bridge.settle();
    should(opened).equal(1);
    should(host.publish).be.a.Function();

    // daemon → browser: one frame bigger than a record, then the same pixels again, then a change.
    host.publish?.({ dataBase64: base64Of(PIXELS), width: 1280, height: 800, pageId: PAGE_ID });
    await bridge.settle();
    host.publish?.({ dataBase64: base64Of(PIXELS), width: 1280, height: 800, pageId: PAGE_ID });
    await bridge.settle();
    const changed = PIXELS.slice();
    changed[0] = 0xfe;
    host.publish?.({ dataBase64: base64Of(changed), width: 1280, height: 800, pageId: PAGE_ID });
    await bridge.settle();

    should(frames).have.length(2);
    const first = decodeRemoteBrowserFrame(frames[0] as ArrayBuffer);
    const second = decodeRemoteBrowserFrame(frames[1] as ArrayBuffer);
    should(first?.kind === 'tagged' && first.pageId).equal(PAGE_ID);
    should([...new Uint8Array(first?.jpegBytes ?? new ArrayBuffer(0))]).eql([...PIXELS]);
    should(new Uint8Array(second?.jpegBytes ?? new ArrayBuffer(0))[0]).equal(0xfe);
    // Every daemon write fit one record, and the unchanged frame cost nothing on the wire.
    should(sentByDaemon.every(size => size <= RELAY_DATA_BYTE_BUDGET)).be.true();
    should(sentByDaemon.length).equal(
      2 * Math.ceil((PIXELS.byteLength + 7 + PAGE_ID.length) / (RELAY_DATA_BYTE_BUDGET - 21)),
    );

    // browser → daemon: a person's input, one complete text record.
    socket.send(JSON.stringify({ kind: 'insertText', text: 'typed over the relay' }));
    await bridge.settle();
    should(host.dispatched).eql([{ kind: 'insertText', text: 'typed over the relay' }]);

    // A viewer leaving says so, and the daemon gives the page's viewer slot back.
    socket.close(1000, 'viewer detached');
    await bridge.settle();
    should(host.detached).equal(1);
    should(closes).be.empty();

    should(
      carrierLeaks(bridge, {
        'the device id': DEVICE_ID,
        'the page the viewer is watching': PAGE_ID,
        'the pixels on screen': PIXEL_MARKER,
        'what the person typed': 'typed over the relay',
        'the stream path': streamPath,
      }),
    ).be.empty();
  });
});

const TYPING_BURST = 8;

describe('typing in a relayed remote browser view, browser to a real Chrome, through the real rendezvous', () => {
  /**
   * THE SAME KEYBOARD, THE OTHER CARRIER. Every key of a US keyboard crosses the real rendezvous as
   * stream records into the daemon's real viewer stream and a real headless Chrome, and the page's
   * own field must end up holding exactly what was typed.
   */
  it('should deliver every printable key, the editing keys and composed text to the page exactly', async () => {
    const page = await startTypingPage(SESSION_ID);
    try {
      const identity = await newDaemonIdentity();
      const daemon = daemonConnection({
        daemonId: identity.daemonId,
        baseUrl: DAEMON_URL,
        deviceId: DEVICE_ID,
        carriers: [
          { kind: 'direct', daemonUrl: DAEMON_URL },
          { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
        ],
      });
      const scope = daemonSessionScope(daemon, SESSION_ID);
      const streamPath = `/v1/sessions/${encodeURIComponent(SESSION_ID)}/browser/stream`;
      let viewer: BrowserViewerStream | undefined;

      const bridge = new RelayBridge();
      await bridge.admitDaemon(identity, answered('{}'), undefined, {
        reauthorize: () => true,
        upgrade: async request => {
          if (request.path !== streamPath) return { outcome: 'unclaimed' } satisfies SocketUpgradeDecision;
          return {
            outcome: 'accepted',
            attach: async socket => ({
              open: async () => {
                viewer = await BrowserViewerStream.connect(page.browser, SESSION_ID, socket, timerClock);
              },
              fromClient: frame => viewer?.fromClient(clientFrame(frame)),
              close: () => viewer?.close(),
            }),
          } satisfies SocketUpgradeDecision;
        },
      });
      const router = new DaemonCarrierRouter({
        preference: () => 'auto',
        crypto,
        deviceKey: async () => DEVICE.claim.key,
        network: async () => {
          throw new TypeError('Failed to fetch');
        },
        dial: url =>
          new URL(url).hostname === new URL(DAEMON_URL).hostname
            ? bridge.unreachable()
            : bridge.dial(identity.daemonId),
        heartbeat: () => () => undefined,
      });
      await router.send(daemon, `${DAEMON_URL}/v1/carriers`);
      await bridge.settle();
      should(router.activeMethod(daemon.daemonId)?.kind).equal('relay');
      const socket = remoteBrowserStreamSocketFactory(
        async (target, request) => await router.openStream(target, request),
      )(daemon, scope);
      await bridge.settle();
      should(viewer).not.be.undefined();

      await typingReachesThePage(page, async events => {
        // A person types a few keys at a time; the rendezvous grants credit per record, so the
        // test lets it settle between small bursts instead of flooding it in one tick.
        for (let sent = 0; sent < events.length; sent += TYPING_BURST) {
          for (const event of events.slice(sent, sent + TYPING_BURST)) socket.send(JSON.stringify(event));
          await bridge.settle();
        }
        await viewer?.settled;
      });

      socket.close(1000, 'viewer detached');
      await bridge.settle();
    } finally {
      await page.close();
    }
  }, 120_000);
});

/* ---------- two machines that announce the same address ---------------------- */

/**
 * The address every daemon a phone pairs with over the hosted relay announces: its own loopback.
 * Two machines, one origin — so an origin can never say which machine a request is for.
 */
const LOOPBACK_URL = 'http://127.0.0.1:7431';

describe('two paired machines that share one loopback address, through the real rendezvous', () => {
  /**
   * The owner's blocker, reproduced end to end: "when I add 2 daemons (of two different machines), it
   * will show both machine as the later added one". Each machine is a real daemon link behind its own
   * rendezvous (one per fingerprint, as the hosted relay addresses them), the browser's real router
   * walks direct-then-relay for both, and each machine answers with its own name.
   */
  const twoMachines = async () => {
    const studio = await newDaemonIdentity();
    const laptop = await newDaemonIdentity();
    const bridges = new Map<string, RelayBridge>();
    const served = new Map<string, string[]>();
    for (const [identity, name] of [
      [studio, 'studio'],
      [laptop, 'laptop'],
    ] as const) {
      const bridge = new RelayBridge();
      const paths: string[] = [];
      served.set(name, paths);
      await bridge.admitDaemon(identity, async request => {
        paths.push(request.path);
        return await answered(JSON.stringify({ name }))(request);
      });
      bridges.set(identity.daemonId, bridge);
    }
    const paired = (identity: Awaited<ReturnType<typeof newDaemonIdentity>>) =>
      daemonConnection({
        daemonId: identity.daemonId,
        baseUrl: LOOPBACK_URL,
        deviceId: DEVICE_ID,
        carriers: [
          { kind: 'direct', daemonUrl: LOOPBACK_URL },
          { kind: 'relay', relayUrl: RELAY_URL, operator: 'hosted' },
        ],
      });
    const studioConnection = paired(studio);
    const laptopConnection = paired(laptop);
    const overHttp: string[] = [];
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto,
      deviceKey: async () => DEVICE.claim.key,
      network: async input => {
        overHttp.push(input.toString());
        throw new TypeError('Failed to fetch');
      },
      // The phone cannot reach either machine's loopback; every rendezvous dial reaches the room its
      // fingerprint addresses, exactly as the hosted relay routes it.
      dial: url => {
        const target = new URL(url);
        if (target.hostname === new URL(LOOPBACK_URL).hostname)
          return [...bridges.values()][0]?.unreachable() ?? new RelayBridge().unreachable();
        const fingerprint = decodeURIComponent(target.pathname.split('/')[3] ?? '');
        const bridge = bridges.get(fingerprint);
        if (bridge === undefined) throw new Error(`no rendezvous for ${fingerprint}`);
        return bridge.dial(fingerprint);
      },
      heartbeat: () => () => undefined,
    });
    // Newest first, the order the pairing registry lists them in: the laptop was added second.
    router.resolvePaired(() => [laptopConnection, studioConnection]);
    const settle = async () => await Promise.all([...bridges.values()].map(async bridge => await bridge.settle()));
    return { router, studioConnection, laptopConnection, served, overHttp, settle };
  };

  it('should carry each machine its own requests even though both live at the same address', async () => {
    const { router, studioConnection, laptopConnection, served, settle } = await twoMachines();

    const askStudio = daemonRequest(studioConnection, '/v1/machine');
    const askLaptop = daemonRequest(laptopConnection, '/v1/machine');
    should(askStudio.url).equal(askLaptop.url);

    const fromStudio = await router.fetch(askStudio.url, askStudio.init);
    await settle();
    const fromLaptop = await router.fetch(askLaptop.url, askLaptop.init);
    await settle();

    should(await fromStudio.json()).eql({ name: 'studio' });
    should(await fromLaptop.json()).eql({ name: 'laptop' });
    should(served.get('studio')).eql(['/v1/machine']);
    should(served.get('laptop')).eql(['/v1/machine']);
  });

  it('should refuse a request that does not say which of the two machines it is for', async () => {
    const { router, served, overHttp } = await twoMachines();

    await should(router.fetch(`${LOOPBACK_URL}/v1/machine`, {})).be.rejectedWith(/2 paired machines share/u);
    // Neither machine was asked, and nothing went to the plain network in its place.
    should(served.get('studio')).eql([]);
    should(served.get('laptop')).eql([]);
    should(overHttp).eql([]);
  });
});
