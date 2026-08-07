import { DaemonCarriersViewSchema, type PairingResponse, PairingResponseSchema } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { RelayCrypto } from '@ferretry/relay';
import { publishedConnectionMethods } from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  bundledRelayDirectory,
  type HostedRelayFallback,
  readHostedRelayFallback,
} from '../features/onboarding/hosted-relay.ts';
import { readAccountPickerCatalog, readAccountPickerHealth } from './account-picker-catalog.ts';
import { DaemonAccountPickerStore } from './account-picker-store.ts';
import { DaemonHttpTransport, daemonApiClient } from './api-client.ts';
import { browserLoginPort, DaemonBrowserLoginStore } from './browser-login.ts';
import {
  type DaemonConnectionRepository,
  DaemonConnectionStore,
  type DaemonConnectionsSnapshot,
} from './connections.ts';
import { browserControlsStorage, DaemonControlsStore } from './controls.ts';
import { type DaemonConnection, type DaemonId, sameDaemonConnection } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import { DaemonEventTransport, daemonEventTicket } from './event-transport.ts';
import { documentDraftStore } from './drafts.ts';
import { type DaemonFleetPort, DaemonFleetStore } from './fleet-store.ts';
import { DaemonNotificationPreferences } from './notification-preferences.ts';
import { type PairingSeed, pairedDaemonConnection } from './pairing.ts';
import { DaemonPinClient } from './pin-client.ts';
import { redeemPairingOverRelay, relayPairingCandidates } from './relay-pairing.ts';
import { RelayPairingRefusedError } from './relay-session.ts';
import { DaemonProjectsStore, daemonProjectsPort } from './projects-store.ts';
import { DaemonPushDevices, type DaemonPushService, daemonPushService } from './push-enrolment.ts';
import { DaemonCarrierRouter, type RelayDial } from './relay-carrier.ts';
import { browserFetch, type DaemonFetch } from './runtime-models.ts';
import { SttSettingsStore } from './stt/stt-settings.ts';
import { DaemonUsageStore, daemonUsagePort } from './usage-store.ts';

const CONNECTION_DATABASE = 'ferretry-pwa';
const CONNECTION_OBJECT_STORE = 'connections';

/**
 * The landing page reads just this synchronous, content-free hint to decide
 * whether opening the app is more useful than repeating the product pitch. It
 * is never a pairing record: no daemon address, identity, or credential enters
 * localStorage.
 */
export const LANDING_MARKER_KEY = 'fy-has-pairings-v1';
const PAIRED_MARKER = '1';

export interface LandingMarkerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Safely finds browser storage without making a storage refusal fatal to the app. */
const browserLandingMarkerStorage = (): LandingMarkerStorage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** Mirrors only the empty/non-empty shape of the runtime pairing registry. */
export const syncLandingMarker = (storage: LandingMarkerStorage | undefined, pairingCount: number): void => {
  if (storage === undefined) return;
  try {
    if (pairingCount > 0) storage.setItem(LANDING_MARKER_KEY, PAIRED_MARKER);
    else storage.removeItem(LANDING_MARKER_KEY);
  } catch {
    // Private browsing and storage policies must fail open to the landing page.
  }
};

const requestResult = <T,>(request: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });

/** Browser persistence for the runtime pairing registry. */
export class IndexedDbConnectionRepository implements DaemonConnectionRepository {
  readonly #database: Promise<IDBDatabase>;

  constructor(factory: IDBFactory, databaseName = CONNECTION_DATABASE) {
    this.#database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CONNECTION_OBJECT_STORE)) {
          request.result.createObjectStore(CONNECTION_OBJECT_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('could not open the pairing database'));
      request.onblocked = () => reject(new Error('the pairing database upgrade is blocked'));
    });
  }

  async load(key: string): Promise<string | null> {
    const database = await this.#database;
    const transaction = database.transaction(CONNECTION_OBJECT_STORE, 'readonly');
    const value = await requestResult(transaction.objectStore(CONNECTION_OBJECT_STORE).get(key));
    return typeof value === 'string' ? value : null;
  }

  async save(key: string, value: string): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction(CONNECTION_OBJECT_STORE, 'readwrite');
    transaction.objectStore(CONNECTION_OBJECT_STORE).put(value, key);
    await transactionComplete(transaction);
  }
}

/** Returns no repository when storage is unavailable; pairing still works for this tab. */
export const browserConnectionRepository = (
  factory: IDBFactory | undefined = globalThis.indexedDB,
): DaemonConnectionRepository | undefined =>
  factory === undefined ? undefined : new IndexedDbConnectionRepository(factory);

