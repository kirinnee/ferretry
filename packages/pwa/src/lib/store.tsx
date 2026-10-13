import { DaemonCarriersViewSchema, type PairingResponse } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import { publishedConnectionMethods } from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  bundledRelayDirectory,
  type HostedRelayFallback,
  readHostedRelayFallback,
} from '../features/onboarding/hosted-relay.ts';
import {
  checkAccountPickerHealth,
  readAccountPickerCatalog,
  readAccountPickerHealth,
} from './account-picker-catalog.ts';
import { DaemonAccountPickerStore } from './account-picker-store.ts';
import { DaemonHttpTransport, daemonApiClient } from './api-client.ts';
import { DaemonAttentionClient } from './attention-client.ts';
import { browserLoginPort, DaemonBrowserLoginStore } from './browser-login.ts';
import {
  type DaemonConnectionRepository,
  DaemonConnectionStore,
  type DaemonConnectionsSnapshot,
} from './connections.ts';
import { browserControlsStorage, DaemonControlsStore } from './controls.ts';
import { type DaemonConnection, type DaemonId, sameDaemonConnection } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import { type DeviceKeyStore, IndexedDbDeviceKeyStore, mintDeviceKey } from './device-keys.ts';
import { documentDraftStore } from './drafts.ts';
import { DaemonEventTransport } from './event-transport.ts';
import { type DaemonFleetPort, DaemonFleetStore } from './fleet-store.ts';
import { DaemonNotificationPreferences } from './notification-preferences.ts';
import { type PairingSeed, pairedDaemonConnection } from './pairing.ts';
import { DaemonPinClient } from './pin-client.ts';
import { DaemonProjectsStore, daemonProjectsPort } from './projects-store.ts';
import { DaemonPushDevices, type DaemonPushService, daemonPushService } from './push-enrolment.ts';
import {
  DaemonCarrierRouter,
  DaemonOutdatedError,
  daemonIsOutdated,
  isOutdatedDaemonRefusal,
  type RelayDial,
} from './relay-carrier.ts';
import { PairingOutcomeUnknownError, pairingCandidates, redeemPairingInSession } from './relay-pairing.ts';
import { RelayPairingRefusedError } from './relay-session.ts';
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

/** How this browser names itself to a daemon it is asking to trust it. */
const PAIRING_DEVICE_NAME = 'Ferretry PWA';

/**
 * How long the DIRECT leg of a redemption may spend before the walk moves on.
 *
 * Short on purpose. It is not a budget for a slow daemon — a reachable daemon keys a session in
 * milliseconds on a LAN — it is the point at which "this address is not answering" becomes the more
 * useful conclusion. The code it is spending has a two-minute life, and the rendezvous attempt behind
 * this one needs a socket, a handshake and a sealed exchange of its own.
 */
const DIRECT_PAIRING_TIMEOUT_MS = 4_000;

export interface ExchangePairingOptions {
  /** Where this browser keeps device keys. The new key is saved here only once the daemon accepted it. */
  readonly deviceKeys: DeviceKeyStore;
  readonly hostedRelayUrl?: string;
  /** WebCrypto by default: the session's primitives, and the one that mints the device key. */
  readonly relayCrypto?: WebCryptoRelayCrypto;
  /** The browser WebSocket by default. Injected so no suite opens one. */
  readonly relayDial?: RelayDial;
  /** `DIRECT_PAIRING_TIMEOUT_MS` by default. A parameter so a suite can prove the deadline in ms. */
  readonly directTimeoutMs?: number;
  /**
   * The plain network, for ONE read: the daemon's public liveness route after the direct leg failed,
   * which is how an old daemon is told from an absent one. Absent means nobody can ask.
   */
  readonly network?: DaemonFetch;
}

/**
 * A sealed refusal that arrived after an earlier leg's code may already have been spent.
 *
 * A subclass rather than a new class, deliberately: the daemon genuinely refused, so every consumer
 * that asks "was this a refusal or a transport failure" — `pairing-screen.tsx` is the one that
 * matters — must keep getting `refusal` and must keep telling the reader to mint a fresh code. What
 * this adds is the half that screen cannot know: minting again is necessary and may not be
 * sufficient, because a device may already be paired under a grant nobody holds.
 */
