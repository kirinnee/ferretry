/**
 * What the GitHub watcher needs from the rest of the daemon and from the host, as ports.
 *
 * GitHub is reached ONLY through {@link GhRunner}: the host's own `gh` CLI, run as a child with the host's
 * own sign-in. The watcher never reads, holds or stores a token — the secret store's "use, never read"
 * holds because there is nothing here that could read one.
 */
import type {
  BoardProjectId,
  BoardTask,
  BoardTaskActionRequest,
  BoardTaskId,
  BoardTaskResponse,
} from '@ferretry/protocol';
import type { BoardCaller, LaneSets, PrUpdate, PrUpdateOutcome } from '../board/index.ts';

/**
 * What one `gh` run came to. `missing` and `unauthenticated` say the host cannot reach GitHub at all, so
 * the watcher backs off everything; `failed` is about this one call, and keeps what `gh` printed, because
 * a GraphQL answer with one unresolvable field still carries the rest.
 */
export type GhOutcome =
  | { readonly kind: 'ok'; readonly stdout: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unauthenticated'; readonly detail: string }
  | { readonly kind: 'failed'; readonly detail: string; readonly stdout: string };

/** Runs the host's `gh` with these arguments, bounded in time. Never throws. */
export interface GhRunner {
  run(args: readonly string[]): Promise<GhOutcome>;
}

/** A git working copy on this host. Each answer is `null` when the folder cannot say. */
export interface WorkingCopies {
  /** The GitHub repository (`owner/name`) the folder's `origin` remote names. */
  repositoryOf(path: string): Promise<string | null>;
  /** The branch checked out in the folder; `null` when detached or not a repository. */
  branchOf(path: string): Promise<string | null>;
}

/** Where a session works: its `cwd`, or `null` for a session this daemon does not know. */
export interface SessionFolders {
  cwdOf(sessionId: string): Promise<string | null>;
}

/** The registered projects, in registry order. */
export interface ProjectFolders {
  projects(): Promise<readonly { readonly id: BoardProjectId; readonly name: string; readonly path: string }[]>;
}

/** The board, as the watcher reads and writes it: through `BoardService`, as the daemon. */
export interface WatchedBoard {
  snapshot(): Promise<{ readonly cards: readonly BoardTask[]; readonly laneSets: LaneSets }>;
  recordPullRequests(id: BoardTaskId, update: PrUpdate): Promise<PrUpdateOutcome>;
  act(id: BoardTaskId, request: BoardTaskActionRequest, caller: BoardCaller): Promise<BoardTaskResponse>;
}

/** Queues one message to a ferret through the ordinary send path. */
export interface PrNudgeSender {
  send(sessionId: string, message: string): Promise<void>;
}

/** One-shot timers. `after` returns the cancel; `run` settles when the work it started is done. */
export interface WatcherTimers {
  after(ms: number, run: () => Promise<void>): () => void;
}

export interface WatcherClock {
  /** The instant now. */
  now(): string;
  /** A number in [0, 1), for jitter. */
  random(): number;
}