type ConnectDaemonClient = (daemon: DaemonConnection) => Promise<FyApiClient>;

interface ClientEntry {
  readonly connection: DaemonConnection;
  readonly client: Promise<FyApiClient>;
}

/** One typed client promise per live pairing, fenced across re-pairing. */
export class DaemonApiPool {
  readonly #entries = new Map<DaemonId, ClientEntry>();

  constructor(private readonly connect: ConnectDaemonClient = daemonApiClient) {}

  client(daemon: DaemonConnection): Promise<FyApiClient> {
    const current = this.#entries.get(daemon.daemonId);
    if (current !== undefined && sameDaemonConnection(current.connection, daemon)) return current.client;

    const client = this.connect(daemon);
    const entry = { connection: daemon, client };
    this.#entries.set(daemon.daemonId, entry);
    void client.catch(() => {
      if (this.#entries.get(daemon.daemonId) === entry) this.#entries.delete(daemon.daemonId);
    });
    return client;
  }

  clearDaemon(daemonId: DaemonId): void {
    this.#entries.delete(daemonId);
  }
}

const pairingFailure = async (response: Response): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { readonly error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : `Pairing failed (HTTP ${response.status})`;
};

/** How this browser names itself to a daemon it is asking to trust it. */
const PAIRING_DEVICE_NAME = 'Ferretry PWA';

/**
 * How long the DIRECT half of a redemption may spend before the walk moves on.
 *
 * Short on purpose. It is not a budget for a slow daemon — a daemon that is reachable answers a
 * `POST /v1/pair` in milliseconds on a LAN — it is the point at which "this address is not answering"
 * becomes the more useful conclusion. The code it is spending has a two-minute life, and the
 * rendezvous attempt behind this one needs a socket, a handshake and a sealed exchange of its own.
 */
const DIRECT_PAIRING_TIMEOUT_MS = 4_000;

export interface ExchangePairingOptions {
  readonly fetcher?: DaemonFetch;
  readonly hostedRelayUrl?: string;
  /** WebCrypto by default. Needed only when a redemption falls back to a rendezvous. */
  readonly relayCrypto?: RelayCrypto;
  /** The browser WebSocket by default. Injected so no suite opens one. */
  readonly relayDial?: RelayDial;
  /** `DIRECT_PAIRING_TIMEOUT_MS` by default. A parameter so a suite can prove the deadline in ms. */
  readonly directTimeoutMs?: number;
}

/**
 * What the direct attempt established, as the facts a walk has to tell apart.
 *
 * `answered` means the DAEMON judged this code and the answer is final — an expired code, a spent
 * budget, a response that would not parse. `unreachable` means nothing reached it, which is the
 * outcome a rendezvous can help with. Modelled as a result rather than as exception classes because
 * the distinction IS this function's answer, and an answer is a return value.
 *
 * `ambiguous` IS THE THIRD FACT, AND IT USED TO BE FOLDED INTO `unreachable` INCORRECTLY. The catch
 * below read every failure — the deadline's own abort included — as "nothing reached the daemon".
 * That is true of a refused connection and a DNS failure; it is not true of a fetch this walk itself
 * cancelled at four seconds. A reachable-but-slow daemon — a tailnet, a loaded host, the persistence
 * await inside the pairing service's own `grant` — can receive `POST /v1/pair`, consume the code and
 * mint a device while this side has already given up waiting for the answer. The walk then carries
 * the same single-use code to the rendezvous and is told, correctly, that it is spent.
 *
 * It advances the walk exactly as `unreachable` does, because the relay really is worth trying: the
 * daemon may equally have received nothing. What it changes is what a reader is told when the relay
 * leg then reports a sealed refusal — see `exchangePairing`. A code this walk merely FAILED to
 * redeem and a code it may have redeemed under a name nobody can see are different problems with
 * different remedies, and only one of them leaves a device paired.
 */
type DirectRedemption =
  | { readonly kind: 'paired'; readonly response: PairingResponse }
  | { readonly kind: 'answered'; readonly error: Error }
  | { readonly kind: 'unreachable'; readonly error: Error }
  | { readonly kind: 'ambiguous'; readonly error: Error };

/**
 * A sealed refusal that arrived after THIS walk cancelled its own direct attempt.
 *
 * A subclass rather than a new class, deliberately: the daemon genuinely refused, so every consumer
 * that asks "was this a refusal or a transport failure" — `pairing-screen.tsx` is the one that
 * matters — must keep getting `refusal` and must keep telling the reader to mint a fresh code. What
 * this adds is the half that screen cannot know: minting again is necessary and may not be
 * sufficient, because a device may already be paired under a grant nobody holds.
 *
 * It is not exported. Nothing outside this module needs to distinguish it — the message is the
 * whole payload — and an export whose only consumer is a test is an export the dead-code gate is
 * right to refuse.
 */
class AmbiguousDirectPairingError extends RelayPairingRefusedError {
  constructor(refusal: unknown) {
    super();
    this.name = 'AmbiguousDirectPairingError';
    // The sealed refusal that prompted this, kept on the standard field rather than a second one.
    this.cause = refusal;
    this.message =
      'this pairing code is spent, and the direct attempt to this daemon may be what spent it: it was ' +
      'cancelled after four seconds without an answer, so the daemon may have completed that pairing ' +
      'and issued a device token this browser never received. Check the daemon for a device you do not ' +
      'recognise and revoke it, then run `fy pair` for a fresh code.';
  }
}

/**
 * The direct half: one reader-supplied, single-use fragment code, exchanged with its own daemon.
 *
 * Unrouted on purpose and it stays that way. A relayed session is opened with a credential this
 * exchange has not issued yet, so this request cannot go through the carrier router — and routing a
 * RE-pair through an existing session would exchange a fresh code under the credential it replaces.
 */
/**
 * The direct half's deadline, as the one signal a fetch can take plus the timer it owes back.
 *
 * `AbortSignal.timeout` is the right primitive when the runtime ships it, but it is not universal —
 * older browsers and some embedded webviews provide `AbortController` without the static — and the
 * unguarded call the walk used to make threw a `TypeError` BEFORE `fetcher` was reached, so a
 * reachable direct daemon answered nothing and the catch below misread a capability gap as transport
 * unreachable. Prefer the native static when present; otherwise arm a controller and a timer, and
 * hand back the clear that has to run once the fetch has settled so the fallback timer is not left
 * armed behind a request that already answered. An actual abort stays an abort — this only decides
 * how the deadline is built, not how its firing is read.
 */
const directDeadline = (timeoutMs: number): { readonly signal: AbortSignal; readonly clear: () => void } => {
  const native = (AbortSignal as { timeout?: (delay: number) => AbortSignal }).timeout;
  if (typeof native === 'function') {
    return { signal: native.call(AbortSignal, timeoutMs), clear: () => undefined };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
};

async function exchangePairingDirect(
  seed: PairingSeed,
  fetcher: DaemonFetch,
  timeoutMs: number,
): Promise<DirectRedemption> {
  const endpoint = new URL('/v1/pair', `${seed.daemonUrl}/`);
  const deadline = directDeadline(timeoutMs);
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: seed.code, deviceName: PAIRING_DEVICE_NAME }),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      // A BLACKHOLED ADDRESS IS THE FEATURE'S HEADLINE CASE, AND IT DOES NOT REJECT ON ITS OWN.
      // §14 exists so a phone off the LAN can pair, and a daemon's advertised address is typically a
      // private one — from cellular those packets are DROPPED rather than refused, so a browser sits
      // in SYN retransmit for tens of seconds to minutes before this fetch rejects. Until it does the
      // walk has not reached a rendezvous at all and the screen says only "pairing". Meanwhile the
      // code's own life is two minutes, so an unbounded direct attempt can outlive the credential the
      // walk was going to redeem. Every other leg of this feature has a deadline — `driveRelaySession`
      // arms one before a session opens, and calls a carrier that neither answers nor closes "a
      // refusal, not a wait" — and this was the one place that rule was not applied. The signal itself
      // comes from `directDeadline` above, which keeps this leg working on a runtime without the
      // `AbortSignal.timeout` static rather than throwing before the fetch.
      signal: deadline.signal,
    });
  } catch (reason) {
    // AN ABORT IS NOT THE SAME FACT AS A REFUSED CONNECTION, and reading it as one is what this
    // branch used to do. Both advance the walk — neither is `answered`, because the daemon has
    // stated nothing to this browser — but only one of them proves the request never landed. The
    // signal is this walk's own and nothing else aborts it, so `aborted` here means the deadline
    // fired: the fetch was cancelled mid-flight and the daemon's side of it is unobserved. See
    // `DirectRedemption` for what that costs and `exchangePairing` for who is told about it.
    const error = reason instanceof Error ? reason : new Error(String(reason));
    return { kind: deadline.signal.aborted ? 'ambiguous' : 'unreachable', error };
  } finally {
    // The fallback controller's timer is cleared whether the fetch answered, refused, or aborted, so
    // a settled request leaves no armed timer behind. The native static owns no clearable timer, and
    // clearing one that has already fired is a no-op.
    deadline.clear();
  }
  if (!response.ok) return { kind: 'answered', error: new Error(await pairingFailure(response)) };
  const value = PairingResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!value.success) return { kind: 'answered', error: new Error('the daemon returned an invalid pairing response') };
  return { kind: 'paired', response: value.data };
}

