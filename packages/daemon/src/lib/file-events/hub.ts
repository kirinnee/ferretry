import { basename, dirname } from 'node:path';
import {
  type DirectoryWatchHandle,
  type DirectoryWatchUnavailable,
  type FileEventSource,
  type FileEventTimers,
  type FileStamp,
  sameDirectory,
  sameFileStamp,
} from './ports.ts';

/** How long a directory's events are gathered before what they touched is re-stat-ed once. */
export const FILE_EVENT_SETTLE_MS = 25;
/** How often a directory that cannot be watched with events is stat-ed instead. */
export const FILE_EVENT_POLL_MS = 5_000;

/** Called with the subscribed path when it may have changed. It must not throw; a throw is swallowed. */
export type FileEventListener = (path: string) => void;

export interface FileSubscription {
  /**
   * Whether a change to the path is reported by an event right now. When it is not — the directory is
   * missing, polled, or the name is one the platform never reports — a change still reaches the listener,
   * but only as late as the next poll, so a reader that must be current checks for itself.
   */
  live(): boolean;
  /** Stop listening. Idempotent. */
  close(): void;
}

type FileEventFallbackReason = DirectoryWatchUnavailable | 'unreported-name';

/** A directory the hub polls instead of watching, and why: what the profiler prints as a limitation. */
export interface FileEventFallback {
  readonly directory: string;
  readonly reason: FileEventFallbackReason;
  readonly detail: string;
}

export interface FileEventHubOptions {
  readonly settleMs?: number;
  readonly pollMs?: number;
}

/** Not stat-ed yet: the first look at a path counts as a change, because nothing proves it is not one. */
const UNSEEN = Symbol('unseen');
type Seen = FileStamp | undefined | typeof UNSEEN;

interface WatchedFile {
  readonly path: string;
  readonly listeners: Set<FileEventListener>;
  /** Whether the platform reports a change to this name at all; a file it does not is polled. */
  readonly reported: boolean;
  stamp: Seen;
}

type DirectoryMode =
  | { readonly kind: 'watching'; readonly identity: FileStamp; readonly handle: DirectoryWatchHandle }
  /** The directory does not exist; its parent is watched until it does. */
  | { readonly kind: 'awaiting' }
  | { readonly kind: 'polling'; readonly reason: DirectoryWatchUnavailable; readonly detail: string };

interface WatchedDirectory {
  readonly path: string;
  /** Subscribed files in this directory, by path. */
  readonly files: Map<string, WatchedFile>;
  /** Subscribers to the directory itself. */
  readonly listeners: Set<FileEventListener>;
  /** The hub's own subscribers: child directories that watch this one for their own appearance. */
  readonly children: Set<() => void>;
  mode: DirectoryMode;
  /** Bumped whenever the OS watch is replaced, so a callback from a closed watch is recognised and ignored. */
  generation: number;
  stamp: Seen;
  /** An event arrived since the last check: the directory's own subscribers are told whatever stat says. */
  touched: boolean;
  settle: unknown;
  poll: unknown;
  checking: boolean;
  again: boolean;
  /** Releases this directory's subscription to its parent, held while that parent must be watched. */
  parent: (() => void) | undefined;
}

/**
 * ONE place that turns the platform's file events into "this path may have changed".
 *
 * WHY IT EXISTS. The daemon used to learn that a file changed by reading it again on a timer — a `stat`
 * per document per reader per tick, ~3,000 of them a second on a 45-session fleet. Events cost nothing
 * while nothing changes. But a watcher per reader would be a watcher per file, and on macOS a file watch
 * is a kqueue descriptor per file. So the hub watches DIRECTORIES — one OS watch per directory, however
 * many paths in it are subscribed and by however many readers — and closes it with the last subscriber.
 *
 * FOUR RULES, each closing a way the platform's events lie:
 *
 * - **An event names nothing.** Bun's watcher drops events that arrive in the same millisecond as one of
 *   the same kind (sixty appends across twenty files reported as ONE `change`), an atomic save reports
 *   only its temporary name, and names starting with `.` or `~` are never reported. So any event in a
 *   directory re-stats EVERY subscribed path in it, after a short settle that turns a burst into one
 *   pass, and a listener hears only of a path whose stamp really changed.
 * - **A dead watch is silent.** Deleting or renaming the watched directory itself produces no event and
 *   no error. Every subscribed directory therefore also watches its PARENT, re-checking its own identity
 *   (inode and birth time) on any event there, and re-opens its watch on the new directory.
 * - **A missing directory is waited for, not polled.** The nearest existing ancestor is watched, and the
 *   chain re-opens as each level appears.
 * - **A poll is the fallback, and it says so.** Where a directory cannot be watched (a spent inotify limit,
 *   an unsupported file system, a watch that died) or a name is never reported, that directory alone is
 *   stat-ed every {@link FILE_EVENT_POLL_MS}, the watch is retried on each poll, and {@link fallbacks}
 *   names it and why.
 *
 * It never reads or parses a file. A listener decides what a change means.
 */
