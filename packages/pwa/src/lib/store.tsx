import type { FyApiClient } from '@ferretry/protocol/client';
import type { RelayCrypto } from '@ferretry/relay';
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
import { daemonApiClient } from './api-client.ts';
import {
  type DaemonConnectionRepository,
  DaemonConnectionStore,
  type DaemonConnectionsSnapshot,
} from './connections.ts';
import { browserControlsStorage, DaemonControlsStore } from './controls.ts';
import { type DaemonConnection, type DaemonId, type RelayCarrier, sameDaemonConnection } from './daemon-connection.ts';
import { documentDraftStore } from './drafts.ts';
import { type DaemonFleetPort, DaemonFleetStore } from './fleet-store.ts';
import { DaemonNotificationPreferences } from './notification-preferences.ts';
import { type PairingResult, type PairingSeed, pairedDaemonConnection } from './pairing.ts';
import { DaemonCarrierRouter, type RelayDial } from './relay-carrier.ts';
import { DaemonProjectsStore, daemonProjectsPort } from './projects-store.ts';
import { type DaemonPushService, DaemonPushDevices, daemonPushService } from './push-enrolment.ts';
import type { DaemonFetch } from './runtime-models.ts';
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

/** Exchanges one reader-supplied, single-use fragment code with its own daemon. */
export async function exchangePairing(seed: PairingSeed, fetcher: DaemonFetch = fetch): Promise<DaemonConnection> {
  const endpoint = new URL('/v1/pair', `${seed.daemonUrl}/`);
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: seed.code, deviceName: 'Ferretry PWA' }),
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(await pairingFailure(response));
  const value = (await response.json()) as Partial<PairingResult>;
  if (typeof value.daemonId !== 'string' || typeof value.deviceToken !== 'string') {
    throw new Error('the daemon returned an invalid pairing response');
  }
  return pairedDaemonConnection(seed, { daemonId: value.daemonId, deviceToken: value.deviceToken });
}

export interface AppStore {
  readonly connections: DaemonConnectionStore;
  readonly clients: DaemonApiPool;
  readonly fleet: DaemonFleetStore;
  readonly controls: DaemonControlsStore;
  readonly projects: DaemonProjectsStore;
  readonly usage: DaemonUsageStore;
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
  const fetcher = options.fetcher ?? fetch;
  // Every DAEMON-BOUND call goes through the carrier router; the two that are not
  // bound to a paired daemon — the pairing exchange and the relay advertisement —
  // keep the raw fetcher on purpose. Pairing especially: a relayed session is opened
  // with the device grant pairing has not issued yet, so it cannot be relayed, and
  // routing a RE-pair through an existing session would exchange a fresh code under
  // the credential it is replacing.
  const carrier = new DaemonCarrierRouter({
    network: fetcher,
    crypto: options.relayCrypto ?? new WebCryptoRelayCrypto(),
    ...(options.relayDial === undefined ? {} : { dial: options.relayDial }),
  });
  const carried = carrier.fetch;
  const clients = new DaemonApiPool(options.connectClient);
  const fleetPort: DaemonFleetPort = {
    list: async daemon => await (await clients.client(daemon)).list(),
    get: async (daemon, sessionId) => await (await clients.client(daemon)).get(sessionId),
  };
  const fleet = new DaemonFleetStore(fleetPort);
  const controls = new DaemonControlsStore();
  const projects = new DaemonProjectsStore(daemonProjectsPort(carried));
  const usage = new DaemonUsageStore(daemonUsagePort(carried));
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
      usage,
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

  const readDefaultRelay = async (): Promise<HostedRelayFallback> =>
    // The directory origin is the build constant and nothing else: no literal, no
    // relative path, no guess. Unset ships no directory and answers without
    // dialling, which is what a local build or a fork honestly is.
    await readHostedRelayFallback({ directoryUrl: bundledRelayDirectory(), fetcher });

  /**
   * ASK THE LIVE ADVERTISEMENT, THEN GIVE EVERY DAEMON THE ANSWER.
   *
   * Read once per document load, never from storage: `relayUrl: null` is a kill
   * switch its operator can throw without an app release, so a browser that carried
   * a remembered hosted address would be the switch not working (§13). A discovery
   * failure and a `null` are the SAME answer here — no hosted carrier — because
   * neither is permission to guess an address.
   *
   * An owner-supplied relay is left alone. That address has no runtime source, so
   * overwriting it with a hosted one would take away the only carrier its owner
   * configured.
   */
  let hosted: RelayCarrier | undefined;
  const applyHostedRelay = (): void => {
    for (const record of connections.list()) {
      if (record.relay?.operator === 'self') continue;
      connections.attachRelay(record.daemonId, hosted);
    }
  };
  connections.subscribe(applyHostedRelay);
  void readDefaultRelay().then(fallback => {
    hosted =
      fallback.kind === 'available' ? { kind: 'relay', relayUrl: fallback.relayUrl, operator: 'hosted' } : undefined;
    applyHostedRelay();
  });

  return {
    carrier,
    connections,
    clients,
    fleet,
    controls,
    projects,
    usage,
    stt,
    notificationPreferences,
    pushDevices,
    pushService,
    readDefaultRelay,
    pair: async seed => {
      const connection = await exchangePairing(seed, fetcher);
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