/**
 * Exchanges one reader-supplied, single-use fragment code — over whichever carrier reaches its daemon.
 *
 * THE WALK IS §1'S, AND PAIRING IS NO LONGER ITS EXCEPTION: direct first, always; then the one
 * rendezvous this build discovered for itself from the hosted directory advertisement. The link names
 * none — see `relayPairingCandidates` for the candidate that was built there and deferred. Only a
 * TRANSPORT failure advances the walk. A daemon that answered — `409`, `429`, a schema refusal — is
 * reachable and saying so, and carrying the same single-use code to a rendezvous after that would
 * spend a second attempt from a five-guess budget to be told the same thing.
 *
 * A SEALED REFUSAL ENDS THE WALK TOO, for the same reason and one layer in. §14: "A sealed
 * `pair-refused` is the opposite: the exchange happened, the answer is final for that attempt." It
 * arrives as its own error class precisely so this loop cannot mistake it for a carrier that did not
 * work. WHAT the reader is told about that refusal depends on how the direct leg ended: a refusal
 * after an attempt this walk CANCELLED at its own deadline may be the walk reporting on a pairing it
 * caused, so that one case carries the extra sentence and the extra remedy. See
 * `AmbiguousDirectPairingError`.
 *
 * WHAT IS REPORTED WHEN EVERYTHING FAILS is the FIRST failure, not the last. The direct attempt is
 * the one whose answer a reader can act on — "that code is expired" — while the relay attempts that
 * followed it are a browser's own recovery, and reporting "the rendezvous did not answer" to somebody
 * whose real problem is an expired code sends them to fix their network.
 */