export class FileEventHub {
  readonly #directories = new Map<string, WatchedDirectory>();
  readonly #settleMs: number;
  readonly #pollMs: number;

  constructor(
    private readonly source: FileEventSource,
    private readonly timers: FileEventTimers,
    options: FileEventHubOptions = {},
  ) {
    this.#settleMs = options.settleMs ?? FILE_EVENT_SETTLE_MS;
    this.#pollMs = options.pollMs ?? FILE_EVENT_POLL_MS;
  }

  /**
   * Hear when the file at `path` may have changed: written, replaced, created or deleted. The path need
   * not exist, nor its directory. The first check after subscribing reports the path once, unconditionally.
   */
  subscribe(path: string, listener: FileEventListener): FileSubscription {
    const directory = this.#acquire(dirname(path));
    let file = directory.files.get(path);
    if (file === undefined) {
      file = { path, listeners: new Set(), reported: this.source.reports(basename(path)), stamp: UNSEEN };
      directory.files.set(path, file);
    }
    const watched = file;
    // A wrapper per subscription, so one function subscribed twice is two subscriptions to close.
    const own: FileEventListener = changed => listener(changed);
    watched.listeners.add(own);
    this.#sync(directory);
    let open = true;
    return {
      live: () => open && watched.reported && this.#live(directory),
      close: () => {
        if (!open) return;
        open = false;
        watched.listeners.delete(own);
        if (watched.listeners.size === 0 && directory.files.get(path) === watched) directory.files.delete(path);
        this.#release(directory);
      },
    };
  }

  /** Hear when the directory at `path` may have changed: an entry in it written, added or removed. */
  subscribeDirectory(path: string, listener: FileEventListener): FileSubscription {
    const directory = this.#acquire(path);
    const own: FileEventListener = changed => listener(changed);
    directory.listeners.add(own);
    this.#sync(directory);
    let open = true;
    return {
      live: () => open && this.#live(directory),
      close: () => {
        if (!open) return;
        open = false;
        directory.listeners.delete(own);
        this.#release(directory);
      },
    };
  }

  /** Every directory stat-ed on a timer instead of watched, and why. */
  fallbacks(): readonly FileEventFallback[] {
    const fallbacks: FileEventFallback[] = [];
    for (const directory of this.#directories.values()) {
      if (directory.mode.kind === 'polling')
        fallbacks.push({ directory: directory.path, reason: directory.mode.reason, detail: directory.mode.detail });
      else {
        const unreported = [...directory.files.values()]
          .filter(file => !file.reported)
          .map(file => basename(file.path));
        if (unreported.length > 0)
          fallbacks.push({
            directory: directory.path,
            reason: 'unreported-name',
            detail: `the platform watcher never reports ${unreported.join(', ')}`,
          });
      }
    }
    return fallbacks;
  }

  /** Close every watch and timer. Subscriptions outstanding hear nothing more. */
  close(): void {
    for (const directory of [...this.#directories.values()]) this.#dispose(directory);
  }

  #live(directory: WatchedDirectory): boolean {
    return this.#directories.get(directory.path) === directory && directory.mode.kind === 'watching';
  }

  #acquire(path: string): WatchedDirectory {
    const existing = this.#directories.get(path);
    if (existing !== undefined) return existing;
    const directory: WatchedDirectory = {
      path,
      files: new Map(),
      listeners: new Set(),
      children: new Set(),
      mode: { kind: 'awaiting' },
      generation: 0,
      stamp: UNSEEN,
      touched: false,
      settle: undefined,
      poll: undefined,
      checking: false,
      again: false,
      parent: undefined,
    };
    this.#directories.set(path, directory);
    this.#open(directory);
    return directory;
  }

