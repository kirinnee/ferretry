/**
 * `@ferretry/kernel/worker`: what a plugin's worker thread imports to open the declared sqlite state files its half
 * granted at `kernel.workers.start(url, { state })`. The kernel resolved each inside the plugin's state folder on the
 * main thread; the worker can open those and nothing else, with the same format check, WAL and mode as the main
 * thread's `kernel.state.sqlite`. It also holds what the half granted of the plugin's roots (READ-ONLY) and network:
 * `rootPort(id)` and `fetchPort()` work only with a grant handed at start, and a worker can never widen it THROUGH
 * THE GRANT CHANNEL — every read and request is served, and judged, by the main thread.
 *
 * GAP: the grants bound what a worker gets through these ports; the thread itself is in-process and is NOT a
 * sandbox (same as the sqlite `state` grant). It can still import `node:fs`, call the global `fetch` or start its
 * own `Worker`. The boundary for plugin code is the repo's lints (`banned-globals`, `fetch-binding`,
 * `no-sync-io`) and the worker bundle diet test. Grants end when the plugin's lifecycle stops (or it fails to build); a wait still pending when the channel closes is rejected with `WorkerGrantRefusal('closed')`.
 */
import { workerData } from 'node:worker_threads';
import type { StateFileDef } from './contract/define.ts';
import type {
  FetchPort,
  RootEntry,
  RootLstat,
  RootName,
  RootReadWindow,
  RootStat,
  RootTail,
  SqliteHandle,
} from './contract/ports.ts';
import {
  WORKER_GRANTS_KEY,
  type WorkerFetchAnswer,
  type WorkerFetchInit,
  type WorkerGrantRequest,
  type WorkerGrantResponse,
  type WorkerGrantsData,
} from './host/worker-grants/wire.ts';
import { nodeSqliteFiles, openSqlite } from './host/state/sqlite-store.ts';

/** One file the half granted, as the kernel resolved it. */
export interface WorkerSqliteGrant {
  readonly file: { readonly name: string; readonly path: string; readonly store: string; readonly format: number };
  readonly name?: string;
  readonly path: string;
  readonly label: string;
}

/** The key the kernel puts its grants under in the worker's `workerData`. */
export const WORKER_STATE_KEY = 'ferretryState';

export interface WorkerStatePort {
  /** Opens a granted sqlite file; one the half did not grant (or granted under another shape) throws. */
  sqlite(def: StateFileDef, name?: string): SqliteHandle;
}

/** The grants this worker was started with (`data` is for a test of the worker module; a worker passes nothing). */
export function workerState(data: unknown = workerData): WorkerStatePort {
  const raw = (data as Record<string, unknown> | null | undefined)?.[WORKER_STATE_KEY];
  const grants: readonly WorkerSqliteGrant[] = Array.isArray(raw) ? (raw as WorkerSqliteGrant[]) : [];
  return {
    sqlite(def, name) {
      const grant = grants.find(
        g =>
          g.file.name === def.name &&
          g.file.path === def.path &&
          g.file.store === def.store &&
          g.file.format === def.format &&
          g.name === name,
      );
      if (grant === undefined)
        throw new TypeError(`state ${def.name}${name === undefined ? '' : ` ${name}`}: not granted to this worker`);
      return openSqlite(def, grant.path, grant.label, nodeSqliteFiles);
    },
  };
}

/** A request the kernel refused or could not serve: a fixed `refusal` word and a fixed sentence, never a lower layer's text. */
export class WorkerGrantRefusal extends Error {
  constructor(
    readonly refusal: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerGrantRefusal';
  }
}

/**
 * A granted root, READ-ONLY: paths are relative to the root and never leave it (links and `..` refused by the main
 * thread). There is no write, remove, copy, pin or real-path operation here at all, and no path crosses into the thread.
 */
export interface WorkerRootHandle {
  readonly name: RootName;
  readText(path: string, limitBytes?: number): Promise<string>;
  readBytes(path: string, limitOrWindow?: number | RootReadWindow): Promise<Uint8Array>;
  readTail(path: string, maxBytes: number): Promise<RootTail>;
  list(path: string): Promise<readonly string[]>;
  entries(path: string): Promise<readonly RootEntry[]>;
  stat(path: string): Promise<RootStat | undefined>;
  lstat(path: string): Promise<RootLstat | undefined>;
}