export async function exchangePairing(
  seed: PairingSeed,
  fetcherOrOptions: DaemonFetch | ExchangePairingOptions = browserFetch,
  hostedRelayUrlArgument?: string,
): Promise<DaemonConnection> {
  const options: ExchangePairingOptions =
    typeof fetcherOrOptions === 'function'
      ? {
          fetcher: fetcherOrOptions,
          ...(hostedRelayUrlArgument === undefined ? {} : { hostedRelayUrl: hostedRelayUrlArgument }),
        }
      : fetcherOrOptions;
  const fetcher = options.fetcher ?? browserFetch;
  const hostedRelayUrl = options.hostedRelayUrl;
  const direct = await exchangePairingDirect(seed, fetcher, options.directTimeoutMs ?? DIRECT_PAIRING_TIMEOUT_MS);
  if (direct.kind === 'paired') return pairedDaemonConnection(seed, direct.response, hostedRelayUrl);
  if (direct.kind === 'answered') throw direct.error;

  for (const rendezvous of relayPairingCandidates(seed, hostedRelayUrl)) {
    let response: PairingResponse;
    try {
      response = await redeemPairingOverRelay({
        crypto: options.relayCrypto ?? new WebCryptoRelayCrypto(),
        seed,
        deviceName: PAIRING_DEVICE_NAME,
        rendezvous,
        ...(options.relayDial === undefined ? {} : { dial: options.relayDial }),
      });
    } catch (reason) {
      // A sealed refusal is the DAEMON's answer and ends the walk; anything else is this rendezvous
      // not working, which is the next one's turn.
      //
      // A REFUSAL THAT FOLLOWS AN AMBIGUOUS DIRECT ATTEMPT IS REPORTED DIFFERENTLY, and it is the
      // one sequence where "that code is spent" is an incomplete answer. This walk cancelled its own
      // direct POST at the deadline without seeing how the daemon answered it, then presented the
      // same single-use code here and was told it is gone. The likeliest two explanations are that
      // the code expired or was already used by somebody else — and that the CANCELLED attempt is
      // what used it, in which case the daemon has minted a device token this browser never
      // received and there is now a paired device nobody holds. Only the reader can tell which, and
      // only if they are told to look.
      if (reason instanceof RelayPairingRefusedError) {
        throw direct.kind === 'ambiguous' ? new AmbiguousDirectPairingError(reason) : reason;
      }
      continue;
    }
    // Deliberately outside the catch above: a response that paired but named no rendezvous this
    // browser crossed is a decided outcome, not a carrier that failed. The grant exists and this
    // device is discarding it, and dialling the next rendezvous would mint a second one to discard.
    return pairedDaemonConnection(seed, response, hostedRelayUrl, rendezvous);
  }
  throw direct.error;
}

