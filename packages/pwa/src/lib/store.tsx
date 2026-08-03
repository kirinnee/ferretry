import type { FyApiClient } from '@ferretry/protocol/client';
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

import { daemonApiClient } from './api-client.ts';
import {
  type DaemonConnectionRepository,
  DaemonConnectionStore,
  type DaemonConnectionsSnapshot,
} from './connections.ts';
import { browserControlsStorage, DaemonControlsStore } from './controls.ts';
import { type DaemonConnection, type DaemonId, sameDaemonConnection } from './daemon-connection.ts';
import { type DaemonFleetPort, DaemonFleetStore } from './fleet-store.ts';
import { DaemonNotificationPreferences } from './notification-preferences.ts';
import { type PairingResult, type PairingSeed, pairedDaemonConnection } from './pairing.ts';
import { DaemonProjectsStore, daemonProjectsPort } from './projects-store.ts';
import { type DaemonPushService, DaemonPushDevices, daemonPushService } from './push-enrolment.ts';
import type { DaemonFetch } from './runtime-models.ts';
import { SttSettingsStore } from './stt/stt-settings.ts';
import { DaemonUsageStore, daemonUsagePort } from './usage-store.ts';

const CONNECTION_DATABASE = 'ferretry-pwa';
const CONNECTION_OBJECT_STORE = 'connections';

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
  readonly pair: (seed: PairingSeed) => Promise<DaemonConnection>;
}

export interface CreateAppStoreOptions {
  readonly repository?: DaemonConnectionRepository;
  readonly fetcher?: DaemonFetch;
  readonly connectClient?: ConnectDaemonClient;
}

/** Builds the document-lifetime stores and registers every daemon cache together. */
export async function createAppStore(options: CreateAppStoreOptions = {}): Promise<AppStore> {
  const fetcher = options.fetcher ?? fetch;
  const clients = new DaemonApiPool(options.connectClient);
  const fleetPort: DaemonFleetPort = {
    list: async daemon => await (await clients.client(daemon)).list(),
    get: async (daemon, sessionId) => await (await clients.client(daemon)).get(sessionId),
  };
  const fleet = new DaemonFleetStore(fleetPort);
  const controls = new DaemonControlsStore();
  const projects = new DaemonProjectsStore(daemonProjectsPort(fetcher));
  const usage = new DaemonUsageStore(daemonUsagePort(fetcher));
  const browserStorage = browserControlsStorage() ?? null;
  const stt = new SttSettingsStore(browserStorage);
  const notificationPreferences = new DaemonNotificationPreferences(browserStorage);
  const pushDevices = new DaemonPushDevices(browserStorage);
  const pushService = daemonPushService(fetcher);
  const connections = await DaemonConnectionStore.open({
    repository: options.repository ?? browserConnectionRepository(),
    caches: [clients, fleet, controls, projects, usage, notificationPreferences, pushDevices],
  });

  return {
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
 * to the body. Here the status region, the alert region and the retry control
 * are the same three nodes from the first paint until the store is open.
 *
 * The status region owns the progress sentence and falls silent on failure;
 * the alert region owns the failure sentence. They never both speak, because
 * two live regions carrying the same sentence announce it twice.
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

  if (resolved !== null) return <StoreContext.Provider value={resolved}>{children}</StoreContext.Provider>;

  const opening = failure === null;
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
