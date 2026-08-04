import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { daemonSessionKey, type DaemonSessionScope } from '../lib/daemon-scope.ts';
import { daemonRequest } from '../lib/daemon-transport.ts';
import { DaemonResponseError, type DaemonFetch } from '../lib/runtime-models.ts';
import { baseName, isOpenableName, isOpenablePath, parentRel } from './files-model.ts';

export type FsEntryType = 'file' | 'dir' | 'symlink';
export interface FsEntry {
  name: string;
  type: FsEntryType;
  size?: number;
  mtime?: number | string;
  ignored?: boolean;
  denied?: boolean;
  escapes?: boolean;
}
export interface FsListing {
  root?: string;
  path?: string;
  entries: FsEntry[];
  truncated?: boolean;
}
export interface FsChange {
  path: string;
  status: string;
  from?: string;
  additions?: number;
  deletions?: number;
}
export interface FsChanges {
  repo: boolean;
  branch?: string;
  changes: FsChange[];
  truncated?: boolean;
}
export interface FsFile {
  path: string;
  size?: number;
  mtime?: number | string;
  lang?: string;
  binary?: boolean;
  tooLarge?: boolean;
  denied?: boolean;
  ignored?: boolean;
  content?: string;
}

const assertScopeDaemon = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('file scope must belong to the requested daemon');
};
const root = (scope: DaemonSessionScope) => `/v1/sessions/${encodeURIComponent(scope.sessionId)}/fs`;
const query = (path: string, extra?: Record<string, string>): string => {
  const params = new URLSearchParams(extra);
  if (path) params.set('path', path);
  const value = params.toString();
  return value ? `?${value}` : '';
};
export const listUrl = (scope: DaemonSessionScope, path: string) => `${root(scope)}${query(path)}`;
export const fileUrl = (scope: DaemonSessionScope, path: string, rev?: 'head') =>
  `${root(scope)}/file${query(path, rev ? { rev } : undefined)}`;
export const changesUrl = (scope: DaemonSessionScope) => `${root(scope)}/changes`;
export const diffUrl = (scope: DaemonSessionScope, path: string) => `${root(scope)}/diff${query(path)}`;
const failure = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};
const request = async <T>(
  daemon: DaemonConnection,
  path: string,
  fetcher: DaemonFetch = fetch,
  signal?: AbortSignal,
): Promise<T> => {
  const target = daemonRequest(daemon, path, { signal });
  const response = await fetcher(target.url, target.init);
  if (!response.ok) throw await failure(response);
  return (response.headers.get('content-type') ?? '').includes('application/json')
    ? ((await response.json()) as T)
    : ((await response.text()) as T);
};
export const fsApi = {
  list: (
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    path: string,
    signal?: AbortSignal,
    fetcher?: DaemonFetch,
  ) => {
    assertScopeDaemon(daemon, scope);
    return request<FsListing>(daemon, listUrl(scope, path), fetcher, signal);
  },
  file: (
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    path: string,
    rev?: 'head',
    signal?: AbortSignal,
    fetcher?: DaemonFetch,
  ) => {
    assertScopeDaemon(daemon, scope);
    return request<FsFile>(daemon, fileUrl(scope, path, rev), fetcher, signal);
  },
  changes: (daemon: DaemonConnection, scope: DaemonSessionScope, signal?: AbortSignal, fetcher?: DaemonFetch) => {
    assertScopeDaemon(daemon, scope);
    return request<FsChanges>(daemon, changesUrl(scope), fetcher, signal);
  },
  diff: (
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    path: string,
    signal?: AbortSignal,
    fetcher?: DaemonFetch,
  ) => {
    assertScopeDaemon(daemon, scope);
    return request<string>(daemon, diffUrl(scope, path), fetcher, signal);
  },
};

export const codeReferenceRelativePath = (candidate: string, cwd?: string): string | null => {
  let value = candidate;
  if (value.startsWith('/')) {
    const base = cwd?.replace(/\/+$/u, '');
    if (!base?.startsWith('/') || value === base || !value.startsWith(`${base}/`)) return null;
    value = value.slice(base.length + 1);
  } else if (value.startsWith('./')) value = value.slice(2);
  return isOpenablePath(value) ? value : null;
};
const pendingListings = new Map<string, Promise<FsListing>>();
const listing = (daemon: DaemonConnection, scope: DaemonSessionScope, directory: string): Promise<FsListing> => {
  const key = JSON.stringify([daemon.daemonId, scope.sessionId, directory]);
  const existing = pendingListings.get(key);
  if (existing) return existing;
  const next = fsApi.list(daemon, scope, directory).finally(() => {
    if (pendingListings.get(key) === next) pendingListings.delete(key);
  });
  pendingListings.set(key, next);
  return next;
};
const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
const waitForListing = (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  directory: string,
  signal?: AbortSignal,
): Promise<FsListing> => {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const next = listing(daemon, scope, directory);
  if (!signal) return next;
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    void next.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
};
export const isAbort = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : (error as { name?: string })?.name === 'AbortError';
export const resolveFsFilePaths = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  candidates: readonly string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> => {
  assertScopeDaemon(daemon, scope);
  const directories = new Map<string, Array<{ authored: string; relative: string }>>();
  for (const authored of new Set(candidates)) {
    const relative = codeReferenceRelativePath(authored, cwd);
    if (!relative) continue;
    const directory = parentRel(relative);
    const rows = directories.get(directory) ?? [];
    rows.push({ authored, relative });
    directories.set(directory, rows);
  }
  const result = new Map<string, string>();
  await Promise.all(
    [...directories].map(async ([directory, rows]) => {
      let found: FsListing;
      try {
        found = await waitForListing(daemon, scope, directory, signal);
      } catch (error) {
        if (signal?.aborted || isAbort(error)) throw error;
        return;
      }
      const entries = new Map(found.entries.map(entry => [entry.name, entry]));
      for (const row of rows) {
        const entry = entries.get(baseName(row.relative));
        if (entry?.type === 'file' && isOpenableName(entry.name) && !entry.denied && !entry.ignored && !entry.escapes)
          result.set(row.authored, row.relative);
      }
    }),
  );
  return result;
};
export const isUnknownRoute = (error: unknown): boolean =>
  error instanceof DaemonResponseError && error.status === 404 && error.code === 'unknown_route';