export interface AppStore {
  readonly connections: DaemonConnectionStore;
  readonly clients: DaemonApiPool;
  readonly fleet: DaemonFleetStore;
  readonly controls: DaemonControlsStore;
  readonly projects: DaemonProjectsStore;
  readonly accountPicker: DaemonAccountPickerStore;
  readonly usage: DaemonUsageStore;
  readonly pins: DaemonPinClient;
  readonly browserLogin: DaemonBrowserLoginStore;
  readonly stt: SttSettingsStore;
  readonly notificationPreferences: DaemonNotificationPreferences;
  readonly pushDevices: DaemonPushDevices;
  /**
   * The daemon push API bound to the SAME fetcher as every other daemon call.
   * Built here rather than by the root because a root that injects a fetcher —
   * a suite, or a future offline shell — would otherwise get the real network
   * for enrolment alone, which is the one call that hands a daemon an endpoint.
   */
  readonly pushService: DaemonPushService;
  /**
   * WHICH CARRIER EACH DAEMON'S TRAFFIC IS ON, and the thing that puts it there.
   *
   * Direct first, the relay as the automatic fallback, and a sentence naming which
   * won and why the other did not — `docs/relay-protocol.md` §1. Read `choice()` for
   * the disclosure; call nothing else on it from a surface.
   */
  readonly carrier: DaemonCarrierRouter;
  readonly pair: (seed: PairingSeed) => Promise<DaemonConnection>;
  /**
   * Whether Ferretry's default relay is advertising itself right now.
   *
   * Bound to the SAME injected fetcher as pairing and push, for the same reason:
   * a suite or an offline shell that injects a fetcher must not get the real
   * network back for one read. Never throws — "could not find out" is a state.
   */
  readonly readDefaultRelay: () => Promise<HostedRelayFallback>;
}

export interface CreateAppStoreOptions {
  readonly repository?: DaemonConnectionRepository;
  readonly fetcher?: DaemonFetch;
  readonly connectClient?: ConnectDaemonClient;
  /** A deliberately content-free hint used only by the static landing page. */
  readonly landingMarkerStorage?: LandingMarkerStorage;
  /** WebCrypto by default. Injected only so a suite can carry a session deterministically. */
  readonly relayCrypto?: RelayCrypto;
  /** The browser WebSocket by default. Injected so no suite opens one. */
  readonly relayDial?: RelayDial;
}

/**
 * The origin a daemon's requests are built against.
 *
 * `baseUrl` is already normalised to an origin by `daemonBaseUrl`, so this is a
 * total function — but it is written as one place rather than inline so the router's
 * lookup and the request builder can never disagree about what "the same daemon"
 * means.
 */
const daemonOrigin = (daemon: DaemonConnection): string => daemon.baseUrl;

