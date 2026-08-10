/**
 * THE REGISTERED-PROJECT CATALOG, ONE LIST PER PAIRED DAEMON.
 *
 * `fleet-grouping.ts` and `hooks/use-fleet-view.ts` both carried a note saying
 * "PROJECTS ARE NOT YET SERVED — Ferretry has no `/v1/projects`, so `projects`
 * is empty in practice and every session falls to the cwd-basename group". PR
 * #135 landed that route, so this module is the client half that makes the
 * registered-path branch of `projectKeyFor` — the half that decides which of
 * two NESTED folders a worktree belongs to — do real work.
 *
 * IT KEEPS THE WHOLE RECORD. An earlier version narrowed each row to
 * `{ name, path }` on the grounds that grouping needs no more, which made every
 * other field permanently `undefined` in the browser: the folder picker put
 * `source` in its search haystack and typing `clone` matched nothing, and no
 * surface could say where a registered folder came from. `@ferretry/protocol`
 * owns the record, so the parsed rows are passed through whole and the grouping
 * shape is a view of that type rather than a narrowing of it.
 *
 * WHY IT IS NOT IN `fleet-store.ts`. That store owns one thing, the session
 * list, and its port has exactly two reads. Projects change when someone clones
 * a repository, not when a session starts, so they hydrate once per daemon
 * rather than riding every list refresh. Keeping them apart also keeps a failed
 * catalog read from being able to mark the FLEET errored.
 *
 * MULTI-DAEMON. A project path is meaningful only on the machine that reported
 * it: `/home/k/ferretry` exists on both a laptop and a workstation and is not
 * the same checkout. Every read and write here names a `DaemonId`, there is no
 * daemon-free lookup, and a re-pair (a changed base URL or device token) drops
 * the list rather than serving folders read under a replaced credential.
 */

import { ProjectListSchema } from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import type { FleetProject } from './fleet-grouping.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

export type ProjectsLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * One daemon's registered folders.
 *
 * `projects` is `null` until a read settles — a different fact from an empty
 * array, which means "this daemon registers no projects" and is the honest
 * answer that makes every session group by its cwd basename.
 */
export interface DaemonProjectsSlice {
  readonly projects: readonly FleetProject[] | null;
  readonly status: ProjectsLoadStatus;
  readonly error: string | null;
}

export interface ProjectsSnapshot {
  readonly daemons: ReadonlyMap<DaemonId, DaemonProjectsSlice>;
}

/** The one daemon read this store needs, injected rather than imported. */
export interface DaemonProjectsPort {
  projects(daemon: DaemonConnection): Promise<readonly FleetProject[]>;
}

const IDLE_SLICE: DaemonProjectsSlice = Object.freeze({
  projects: null,
  status: 'idle' as const,
  error: null,
});

/** A shared empty identity, so an unhydrated daemon does not re-render readers. */
export const NO_PROJECTS: readonly FleetProject[] = Object.freeze([]);

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/**
 * Reads `/v1/projects` from exactly the paired daemon and answers with the
 * parsed rows unchanged. `ProjectListSchema` is the only definition of that
 * shape, and a row keeps its `id`, `source`, `createdAt` and Git attachment so a
 * surface can state a folder's provenance without asking the daemon again.
 */
export const fetchDaemonProjects = async (
  daemon: DaemonConnection,
  fetcher: DaemonFetch = browserFetch,
): Promise<readonly FleetProject[]> => {
  const request = daemonRequest(daemon, '/v1/projects');
  const send = fetcher;
  const response = await send(request.url, request.init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    throw new DaemonResponseError(
      response.status,
      typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
      typeof body.code === 'string' ? body.code : undefined,
    );
  }
  return ProjectListSchema.parse(await response.json());
};

/** The browser port over `fetchDaemonProjects`. */
export const daemonProjectsPort = (fetcher: DaemonFetch = browserFetch): DaemonProjectsPort => ({
  projects: daemon => fetchDaemonProjects(daemon, fetcher),
});

interface ProjectsEntry {
  readonly daemonId: DaemonId;
  readonly baseUrl: string;
  readonly deviceToken: string;
}

export class DaemonProjectsStore {
  readonly #port: DaemonProjectsPort;
  readonly #entries = new Map<DaemonId, ProjectsEntry>();
  readonly #slices = new Map<DaemonId, DaemonProjectsSlice>();
  readonly #inflight = new Map<DaemonId, { entry: ProjectsEntry; request: Promise<readonly FleetProject[]> }>();
  /**
   * THE NEWEST READ ISSUED FOR EACH DAEMON, and the reason a credential check is
   * not enough on its own.
   *
   * `#isCurrent` asks "was this read issued with the credential still in force",
   * which two reads of the SAME connection both answer yes to. `refresh` issues
   * exactly that second read, so without this token the earlier one — computed
   * before the folder existed — publishes its pre-write list on top of the
   * post-write list whenever it settles second. Reads do not resolve in the order
   * they were issued, and the one that answers last wins the slice.
   */
  readonly #latestRead = new Map<DaemonId, object>();
  readonly #listeners = new Set<() => void>();
  #snapshot: ProjectsSnapshot = { daemons: new Map() };

