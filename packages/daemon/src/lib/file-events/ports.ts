/**
 * What the file-event hub needs from the platform: a way to watch ONE directory, a way to say which entry
 * names that watch can report at all, a `stat` that answers a file's identity, and timers.
 *
 * The watch says only "something in this directory may have changed". It never says WHAT: the platform
 * watcher this daemon ships on merges, drops and mislabels events (see the adapter), so an entry name it
 * reports is not evidence of anything, and the hub re-stats what it cares about instead.
 */

/**
 * Which bytes a path holds, as far as `stat` can tell without reading them. Two stamps that differ in any
 * field are a change: a different inode or birth time is a file replaced by a rename (or a directory
 * deleted and recreated — an inode number is reused at once, its birth time is not), a different size or
 * modification time is a file written in place.
 */
export interface FileStamp {
  readonly ino: bigint;
  readonly birthNs: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

/** Whether two stamps describe the same bytes. `undefined` is "not there", which equals only itself. */
export const sameFileStamp = (a: FileStamp | undefined, b: FileStamp | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.ino === b.ino &&
    a.birthNs === b.birthNs &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs);

/** Whether two stamps are the same directory, however its entries changed since. */
export const sameDirectory = (a: FileStamp, b: FileStamp | undefined): boolean =>
  b !== undefined && a.ino === b.ino && a.birthNs === b.birthNs;

/** Why a directory could not be watched with events, for the cases a slow poll stands in for. */
export type DirectoryWatchUnavailable =
  /** The platform's watch limit is spent (EMFILE, ENFILE, ENOSPC — inotify's instance or watch cap). */
  | 'limit'
  /** The platform or file system has no events for this directory. */
  | 'unsupported'
  /** Anything else, including a watch that died after it opened. */
  | 'failed';

export interface DirectoryWatchHandle {
  close(): void;
}

export type DirectoryWatchOpen =
  /** `identity` was taken BEFORE the watch opened, so a directory replaced in between is seen as replaced. */
  | { readonly kind: 'watching'; readonly identity: FileStamp; readonly handle: DirectoryWatchHandle }
  /** There is no directory at that path (nothing there, or something that is not a directory). */
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable'; readonly reason: DirectoryWatchUnavailable; readonly detail: string };

export interface FileEventSource {
  /**
   * Watch `directory` itself, not its subdirectories. `onEvent` is called when something in it may have
   * changed; `onError` when the watch died and will report nothing more. Neither is called after `close`.
   */
  watch(directory: string, onEvent: () => void, onError: (detail: string) => void): DirectoryWatchOpen;
  /** Whether a change to an entry with this name produces an event at all. */
  reports(name: string): boolean;
  /** The path's stamp, or `undefined` when nothing can be stat-ed there. Never rejects. */
  stamp(path: string): Promise<FileStamp | undefined>;
}

/** The timers the hub runs on, so a test drives time itself. */
export interface FileEventTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