/** Builds the document-lifetime stores and registers every daemon cache together. */
export async function createAppStore(options: CreateAppStoreOptions = {}): Promise<AppStore> {
  const fetcher = options.fetcher ?? browserFetch;
  // Every DAEMON-BOUND call goes through the carrier router; the two that are not
  // bound to a paired daemon — the pairing exchange and the relay advertisement —
  // keep the raw fetcher on purpose.
  //
  // PAIRING KEEPS IT BECAUSE ITS RELAYED PATH IS NOT A ROUTED REQUEST, and this
  // comment used to say the opposite: that a relayed session is opened with the grant
  // pairing has not issued yet, "so it cannot be relayed". §14 built a pairing
  // session and `exchangePairing` below walks one — in the same file that claimed it
  // could not. What is true is narrower: a redemption cannot travel the ROUTER,
  // because the router's sessions are opened with a device token this exchange is
  // what mints. So the direct leg takes the raw fetcher and the relayed leg is
  // `redeemPairingOverRelay`'s own sealed pre-auth session, dialled without it.
  // Routing a RE-pair through an existing session would also exchange a fresh code
  // under the credential it is replacing.
  const readDefaultRelay = async (): Promise<HostedRelayFallback> =>
    // The directory origin is the build constant and nothing else: no literal, no
    // relative path, no guess. Unset ships no directory and answers without
    // dialling, which is what a local build or a fork honestly is.
    await readHostedRelayFallback({ directoryUrl: bundledRelayDirectory(), fetcher });

  /**
   * Discovery labels a published relay, and is the last resort for a daemon that publishes none.
   *
   * The address set is daemon-authored on pairing and `/v1/carriers`, and this read is never written
   * into it. It has two uses, both of them read-only: saying whether a published URL is Ferretry's
   * hosted service, and standing in as a dial-time fallback for a daemon too old to publish a set at
   * all — which would otherwise lose the hosted path it has always been reached over, with no
   * connection left that could teach it back. Read ONCE per document, so `relayUrl: null` withdraws
   * it on the next load rather than being remembered.
   */
  const hostedRelayUrl = readDefaultRelay().then(fallback =>
    fallback.kind === 'available' ? fallback.relayUrl : undefined,
  );

  // One adapter for the document, shared by the carrier router and by a redemption that has to fall
  // back to a rendezvous. A second instance would be harmless and is still worth not having: it is
  // the same WebCrypto either way, and one value is one thing a suite has to replace.
  const relayCrypto = options.relayCrypto ?? new WebCryptoRelayCrypto();
  const carrier = new DaemonCarrierRouter({
    network: fetcher,
    crypto: relayCrypto,
    ...(options.relayDial === undefined ? {} : { dial: options.relayDial }),
    // The same one-per-load promise both other readers await; the router waits on it only after a
    // daemon's own carriers have all failed, so nothing on the ordinary path pays for the read.
    hostedRelay: async () => await hostedRelayUrl,
  });
  const carried = carrier.fetch;
  /**
   * THE TYPED CLIENT TRAVELS THE CARRIER TOO, and it did not used to.
   *
   * `daemonApiClient`'s default transport dials the daemon's own address directly,
   * so everything built on the typed client — the fleet list, a session read, and the
   * Settings REACHABILITY PROBE — took a path the carrier router knew nothing about.
   * The result was a screen showing a green "Reachable" pill beside a Carrier panel
   * saying no connection worked, and both were reporting honestly: they were asking
   * different questions over different code.
   *
   * Two answers to "can this browser reach that daemon" is one answer too many. There
   * is now one path, so a probe cannot pass on a carrier the product cannot use, and
   * a daemon that is only reachable through the relay is reported reachable rather
   * than reported down by a probe that never tried the relay.
   */
  /**
   * THE LIVE EVENT STREAM IS WIRED, AND IT WAS NOT BEFORE.
   *
   * `DaemonEventTransport` has been in this package, unit-tested, and constructed by nothing:
   * `daemonApiClient` never passed an `eventTransport`, so the typed client fell back to the
   * protocol package's own `WebSocketEventTransport`, which dials the daemon's address directly and
   * knows nothing about a carrier. On a relayed connection that is a socket opened at precisely the
   * address the relay exists because the browser cannot reach — a subscribed viewer receiving
   * nothing, forever, which is the failure this protocol spends §7 and §9 avoiding.
   *
   * Both halves it declared and never received are supplied here: the ACTIVE CARRIER, so it can tell
   * which kind of stream to open, and the router's `openStream`, so a relayed one is a §14 stream
   * session rather than a socket. `choice()` is read per call rather than captured because a carrier
   * is measured, and the answer at connect time is not the answer when a stream reconnects.
   */
  const clients = new DaemonApiPool(
    options.connectClient ??
      (async daemon =>
        await daemonApiClient(daemon, {
          transport: new DaemonHttpTransport(daemon, carried),
          eventTransport: new DaemonEventTransport(
            daemon,
            async paired => await daemonEventTicket(paired, carried, () => carrier.activeMethod(paired.daemonId)),
            undefined,
            () => carrier.activeMethod(daemon.daemonId),
            async (paired, request) => await carrier.openStream(paired, request),
          ),
        })),
  );
  const fleetPort: DaemonFleetPort = {
    list: async daemon => await (await clients.client(daemon)).list(),
    get: async (daemon, sessionId) => await (await clients.client(daemon)).get(sessionId),
  };
  const fleet = new DaemonFleetStore(fleetPort);
  const controls = new DaemonControlsStore();
  const projects = new DaemonProjectsStore(daemonProjectsPort(carried));
  const accountPicker = new DaemonAccountPickerStore({
    catalog: async daemon => await readAccountPickerCatalog(await clients.client(daemon)),
    health: async daemon => await readAccountPickerHealth(await clients.client(daemon)),
  });
  const usage = new DaemonUsageStore(daemonUsagePort(carried));
  const pins = new DaemonPinClient(undefined, carried);
  const browserLogin = new DaemonBrowserLoginStore(daemon => ({
    status: async () => await browserLoginPort(await clients.client(daemon)).status(),
    act: async action => await browserLoginPort(await clients.client(daemon)).act(action),
  }));
  const browserStorage = browserControlsStorage() ?? null;
  const stt = new SttSettingsStore(browserStorage);
  const notificationPreferences = new DaemonNotificationPreferences(browserStorage);
  const pushDevices = new DaemonPushDevices(browserStorage);
  const pushService = daemonPushService(carried);
  const connections = await DaemonConnectionStore.open({
    repository: options.repository ?? browserConnectionRepository(),
    // `documentDraftStore` is not built here — the composer needs it as a module default before any
    // context exists — but it is browser-persisted daemon state like every other entry, so it is
    // invalidated like every other entry. A store the registry cannot reach keeps serving an
    // unpaired daemon's records; `scripts/validate/daemon-scope.sh` now fails the commit that
    // leaves one out. The carrier router is in the list for the same reason: a live relay session
    // holds the credential that opened it, so it must not outlive the pairing.
    caches: [
      clients,
      fleet,
      controls,
      projects,
      accountPicker,
      usage,
      pins,
      browserLogin,
      notificationPreferences,
      pushDevices,
      documentDraftStore,
      carrier,
    ],
  });
  // The router must never hold its own copy of who is paired: a second copy is how a
  // request keeps going to a daemon somebody has unpaired.
  carrier.resolveByOrigin(origin => connections.list().find(record => daemonOrigin(record) === origin));
  const landingMarkerStorage = options.landingMarkerStorage ?? browserLandingMarkerStorage();
  const syncLandingPage = (): void =>
    syncLandingMarker(landingMarkerStorage, connections.getSnapshot().connections.length);
  syncLandingPage();
  // The document-lifetime store owns this document-lifetime convenience. Every
  // add, eviction, and explicit unpair now keeps the marker honest.
  connections.subscribe(syncLandingPage);

  /** The daemon is authoritative; after a carrier first answers, replace the cache. */
  carrier.onConnected(daemon => {
    void (async () => {
      const request = daemonRequest(daemon, '/v1/carriers', { cache: 'no-store' });
      const response = await carrier.fetch(request.url, request.init);
      if (!response.ok) return;
      const view = DaemonCarriersViewSchema.safeParse(await response.json().catch(() => undefined));
      if (!view.success) return;
      connections.replaceCarriers(daemon, publishedConnectionMethods(view.data.carriers, await hostedRelayUrl));
    })().catch(() => undefined);
  });

  return {
    carrier,
    connections,
    clients,
    fleet,
    controls,
    projects,
    accountPicker,
    usage,
    pins,
    browserLogin,
    stt,
    notificationPreferences,
    pushDevices,
    pushService,
    readDefaultRelay,
    pair: async seed => {
      const connection = await exchangePairing(seed, {
        fetcher,
        relayCrypto,
        ...(options.relayDial === undefined ? {} : { relayDial: options.relayDial }),
        ...((await hostedRelayUrl) === undefined ? {} : { hostedRelayUrl: await hostedRelayUrl }),
      });
      connections.add(connection);
      return connection;
    },
  };
}

