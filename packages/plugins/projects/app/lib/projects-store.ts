/**
 * THE REGISTERED-PROJECT LIST, hydrated once and read as a slice.
 *
 * IT KEEPS THE WHOLE RECORD. An earlier shape narrowed each row to `{ name, path }` on the grounds that grouping needs
 * no more, which made every other field permanently `undefined`: no surface could say where a registered folder came
 * from. The contract owns the record, so parsed rows are passed through whole.
 *
 * ONE DAEMON. The shell hands this half one client already bound to one daemon and its credential, so there is no
 * daemon key here: a project path is meaningful only on the machine that reported it, and a re-pair gives the shell a
 * new client and so a new store. A store never outlives the credential it read under.
 */
import type { ProjectInfo } from '../../contract/index.ts';

type ProjectsLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The daemon's registered folders. `projects` is `null` until a read settles — a different fact from an empty array,
 * which means "this daemon registers no projects" and is the honest answer that makes every folder a discovery.
 */
export interface ProjectsSlice {
  readonly projects: readonly ProjectInfo[] | null;
  readonly status: ProjectsLoadStatus;
  readonly error: string | null;
}

/** The one daemon read this store needs, injected rather than imported. */
export interface ProjectsReader {
  projects(): Promise<readonly ProjectInfo[]>;
}

const IDLE_SLICE: ProjectsSlice = Object.freeze({ projects: null, status: 'idle' as const, error: null });

/** A shared empty identity, so an unhydrated store does not re-render readers. */
export const NO_PROJECTS: readonly ProjectInfo[] = Object.freeze([]);

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

export class ProjectsStore {
  readonly #reader: ProjectsReader;
  readonly #listeners = new Set<() => void>();
  #inflight: Promise<readonly ProjectInfo[]> | undefined;
  /**
   * THE NEWEST READ ISSUED, and the reason coalescing alone is not enough. `refresh` issues a second read right after
   * a write; without this token the earlier read — computed before the folder existed — publishes its pre-write list
   * on top of the post-write list whenever it settles second. Reads do not resolve in the order they were issued.
   */
  #latestRead: object | undefined;
  #slice: ProjectsSlice = IDLE_SLICE;

  constructor(reader: ProjectsReader) {
    this.#reader = reader;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): ProjectsSlice => this.#slice;

  /** The rows grouping consumes: an unread store answers the shared empty. */
  projects(): readonly ProjectInfo[] {
    return this.#slice.projects ?? NO_PROJECTS;
  }

  /** Reads the registry once; a burst of callers makes ONE request. */
  hydrate(): Promise<readonly ProjectInfo[]> {
    if (this.#inflight !== undefined) return this.#inflight;
    const read = {};
    this.#latestRead = read;
    this.#patch({ status: 'loading' });
    const request = this.#reader
      .projects()
      .then(projects => {
        if (this.#latestRead === read) this.#patch({ projects, status: 'ready', error: null });
        return projects;
      })
      .catch((reason: unknown) => {
        // A failed read never blanks a good list: the folders stay and the reader is told the refresh failed rather
        // than shown a registry that reads as "registers nothing".
        if (this.#latestRead === read) this.#patch({ status: 'error', error: failureMessage(reason) });
        throw reason;
      })
      .finally(() => {
        if (this.#inflight === request) this.#inflight = undefined;
      });
    this.#inflight = request;
    return request;
  }

  /**
   * Re-reads after the registry changed. `hydrate` deliberately coalesces, which is right for a burst of readers and
   * wrong immediately after a write: the answer already in flight was computed before the folder existed. The list
   * stays on screen while the re-read runs, because `hydrate` patches `status` without touching `projects`.
   */
  refresh(): Promise<readonly ProjectInfo[]> {
    this.#inflight = undefined;
    return this.hydrate();
  }

  #patch(patch: Partial<ProjectsSlice>): void {
    this.#slice = { ...this.#slice, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
