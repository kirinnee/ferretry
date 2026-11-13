import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { z } from 'zod';
import { callFailure } from '../../lib/client.ts';
import { grantRefusalSentence } from './refusal-words.ts';
import { type FilesScope, scopeKey } from './scope.ts';
import { type FsChanges, FsChangesSchema, type FsFile, FsFileSchema, type FsListing, FsListingSchema } from './wire.ts';

// The wire shapes are `wire.ts`'s. These names stay because the views already speak them.
export type { FsChanges, FsFile, FsListing };

/** A read this page could not trust: the daemon answered with a body that is not the shape the route declares. */
export class UnreadableAnswerError extends Error {
  readonly status = 502;
  constructor() {
    super('the daemon answered with a body this page cannot read');
    this.name = 'UnreadableAnswerError';
  }
}

/** Route keys, as the manifest declares them. */
const LIST = 'GET /v1/ferrets/:ferretId/fs';
const FILE = 'GET /v1/ferrets/:ferretId/fs/file';
const CHANGES = 'GET /v1/ferrets/:ferretId/fs/changes';
const DIFF = 'GET /v1/ferrets/:ferretId/fs/diff';

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');

/**
 * One file-surface read through the half's own client, by route key. A caller that stopped waiting (`signal`) never
 * sees a late answer: the client call itself cannot be cancelled, so the answer is dropped here.
 */
const read = async (
  scope: FilesScope,
  route: string,
  query: Readonly<Record<string, string>> | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> => {
  if (signal?.aborted) throw abortReason(signal);
  const answer = await scope.client.call<unknown>(route, {
    params: { ferretId: scope.ferretId },
    ...(query === undefined ? {} : { query }),
  });
  if (signal?.aborted) throw abortReason(signal);
  return answer;
};

const pathQuery = (path: string, extra?: Record<string, string>): Record<string, string> | undefined => {
  const query: Record<string, string> = { ...extra };
  if (path) query.path = path;
  return Object.keys(query).length === 0 ? undefined : query;
};

/** A JSON answer, PARSED. A listing decides which entries are offered as openable, so a cast would let any body promote a path. */
const readJson = async <Schema extends z.ZodType>(
  schema: Schema,
  scope: FilesScope,
  route: string,
  query: Readonly<Record<string, string>> | undefined,
  signal: AbortSignal | undefined,
): Promise<z.output<Schema>> => {
  const parsed = schema.safeParse(await read(scope, route, query, signal));
  if (!parsed.success) throw new UnreadableAnswerError();
  return parsed.data;
};

export const fsApi = {
  list: (scope: FilesScope, path: string, signal: AbortSignal | undefined): Promise<FsListing> =>
    readJson(FsListingSchema, scope, LIST, pathQuery(path), signal),
  file: (scope: FilesScope, path: string, rev: 'head' | undefined, signal: AbortSignal | undefined): Promise<FsFile> =>
    readJson(FsFileSchema, scope, FILE, pathQuery(path, rev ? { rev } : undefined), signal),
  /** The bounded byte representation, for a rich preview: the SAME route and the same daemon-side gates as `file`. */
  preview: (scope: FilesScope, path: string, signal: AbortSignal | undefined): Promise<FsFile> =>
    readJson(FsFileSchema, scope, FILE, pathQuery(path, { format: 'base64' }), signal),
  changes: (scope: FilesScope, signal: AbortSignal | undefined): Promise<FsChanges> =>
    readJson(FsChangesSchema, scope, CHANGES, undefined, signal),
  /** The one text answer: a unified diff. An empty diff arrives as no body at all. */
  diff: async (scope: FilesScope, path: string, signal: AbortSignal | undefined): Promise<string> => {
    const body = await read(scope, DIFF, pathQuery(path), signal);
    if (body === undefined) return '';
    if (typeof body !== 'string') throw new UnreadableAnswerError();
    return body;
  },
};

export const isAbort = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : (error as { name?: string })?.name === 'AbortError';

/** The daemon has no such route (a daemon without Ferrets' file browser): the tab is simply not offered. */
export const isUnknownRoute = (error: unknown): boolean => {
  const failure = callFailure(error);
  return failure?.status === 404 && failure.code === 'unknown_route';
};

/**
 * The daemon cannot serve this surface on the machine it runs on (the root walk is not bound, or the platform lacks
 * it) — a condition no retry changes. Matched on the CODE rather than the status, because 501 and 503 are shapes a
 * proxy or a tunnel can also produce, and prose is not a contract.
 */
const isUnsupported = (error: unknown): boolean => {
  const failure = callFailure(error);
  // `unsupported`: the machine lacks the mechanism. `plugin_unavailable` (503): the daemon's root walk is not bound yet.
  return failure?.code === 'unsupported' || (failure?.status === 503 && failure.code === 'plugin_unavailable');
};

/**
 * The sentence a failed file read shows.
 *
 * A GRANT REFUSAL IS WORDED AS ONE: the operator switched `filesystem` off, a passkey confirmation is needed, or the
 * daemon cannot read its own decision. A pane that showed only "HTTP 403" would send a person to look at the network
 * for a limit somebody chose on purpose.
 */
export const describeFsError = (error: unknown): string => {
  const grant = grantRefusalSentence(error);
  if (grant !== null) return grant;
  return error instanceof TypeError
    ? 'could not reach the daemon'
    : error instanceof Error
      ? error.message
      : String(error);
};

/**
 * `absent` is a daemon with no such route; `unsupported` is a daemon that HAS the route and cannot serve it on its
 * machine. They earn different surfaces: the first hides the tab, the second states a reason once and offers nothing
 * to retry.
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
const recordFor = (scope: FilesScope): ProbeRecord => {
  const key = scopeKey(scope);
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
export const loadFsChanges = async (scope: FilesScope, force = false): Promise<void> => {
  const record = recordFor(scope);
  if (record.inflight && !force) return;
  // `unsupported` settles with `absent`: both are facts about the daemon rather than a moment, so re-asking only spends
  // a request to be told the same thing.
  if (!force && ['ready', 'absent', 'unsupported'].includes(record.snapshot.state)) return;
  const seq = ++record.seq;
  record.inflight = true;
  publish(record, record.snapshot.changes ? { refreshing: true, error: null } : { state: 'probing', error: null });
  try {
    const changes = await fsApi.changes(scope, undefined);
    if (record.seq === seq) publish(record, { state: 'ready', changes, error: null, refreshing: false });
  } catch (error) {
    if (record.seq !== seq) return;
    // The daemon's own words are KEPT for `unsupported`: they are the only place the reason is stated, and the pane
    // shows them under a disclosure rather than dropping them.
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
export const readFsProbe = (scope: FilesScope): FsProbeSnapshot => recordFor(scope).snapshot;
export const resetFsProbes = (): void => {
  probes.clear();
};
/**
 * `unsupported` KEEPS the tab. A daemon that refuses the whole surface is a thing a reader has to be told once;
 * silently dropping the tab leaves them hunting for a feature they were promised.
 */
export const fsTabAvailable = (state: FsProbeState): boolean =>
  state === 'ready' || state === 'error' || state === 'unsupported';
export interface FsProbe extends FsProbeSnapshot {
  refresh: () => void;
}
export const useFsProbe = (scope: FilesScope): FsProbe => {
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
    if (recordFor(scope).snapshot.state === 'probing' && !recordFor(scope).inflight) void loadFsChanges(scope);
  }, [scope]);
  return { ...snapshot, refresh: () => void loadFsChanges(scope, true) };
};