  constructor(port: DaemonProjectsPort) {
    this.#port = port;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): ProjectsSnapshot => this.#snapshot;

  /** One daemon's slice, or the shared idle value before its first read. */
  slice(daemonId: DaemonId): DaemonProjectsSlice {
    return this.#slices.get(daemonId) ?? IDLE_SLICE;
  }

  /** The rows grouping consumes: an unread daemon answers the shared empty. */
  projects(daemonId: DaemonId): readonly FleetProject[] {
    return this.slice(daemonId).projects ?? NO_PROJECTS;
  }

  /**
   * Reads a daemon's catalog once. A burst of callers makes ONE request per
   * daemon, and two daemons never share work however alike their ids look.
   *
   * Coalescing is keyed by the CONNECTION entry, not by the daemon id alone: a
   * re-paired connection must not be handed the answer to a request issued
   * with the credential it replaced.
   */
  hydrate(daemon: DaemonConnection): Promise<readonly FleetProject[]> {
    const entry = this.#entryFor(daemon);
    const pending = this.#inflight.get(daemon.daemonId);
    if (pending !== undefined && pending.entry === entry) return pending.request;
    const read = {};
    this.#latestRead.set(daemon.daemonId, read);
    this.#patch(daemon.daemonId, { status: 'loading' });
    const request = this.#port
      .projects(daemon)
      .then(projects => {
        if (this.#publishes(daemon.daemonId, entry, read))
          this.#patch(daemon.daemonId, { projects, status: 'ready', error: null });
        return projects;
      })
      .catch((reason: unknown) => {
        // A failed read never blanks a good list: the folders stay and the
        // reader is told the refresh failed rather than shown an ungrouped
        // fleet that reads as "this daemon registers nothing".
        if (this.#publishes(daemon.daemonId, entry, read))
          this.#patch(daemon.daemonId, { status: 'error', error: failureMessage(reason) });
        throw reason;
      })
      .finally(() => {
        if (this.#inflight.get(daemon.daemonId)?.request === request) this.#inflight.delete(daemon.daemonId);
      });
    this.#inflight.set(daemon.daemonId, { entry, request });
    return request;
  }

  /**
   * Re-reads ONE daemon's catalog after that daemon's registry has changed.
   *
   * `hydrate` deliberately coalesces, which is right for a burst of readers and
   * wrong immediately after a write: the answer already in flight was computed
   * before the folder existed. Dropping this daemon's coalescing slot is the
   * whole difference, and it drops nothing belonging to any other daemon — a
   * registration on the laptop must not make the workstation re-read.
   *
   * The list stays on screen while the re-read runs, because `hydrate` patches
   * `status` without touching `projects`.
   *
   * Dropping the slot is not enough on its own: the abandoned read is still
   * RUNNING and still holds the current credential, so it would publish its
   * pre-write list if it settled second. `#latestRead` is what makes this
   * re-read the only one whose answer can reach the slice.
   */
  refresh(daemon: DaemonConnection): Promise<readonly FleetProject[]> {
    this.#inflight.delete(daemon.daemonId);
    return this.hydrate(daemon);
  }

  /** Drops one disconnected daemon's folders and leaves every other daemon's. */
  clearDaemon(daemonId: DaemonId): boolean {
    this.#entries.delete(daemonId);
    this.#latestRead.delete(daemonId);
    const had = this.#slices.delete(daemonId);
    if (had) this.#publish();
    return had;
  }

  #entryFor(daemon: DaemonConnection): ProjectsEntry {
    const existing = this.#entries.get(daemon.daemonId);
    if (existing?.baseUrl === daemon.baseUrl && existing.deviceToken === daemon.deviceToken) return existing;
    this.#slices.delete(daemon.daemonId);
    const entry: ProjectsEntry = {
      daemonId: daemon.daemonId,
      baseUrl: daemon.baseUrl,
      deviceToken: daemon.deviceToken,
    };
    this.#entries.set(daemon.daemonId, entry);
    return entry;
  }

  /**
   * Two independent questions, and a read has to answer both to publish: was it
   * issued under the credential still in force, and is it still the NEWEST read
   * for this daemon. The first stops a revoked token's answer being served; the
   * second stops an older read of the same connection overwriting a newer one.
   */
  #publishes(daemonId: DaemonId, entry: ProjectsEntry, read: object): boolean {
    return this.#entries.get(daemonId) === entry && this.#latestRead.get(daemonId) === read;
  }

  #patch(daemonId: DaemonId, patch: Partial<DaemonProjectsSlice>): void {
    this.#slices.set(daemonId, { ...this.slice(daemonId), ...patch });
    this.#publish();
  }

  #publish(): void {
    this.#snapshot = { daemons: new Map(this.#slices) };
    for (const listener of this.#listeners) listener();
  }
}