const StoreContext = createContext<AppStore | null>(null);

export interface StoreProviderProps {
  readonly children: ReactNode;
  readonly store?: AppStore;
  readonly createStore?: () => Promise<AppStore>;
}

interface StoreAttempt {
  readonly attempt: number;
  readonly opening: Promise<AppStore>;
}

const openingSentence = (attempt: number): string =>
  attempt === 0 ? 'Opening Ferretry…' : 'Retrying: opening Ferretry…';

/**
 * Opens browser persistence once, including under React StrictMode's effect
 * replay, and keeps a rejected open recoverable.
 *
 * The in-flight promise is cached per ATTEMPT: StrictMode's second effect run
 * reuses the open already running, while the reader's retry is a genuinely new
 * one. A rejected attempt is dropped as it rejects, so no later run can be
 * answered by a failure that has already been reported.
 *
 * Until the store opens, one lifecycle surface stays mounted across every
 * attempt rather than being swapped for a different tree per state. Swapping
 * trees moves a screen reader's live regions in and out of the document — a
 * region added in the same commit as its text is unreliably announced — and
 * destroys the retry control the reader just pressed, so the retry drops focus
 * to the body. Here the status region and the alert region are the same two
 * nodes from the first paint until the store is open, and the retry control is
 * the same node from the first failure onward.
 *
 * THE RETRY CONTROL DOES NOT EXIST BEFORE THE FIRST FAILURE. Keeping it
 * mounted is worth a permanent node only because it preserves the control a
 * reader just pressed, and while nothing has failed there is nothing to
 * preserve. Offering "Try again" during an ordinary open would claim a failure
 * that has not happened, and would cost a reader a tab stop announced as
 * unavailable on every boot.
 *
 * The status region owns the progress sentence and falls silent on failure;
 * the alert region owns the failure sentence. They never both speak, because
 * two live regions carrying the same sentence announce it twice.
 *
 * A RECOVERED BOOT HANDS THE READER OVER. Opening the store replaces this
 * whole surface, including the retry control the reader is standing on, so
 * focus would otherwise fall to the body with nothing said — the same silent
 * drop the persistent control exists to prevent. A reader who has seen a
 * failure therefore gets one focused status line on the successful open. It is
 * FOCUS that makes the sentence reliably read: the region is inserted in the
 * same commit as its text, which is exactly the case a live region announces
 * unreliably. An open that never failed says nothing and moves nothing — the
 * browser has already placed focus and there is no failure to close out.
 *
 * A failed open is reported, never smoothed over: no empty store is published
 * in its place, so no consumer can mistake damaged local state for an
 * unpaired one.
 */