class AmbiguousPairingError extends RelayPairingRefusedError {
  constructor(refusal: unknown) {
    super();
    this.name = 'AmbiguousPairingError';
    this.cause = refusal;
    this.message =
      'this pairing code is spent, and an earlier attempt from this browser may be what spent it: the ' +
      'code reached the daemon, but the connection ended before its answer arrived, so the daemon may ' +
      'have paired a device this browser never heard about. Check the daemon for a device you do not ' +
      'recognise and revoke it, then run `fy pair` for a fresh code.';
  }
}

/**
 * Exchanges one reader-supplied, single-use fragment code — over whichever carrier reaches its daemon.
 *
 * THE WALK IS §1'S: the daemon's own address first, then the one rendezvous this build discovered for
 * itself. Both are SESSIONS — the daemon is proved against the QR's fingerprint before the code leaves
 * this browser, on the LAN as much as across the internet — and both register the same freshly minted,
 * non-extractable device key. Only a TRANSPORT failure advances the walk; a sealed `pair-refused` is
 * the daemon's final answer for that attempt, and carrying the same code to a second carrier would
 * spend another guess to be told the same thing.
 *
 * THE KEY IS SAVED ONLY AFTER THE DAEMON ACCEPTED IT, and only for the daemon that did. A refused or
 * unreachable pairing leaves nothing behind in this browser.
 *
 * WHAT IS REPORTED WHEN EVERYTHING FAILS is the FIRST failure, not the last. The direct attempt is the
 * one whose answer a reader can act on, while the relay attempt after it is this browser's own
 * recovery; reporting "the rendezvous did not answer" to somebody whose real problem is an expired
 * code sends them to fix their network.
 */
export async function exchangePairing(seed: PairingSeed, options: ExchangePairingOptions): Promise<DaemonConnection> {
  const crypto = options.relayCrypto ?? new WebCryptoRelayCrypto();
  const minted = await mintDeviceKey(crypto);
  const key = crypto.deviceKeyHandle(minted.privateKey);
  let first: Error | undefined;
  let spentUnheard = false;
  for (const method of pairingCandidates(seed, options.hostedRelayUrl)) {
    let response: PairingResponse;
    try {
      response = await redeemPairingInSession({
        crypto,
        seed,
        deviceName: PAIRING_DEVICE_NAME,
        method,
        publicKey: minted.publicKey,
        key,
        ...(options.relayDial === undefined ? {} : { dial: options.relayDial }),
        ...(method.kind === 'direct' ? { deadlineMs: options.directTimeoutMs ?? DIRECT_PAIRING_TIMEOUT_MS } : {}),
      });
    } catch (reason) {
      // A sealed refusal is the DAEMON's answer and ends the walk; anything else is this carrier not
      // working, which is the next one's turn.
      if (reason instanceof RelayPairingRefusedError) throw spentUnheard ? new AmbiguousPairingError(reason) : reason;
      // AN OLD MACHINE IS ONE SENTENCE, NOT A CARRIER THAT FAILED. Every other carrier reaches the same
      // daemon, so the walk stops and names the side to update rather than reporting a network fault.
      if (isOutdatedDaemonRefusal(reason)) throw new DaemonOutdatedError();
      if (
        method.kind === 'direct' &&
        options.network !== undefined &&
        (await daemonIsOutdated(options.network, method.daemonUrl))
      )
        throw new DaemonOutdatedError();
      if (reason instanceof PairingOutcomeUnknownError) spentUnheard = true;
      first ??= reason instanceof Error ? reason : new Error(String(reason));
      continue;
    }
    // Deliberately outside the catch above: a response that paired but named no rendezvous this
    // browser crossed is a decided outcome, not a carrier that failed. The grant exists and this
    // device is discarding it, and dialling the next carrier would mint a second one to discard.
    const connection = pairedDaemonConnection(
      seed,
      response,
      options.hostedRelayUrl,
      method.kind === 'relay' ? method : undefined,
    );
    await options.deviceKeys.save(connection.daemonId, minted.privateKey);
    return connection;
  }
  throw first ?? new Error('no carrier could reach this daemon to pair with it');
}