  /** (Re)open the OS watch. Every open after the first may have missed events, so it is checked at once. */
  #open(directory: WatchedDirectory): void {
    const first = directory.generation === 0;
    directory.generation += 1;
    const generation = directory.generation;
    const current = (): boolean =>
      this.#directories.get(directory.path) === directory && directory.generation === generation;
    const opened = this.source.watch(
      directory.path,
      () => {
        if (!current()) return;
        directory.touched = true;
        this.#schedule(directory);
      },
      detail => {
        if (!current()) return;
        this.#closeWatch(directory);
        directory.mode = { kind: 'polling', reason: 'failed', detail };
        directory.touched = true;
        this.#sync(directory);
        this.#schedule(directory);
      },
    );
    directory.mode =
      opened.kind === 'watching'
        ? { kind: 'watching', identity: opened.identity, handle: opened.handle }
        : opened.kind === 'missing'
          ? { kind: 'awaiting' }
          : { kind: 'polling', reason: opened.reason, detail: opened.detail };
    this.#sync(directory);
    if (!first) {
      directory.touched = true;
      this.#schedule(directory);
    }
  }

  #closeWatch(directory: WatchedDirectory): void {
    // A later callback from the closed watch must not touch the next one.
    directory.generation += 1;
    if (directory.mode.kind === 'watching') directory.mode.handle.close();
    directory.mode = { kind: 'awaiting' };
  }

  /** Hold exactly the parent subscription and poll timer the directory's state needs, and no other. */
  #sync(directory: WatchedDirectory): void {
    if (this.#directories.get(directory.path) !== directory) return;
    const subscribed = directory.files.size > 0 || directory.listeners.size > 0;
    const parentPath = dirname(directory.path);
    // A directory with subscribers watches its parent to notice it was deleted or replaced; a missing one
    // watches it to notice it appeared. A parent watched only on a child's behalf goes no further up.
    const wantsParent = parentPath !== directory.path && (subscribed || directory.mode.kind === 'awaiting');
    if (wantsParent && directory.parent === undefined) {
      const parent = this.#acquire(parentPath);
      const child = (): void => this.#schedule(directory);
      parent.children.add(child);
      directory.parent = () => {
        parent.children.delete(child);
        this.#release(parent);
      };
    } else if (!wantsParent && directory.parent !== undefined) {
      const release = directory.parent;
      directory.parent = undefined;
      release();
    }
    const wantsPoll = directory.mode.kind === 'polling' || [...directory.files.values()].some(file => !file.reported);
    if (wantsPoll && directory.poll === undefined)
      directory.poll = this.timers.setInterval(() => this.#tick(directory), this.#pollMs);
    else if (!wantsPoll && directory.poll !== undefined) {
      this.timers.clearInterval(directory.poll);
      directory.poll = undefined;
    }
  }

  #release(directory: WatchedDirectory): void {
    if (directory.files.size === 0 && directory.listeners.size === 0 && directory.children.size === 0)
      this.#dispose(directory);
    else this.#sync(directory);
  }

  #dispose(directory: WatchedDirectory): void {
    if (this.#directories.get(directory.path) !== directory) return;
    this.#closeWatch(directory);
    this.#directories.delete(directory.path);
    if (directory.settle !== undefined) this.timers.clearTimeout(directory.settle);
    if (directory.poll !== undefined) this.timers.clearInterval(directory.poll);
    directory.settle = undefined;
    directory.poll = undefined;
    const release = directory.parent;
    directory.parent = undefined;
    release?.();
  }

  #tick(directory: WatchedDirectory): void {
    // A polled directory tries events again first: a limit that was spent may have been freed. A re-open
    // checks the directory itself, whichever way it went.
    if (directory.mode.kind === 'polling' && directory.mode.reason !== 'unsupported') this.#open(directory);
    else void this.#check(directory);
  }

  #schedule(directory: WatchedDirectory): void {
    if (directory.settle !== undefined || this.#directories.get(directory.path) !== directory) return;
    directory.settle = this.timers.setTimeout(() => {
      directory.settle = undefined;
      void this.#check(directory);
    }, this.#settleMs);
  }

  async #check(directory: WatchedDirectory): Promise<void> {
    if (directory.checking) {
      directory.again = true;
      return;
    }
    directory.checking = true;
    try {
      do {
        directory.again = false;
        await this.#reconcile(directory);
      } while (directory.again && this.#directories.get(directory.path) === directory);
    } finally {
      directory.checking = false;
    }
  }

  /** Stat the directory and every subscribed path in it; tell the listeners of what really changed. */
  async #reconcile(directory: WatchedDirectory): Promise<void> {
    const files = [...directory.files.values()];
    const [own, ...stamps] = await Promise.all([
      this.source.stamp(directory.path),
      ...files.map(async file => await this.source.stamp(file.path)),
    ]);
    if (this.#directories.get(directory.path) !== directory) return;

    // The directory itself: appeared, or deleted / replaced under a watch that can no longer see it.
    const mode = directory.mode;
    if (
      (mode.kind === 'awaiting' && own !== undefined) ||
      (mode.kind === 'watching' && !sameDirectory(mode.identity, own))
    ) {
      this.#closeWatch(directory);
      this.#open(directory);
    }

    files.forEach((file, index) => {
      const stamp = stamps[index];
      if (directory.files.get(file.path) !== file) return;
      if (file.stamp !== UNSEEN && sameFileStamp(file.stamp, stamp)) return;
      file.stamp = stamp;
      notify(file.listeners, file.path);
    });

    const changed = directory.touched || (directory.stamp !== UNSEEN && !sameFileStamp(directory.stamp, own));
    directory.touched = false;
    directory.stamp = own;
    if (!changed) return;
    notify(directory.listeners, directory.path);
    for (const child of [...directory.children]) child();
  }
}

function notify(listeners: ReadonlySet<FileEventListener>, path: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(path);
    } catch {
      // A listener's failure is its own; the next listener and the next change still arrive.
    }
  }
}