export function StoreProvider({ children, store, createStore = createAppStore }: StoreProviderProps) {
  const pending = useRef<StoreAttempt | null>(null);
  const [resolved, setResolved] = useState<AppStore | null>(store ?? null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const openedAnnouncer = useRef<HTMLParagraphElement>(null);
  const handedOver = useRef(false);

  useEffect(() => {
    if (store !== undefined) {
      setResolved(store);
      setFailure(null);
      return;
    }
    let entry = pending.current;
    if (entry === null || entry.attempt !== attempt) {
      entry = { attempt, opening: createStore() };
      pending.current = entry;
    }
    const started = entry;
    let current = true;
    void started.opening.then(
      value => {
        if (current) setResolved(value);
      },
      reason => {
        if (pending.current === started) pending.current = null;
        if (current) setFailure(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, createStore, store]);

  // The handover is latched rather than keyed on a render, because a mount
  // effect runs twice under StrictMode and a reader may only be moved once.
  useEffect(() => {
    if (resolved === null || attempt === 0 || handedOver.current) return;
    handedOver.current = true;
    openedAnnouncer.current?.focus();
  }, [attempt, resolved]);

  if (resolved !== null)
    return (
      <StoreContext.Provider value={resolved}>
        {attempt === 0 ? null : (
          // `tabIndex={-1}` takes the focus this surface is about to destroy
          // without adding a tab stop of its own, and `sr-only` keeps a
          // sentence that is only about the boot out of the visual design.
          <p
            ref={openedAnnouncer}
            tabIndex={-1}
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            Ferretry is open.
          </p>
        )}
        {children}
      </StoreContext.Provider>
    );

  const opening = failure === null;
  // A press is what the control has to survive, so it appears with the first
  // failure and stays for every attempt after it.
  const failedBefore = attempt > 0 || failure !== null;
  return (
    <div>
      <p role="status" aria-live="polite" aria-atomic="true">
        {opening ? openingSentence(attempt) : ''}
      </p>
      <p role="alert" aria-atomic="true">
        {opening ? '' : `Could not open local PWA state: ${failure}`}
      </p>
      {/*
        `aria-disabled` rather than `disabled`: a disabled control leaves the
        focus order, so the browser blurs it the moment the retry starts —
        exactly the focus loss a persistent control exists to prevent. The
        handler enforces the same refusal the attribute announces.
      */}
      {failedBefore ? (
        <button
          type="button"
          aria-disabled={opening}
          onClick={() => {
            if (opening) return;
            setFailure(null);
            setAttempt(count => count + 1);
          }}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext);
  if (store === null) throw new Error('useAppStore must be rendered inside StoreProvider');
  return store;
}

/**
 * Reads the pairing registry, resubscribing only when the store itself changes.
 *
 * The callbacks are memoised against the current connection store: a fresh
 * `subscribe` identity makes `useSyncExternalStore` tear the subscription down
 * and build it again on every render of every consumer, which is pure churn
 * while the store is the same object — and still correct re-subscription when
 * the provider publishes a different one.
 */
export function useConnectionSnapshot(): DaemonConnectionsSnapshot {
  const { connections } = useAppStore();
  const subscribe = useCallback((listener: () => void) => connections.subscribe(listener), [connections]);
  const getSnapshot = useCallback(() => connections.getSnapshot(), [connections]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