export interface AppStore {
  readonly connections: DaemonConnectionStore;
  readonly clients: DaemonApiPool;
  readonly fleet: DaemonFleetStore;
  readonly controls: DaemonControlsStore;
  readonly projects: DaemonProjectsStore;
  readonly accountPicker: DaemonAccountPickerStore;
  /** The one daemon/session-scoped Attention cache and mutation client. */
  readonly attention: DaemonAttentionClient;
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
  /** WebCrypto by default: the session primitives, and the adapter that mints and wraps device keys. */
  readonly relayCrypto?: WebCryptoRelayCrypto;
  /** IndexedDB by default. Where this browser keeps the device key each pairing proved itself with. */
  readonly deviceKeys?: DeviceKeyStore;
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
  // Every DAEMON-BOUND call goes through the carrier router, and every one of them rides a session
  // the device key opened. The raw fetcher is left for the relay advertisement alone, which is not
  // bound to any daemon.
  //
  // PAIRING DOES NOT TRAVEL THE ROUTER EITHER, for the opposite reason: the router's sessions are
  // opened with a device key this exchange is what registers. `exchangePairing` dials its own sealed
  // pairing sessions — direct, then the discovered rendezvous — and a RE-pair through an existing
  // session would exchange a fresh code under the grant it is replacing.
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
  const deviceKeys = options.deviceKeys ?? new IndexedDbDeviceKeyStore();
  const carrier = new DaemonCarrierRouter({
    network: fetcher,
    crypto: relayCrypto,
    // Read per session, never cached: a key the person removed by clearing site data must stop
    // opening sessions the moment it is gone.
    deviceKey: async daemonId => {
      const key = await deviceKeys.load(daemonId);
      return key === undefined ? undefined : relayCrypto.deviceKeyHandle(key);
    },
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
   * It is handed the router's `openStream`, so every stream — direct or relayed — is a §14 stream
   * session the device key opened, on whichever carrier reaches the daemon at the moment it connects.
   */
  const clients = new DaemonApiPool(
    options.connectClient ??
      (async daemon =>
        await daemonApiClient(daemon, {
          transport: new DaemonHttpTransport(daemon, carried),
          eventTransport: new DaemonEventTransport(
            daemon,
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
    checkHealth: async daemon => await checkAccountPickerHealth(await clients.client(daemon)),
  });
  // Attention is not part of the generated FyApiClient yet, but it still takes
  // the SAME carrier as every generated call. A direct-only second client would
  // make the action modal fail on precisely the remote phone it is for.
  const attention = new DaemonAttentionClient(undefined, carried);
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
      attention,
      usage,
      pins,
      browserLogin,
      notificationPreferences,
      pushDevices,
      documentDraftStore,
      carrier,
    ],
    // The key goes with the pairing it proved, and only when the pairing goes for good — a re-pair in
    // place has already saved the new key under the same daemon id.
    forget: daemonId => void deviceKeys.remove(daemonId).catch(() => undefined),
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
    attention,
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
        deviceKeys,
        relayCrypto,
        ...(options.relayDial === undefined ? {} : { relayDial: options.relayDial }),
        ...((await hostedRelayUrl) === undefined ? {} : { hostedRelayUrl: await hostedRelayUrl }),
        network: fetcher,
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
 * The fetch a screen reads a daemon through: the carrier router, so a daemon only the relay can reach
 * is reached through the relay.
 *
 * Screens that built their own request and called the network directly worked on the LAN and failed
 * on precisely the phone that needed the relay. This is the one way a component gets a daemon fetch.
 * Outside a provider — a component rendered on its own by a test — there is no router to route
 * through, and the answer is the plain network.
 */
export function useDaemonFetch(): DaemonFetch {
  const store = useContext(StoreContext);
  // ONE identity per store, read through at call time. Effects list this fetch as a dependency, so a
  // carrier whose `fetch` member is re-read as a fresh function (a wrapped router hands out a new
  // bound one per read) would otherwise restart every read on every render, forever.
  return useMemo<DaemonFetch>(
    () => (store === null ? browserFetch : async (input, init) => await store.carrier.fetch(input, init)),
    [store],
  );
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