const CLOSED_MESSAGE = 'the grant channel to the kernel is closed';

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/** One grant channel's client: numbers each request, matches each answer, and ends every wait when the channel closes. */
class GrantChannel {
  private next = 0;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly port: MessagePort) {
    port.onmessage = (event: MessageEvent<WorkerGrantResponse>): void => {
      const answer = event.data;
      if ('closed' in answer) {
        this.closed = true;
        const waiting = [...this.pending.values()];
        this.pending.clear();
        for (const wait of waiting) wait.reject(new WorkerGrantRefusal('closed', CLOSED_MESSAGE));
        return;
      }
      const waiting = this.pending.get(answer.id);
      if (waiting === undefined) return;
      this.pending.delete(answer.id);
      if (answer.ok) waiting.resolve(answer.value);
      else waiting.reject(new WorkerGrantRefusal(answer.refusal, answer.message));
    };
  }

  ask(request: (id: number) => WorkerGrantRequest, signal?: AbortSignal | null): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new WorkerGrantRefusal('closed', CLOSED_MESSAGE));
      if (signal?.aborted === true) return reject(signal.reason);
      this.pending.set(id, { resolve, reject });
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.delete(id)) return;
          this.port.postMessage({ kind: 'cancel', id } satisfies WorkerGrantRequest);
          reject(signal.reason);
        },
        { once: true },
      );
      this.port.postMessage(request(id));
    });
  }
}

const CHANNELS = new WeakMap<object, GrantChannel>();

function channelOf(port: MessagePort): GrantChannel {
  let channel = CHANNELS.get(port);
  if (channel === undefined) {
    channel = new GrantChannel(port);
    CHANNELS.set(port, channel);
  }
  return channel;
}

function grantsOf(data: unknown): WorkerGrantsData | undefined {
  const raw = (data as Record<string, unknown> | null | undefined)?.[WORKER_GRANTS_KEY] as
    | Partial<WorkerGrantsData>
    | undefined;
  if (raw === undefined || raw.port === undefined || !Array.isArray(raw.roots)) return undefined;
  return raw as WorkerGrantsData;
}

/**
 * The read-only handle on a root the half granted at `kernel.workers.start(url, { roots })`. One it did not grant, or
 * any root when the worker was started without grants (the `fyd --check` probe), throws naming the missing grant.
 * `data` is for a test of the worker module; a worker passes nothing.
 */
export function rootPort(id: RootName, data: unknown = workerData): WorkerRootHandle {
  const grants = grantsOf(data);
  if (grants === undefined || !grants.roots.includes(id))
    throw new TypeError(`root ${String(id)}: not granted to this worker (start it with \`roots: ['${String(id)}']\`)`);
  const channel = channelOf(grants.port);
  const call =
    (op: string) =>
    async (...args: readonly unknown[]): Promise<unknown> =>
      await channel.ask(request => ({ id: request, kind: 'root', root: id, op, args }));
  return {
    name: id,
    readText: call('readText') as WorkerRootHandle['readText'],
    readBytes: call('readBytes') as WorkerRootHandle['readBytes'],
    readTail: call('readTail') as WorkerRootHandle['readTail'],
    list: call('list') as WorkerRootHandle['list'],
    entries: call('entries') as WorkerRootHandle['entries'],
    stat: call('stat') as WorkerRootHandle['stat'],
    lstat: call('lstat') as WorkerRootHandle['lstat'],
  };
}

async function initOf(init: RequestInit | undefined): Promise<WorkerFetchInit> {
  const body = init?.body;
  let sent: string | Uint8Array | undefined;
  if (body === undefined || body === null) sent = undefined;
  else if (typeof body === 'string' || body instanceof Uint8Array) sent = body;
  else if (body instanceof ArrayBuffer) sent = new Uint8Array(body);
  else throw new TypeError('a worker request body is a string or bytes');
  return {
    ...(init?.method === undefined ? {} : { method: init.method }),
    ...(init?.headers === undefined ? {} : { headers: [...new Headers(init.headers).entries()] }),
    ...(sent === undefined ? {} : { body: sent }),
  };
}

/**
 * HTTP to the hosts the half granted at `kernel.workers.start(url, { network })`, through the main thread's own `kernel.fetch`
 * guard: another host, and a redirect to another host, is refused. A redirect is returned as it is (never followed),
 * and the body arrives whole (capped). Without a grant it throws naming the missing grant.
 */
export function fetchPort(data: unknown = workerData): FetchPort {
  const grants = grantsOf(data);
  if (grants === undefined || !grants.network)
    throw new TypeError('network: not granted to this worker (start it with `network: true`)');
  const channel = channelOf(grants.port);
  return {
    request: async (url, init) => {
      const wire = await initOf(init);
      const answer = (await channel.ask(
        id => ({ id, kind: 'fetch', url: String(url), init: wire }),
        init?.signal,
      )) as WorkerFetchAnswer;
      const empty = answer.status === 101 || answer.status === 204 || answer.status === 205 || answer.status === 304;
      return new Response(empty ? null : (answer.body as BodyInit), {
        status: answer.status,
        statusText: answer.statusText,
        headers: answer.headers.map(([k, v]) => [k, v] as [string, string]),
      });
    },
  };
}