/**
 * The daemon cannot serve this surface on the machine it runs on — a condition no retry changes.
 *
 * Matched on the CODE rather than on the status, because 501 is a shape a proxy or a tunnel can also
 * produce, and prose is not a contract.
 */
export const isUnsupported = (error: unknown): boolean =>
  error instanceof DaemonResponseError && error.code === 'unsupported';
export const describeFsError = (error: unknown): string =>
  error instanceof TypeError ? 'could not reach the daemon' : error instanceof Error ? error.message : String(error);

/**
 * `absent` is an older daemon with no such route; `unsupported` is a daemon that HAS the route and
 * cannot serve it on its machine. They are separate because they earn different surfaces: the first
 * hides the tab, the second states a reason once and offers nothing to retry.
 */
export type FsProbeState = 'probing' | 'ready' | 'absent' | 'error' | 'unsupported';
export interface FsProbeSnapshot {
  state: FsProbeState;
  changes: FsChanges | null;
  error: string | null;
  refreshing: boolean;
}
interface ProbeRecord {
  snapshot: FsProbeSnapshot;
  listeners: Set<() => void>;
  seq: number;
  inflight: boolean;
}
const initial: FsProbeSnapshot = { state: 'probing', changes: null, error: null, refreshing: false };
const probes = new Map<string, ProbeRecord>();
const recordFor = (scope: DaemonSessionScope): ProbeRecord => {
  const key = daemonSessionKey(scope);
  let record = probes.get(key);
  if (!record) {
    record = { snapshot: initial, listeners: new Set(), seq: 0, inflight: false };
    probes.set(key, record);
  }
  return record;
};
const publish = (record: ProbeRecord, next: Partial<FsProbeSnapshot>) => {
  record.snapshot = { ...record.snapshot, ...next };
  for (const listener of record.listeners) listener();
};
export const loadFsChanges = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  force = false,
): Promise<void> => {
  assertScopeDaemon(daemon, scope);
  const record = recordFor(scope);
  if (record.inflight && !force) return;
  // `unsupported` settles with `absent`: both are facts about the daemon rather than a moment, so
  // re-asking only spends a request to be told the same thing.
  if (!force && ['ready', 'absent', 'unsupported'].includes(record.snapshot.state)) return;
  const seq = ++record.seq;
  record.inflight = true;
  publish(record, record.snapshot.changes ? { refreshing: true, error: null } : { state: 'probing', error: null });
  try {
    const changes = await fsApi.changes(daemon, scope);
    if (record.seq === seq) publish(record, { state: 'ready', changes, error: null, refreshing: false });
  } catch (error) {
    if (record.seq !== seq) return;
    // The daemon's own words are KEPT for `unsupported`: they are the only place the reason is stated,
    // and the pane shows them under a disclosure rather than dropping them.
    publish(
      record,
      isUnknownRoute(error)
        ? { state: 'absent', changes: null, error: null, refreshing: false }
        : isUnsupported(error)
          ? { state: 'unsupported', changes: null, error: describeFsError(error), refreshing: false }
          : { state: 'error', error: describeFsError(error), refreshing: false },
    );
  } finally {
    if (record.seq === seq) record.inflight = false;
  }
};
export const readFsProbe = (scope: DaemonSessionScope): FsProbeSnapshot => recordFor(scope).snapshot;
export const resetFsProbes = (): void => {
  probes.clear();
  pendingListings.clear();
};
/**
 * `unsupported` KEEPS the tab. A daemon that refuses the whole surface is a thing a reader has to be
 * told once; silently dropping the tab leaves them hunting for a feature they were promised.
 */
export const fsTabAvailable = (state: FsProbeState): boolean =>
  state === 'ready' || state === 'error' || state === 'unsupported';
export interface FsProbe extends FsProbeSnapshot {
  refresh: () => void;
}
export const useFsProbe = (daemon: DaemonConnection, scope: DaemonSessionScope): FsProbe => {
  assertScopeDaemon(daemon, scope);
  const subscribe = useCallback(
    (listener: () => void) => {
      const record = recordFor(scope);
      record.listeners.add(listener);
      return () => record.listeners.delete(listener);
    },
    [scope],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => recordFor(scope).snapshot,
    () => recordFor(scope).snapshot,
  );
  useEffect(() => {
    if (recordFor(scope).snapshot.state === 'probing' && !recordFor(scope).inflight) void loadFsChanges(daemon, scope);
  }, [daemon, scope]);
  return { ...snapshot, refresh: () => void loadFsChanges(daemon, scope, true) };
};
