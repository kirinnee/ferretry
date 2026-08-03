import type { FyApiClient } from '@ferretry/protocol/client';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';

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
import { DaemonPushDevices } from './push-enrolment.ts';
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

/** Opens browser persistence once, including under React StrictMode's effect replay. */
export function StoreProvider({ children, store, createStore = createAppStore }: StoreProviderProps) {
  const pending = useRef<Promise<AppStore> | null>(null);
  const [resolved, setResolved] = useState<AppStore | null>(store ?? null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (store !== undefined) {
      setResolved(store);
      setFailure(null);
      return;
    }
    pending.current ??= createStore();
    let current = true;
    void pending.current.then(
      value => {
        if (current) setResolved(value);
      },
      reason => {
        if (current) setFailure(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [createStore, store]);

  if (failure !== null) return <p role="alert">Could not open local PWA state: {failure}</p>;
  if (resolved === null) return <p role="status">Opening Ferretry…</p>;
  return <StoreContext.Provider value={resolved}>{children}</StoreContext.Provider>;
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext);
  if (store === null) throw new Error('useAppStore must be rendered inside StoreProvider');
  return store;
}

export function useConnectionSnapshot(): DaemonConnectionsSnapshot {
  const { connections } = useAppStore();
  return useSyncExternalStore(connections.subscribe.bind(connections), connections.getSnapshot.bind(connections));
}
