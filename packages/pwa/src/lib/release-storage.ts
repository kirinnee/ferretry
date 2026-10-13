/**
 * THE RELEASE KEEPER'S BROWSER PORTS — IndexedDB for the signed releases the worker keeps, Cache
 * Storage for their files' bytes, and the site's own origin for fresh ones.
 *
 * Every one of them is UNTRUSTED storage: both stores belong to the origin, so any page on it can
 * write them. They therefore move bytes and nothing else, and the keeper re-checks everything it
 * reads back (`release-keeper.ts`).
 *
 * Each is a thin class over an INJECTED browser object (the pattern `store.tsx` uses for pairings),
 * so the worker entry only constructs them and a unit suite drives each one with a plain fake. None
 * of them ever talks to a daemon: every path they are given is a file of this site.
 */

import type { KeeperState, ReleaseCaches, ReleaseNetwork, ReleaseStateStore } from './release-keeper.ts';

/** The worker's own database. Separate from the page's pairing database on purpose. */
const RELEASE_DATABASE = 'ferretry-release';
const RELEASE_OBJECT_STORE = 'state';
const RELEASE_STATE_KEY = 'keeper';

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
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

/**
 * The keeper's one record. A single `put` in a single transaction is what makes a release swap
 * atomic: either the new active release AND everything that goes with it are stored, or neither is.
 * `load` answers whatever the record holds, unshaped: deciding what it is worth is the keeper's job.
 */
export class IndexedDbReleaseState implements ReleaseStateStore {
  readonly #database: Promise<IDBDatabase>;

  constructor(factory: IDBFactory, databaseName = RELEASE_DATABASE) {
    this.#database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(RELEASE_OBJECT_STORE)) {
          request.result.createObjectStore(RELEASE_OBJECT_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('could not open the release database'));
      request.onblocked = () => reject(new Error('the release database upgrade is blocked'));
    });
  }

  async load(): Promise<unknown> {
    const database = await this.#database;
    const transaction = database.transaction(RELEASE_OBJECT_STORE, 'readonly');
    return await requestResult<unknown>(transaction.objectStore(RELEASE_OBJECT_STORE).get(RELEASE_STATE_KEY));
  }

  async save(state: KeeperState): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction(RELEASE_OBJECT_STORE, 'readwrite');
    transaction.objectStore(RELEASE_OBJECT_STORE).put(state, RELEASE_STATE_KEY);
    await transactionComplete(transaction);
  }
}

/** The subset of `CacheStorage` this needs. */
export interface CacheStorageLike {
  open(cacheName: string): Promise<{
    put(request: string, response: Response): Promise<void>;
    match(request: string): Promise<Response | undefined>;
  }>;
  keys(): Promise<string[]>;
  delete(cacheName: string): Promise<boolean>;
}

/**
 * Bytes, keyed by site path. The key is a plain `/path` rather than a full URL so a cache entry can
 * only ever answer for this origin. No header is stored: a stored header would be one more thing a
 * page could rewrite, and the worker never serves one (`release-headers.ts`).
 */
export class CacheStorageReleaseCaches implements ReleaseCaches {
  constructor(private readonly storage: CacheStorageLike) {}

  async put(cacheName: string, path: string, bytes: Uint8Array): Promise<void> {
    await (await this.storage.open(cacheName)).put(`/${path}`, new Response(bytes as Uint8Array<ArrayBuffer>));
  }

  async get(cacheName: string, path: string): Promise<Uint8Array | null> {
    const response = await (await this.storage.open(cacheName)).match(`/${path}`);
    return response === undefined ? null : new Uint8Array(await response.arrayBuffer());
  }

  names(): Promise<readonly string[]> {
    return this.storage.keys();
  }

  async remove(cacheName: string): Promise<void> {
    await this.storage.delete(cacheName);
  }
}

/** The one network call the keeper needs, bound by the worker entry to its own `fetch`. */
export type ReleaseFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Fresh bytes from this site. `no-store` so neither the browser's HTTP cache nor a stale edge copy
 * can answer for the deploy, and `same-origin` credentials because nothing here is a daemon.
 *
 * A REDIRECT IS FOLLOWED, BUT ONLY WITHIN THIS ORIGIN. Cloudflare Pages answers `/app/index.html` with
 * a redirect to `/app/`, and the bytes there are the file the list names — which is all that matters,
 * because the hash, not the address, is what is checked. A redirect that LEAVES the origin answers
 * "not fetched": a release is this site's files, never anybody else's.
 */
export class FetchReleaseNetwork implements ReleaseNetwork {
  constructor(
    private readonly fetcher: ReleaseFetch,
    private readonly origin: string,
  ) {}

  async get(path: string): Promise<Uint8Array | null> {
    try {
      const response = await this.fetcher(new URL(`/${path}`, this.origin).href, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok || new URL(response.url || this.origin).origin !== this.origin) return null;
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      return null;
    }
  }
}
