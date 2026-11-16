/**
 * The kernel's file events on the real machine: Bun's `fs.watch` on ONE directory at a time, and a slow poll for a
 * directory the platform will not watch.
 *
 * It watches DIRECTORIES only, never a file: on macOS Bun answers a directory with an FSEvents stream and a file with
 * a descriptor each, so a directory is what keeps the daemon off a descriptor per file. The watch says only "something
 * in this directory may have changed"; the listener re-reads what it cares about, so a merged or dropped event costs a
 * late read (the config watcher's backstop), never a wrong one.
 *
 * WHEN A DIRECTORY CANNOT BE WATCHED — the watch limit is spent (`EMFILE`, `ENOSPC`), the folder went between the
 * listing and the watch, the file system has no events — it is POLLED: the listener is called every `pollMs` until the
 * subscription closes, so a change is still noticed, a little later, and {@link FileEvents.polled} names the directory
 * and the reason for a performance report to say so. A watch that dies after it opened falls back the same way. A
 * directory that is simply not there (`ENOENT`) is polled too, but it is missing, not a limit of the platform, so it is
 * not listed.
 *
 * A WATCH CAN DIE WITHOUT SAYING SO. The platform follows an inode, not a name: a folder deleted and recreated, renamed
 * away and recreated, or a symlink retargeted leaves the watch on the old inode, which never fires and never reports an
 * error. So each watch is armed on the folder's REAL path (FSEvents on macOS may never fire for a symlinked path:
 * `os.tmpdir()` is `/var`, a link to `/private/var`), remembers the identity it armed (device, inode and birth time), and
 * {@link FileEventSubscription.recheck} arms it again when the folder behind the name is no longer that one — the config
 * watcher calls it on every read, backstop ticks included.
 */
import { type FSWatcher, realpathSync, statSync, watch } from 'node:fs';
import { type Duration, milliseconds } from '@ferretry/std';
import type { Clock, FileEventsPort, PolledDirectory } from '../../contract/ports.ts';
import type { ConfigTreeEvents } from '../config/watcher.ts';

/** How often a directory the platform will not watch has its listener called. */
const FILE_EVENT_POLL_MS = 1_000;

/** One directory's subscription: it ends at `close`, and `recheck` keeps its watch on the folder the name points at now. */
interface FileEventSubscription {
  close(): void;
  /**
   * Look at the folder behind the name: when it is not the one the watch was armed on (replaced, renamed away,
   * retargeted, or it appeared after the arm failed), arm the watch on the new one and call the listener once, for
   * whatever the old watch could not hear. A folder that has not changed costs one `stat`.
   */
  recheck(): void;
}

/** The host's file events: what `kernel.fileEvents` lists (`polled`), and the watch the host's own services use. */
export interface FileEvents extends FileEventsPort {
  /** Call `listener` when something in `directory` may have changed. Never called after `close`. */
  watchDirectory(directory: string, listener: () => void): FileEventSubscription;
}

/** What a plugin without `permissions.fileEvents` holds: the list refuses, naming the plugin. */
export function undeclaredFileEvents(plugin: string): FileEventsPort {
  return Object.freeze({
    polled: () => {
      throw new Error(`${plugin} did not declare permissions.fileEvents, so it reads no polled directories.`);
    },
  });
}

/** A host with no file-events adapter (a suite): nothing is watched, so nothing is polled. */
export const NO_FILE_EVENTS: FileEventsPort = Object.freeze({ polled: () => [] });

/** The read-only half of the events: all a plugin is ever handed, so it cannot subscribe to a path. */
export function polledOnly(events: FileEventsPort): FileEventsPort {
  return Object.freeze({ polled: () => events.polled() });
}

/** The platform's directory watch, injected so a test can make it refuse or die. */
export type DirectoryWatcher = (directory: string, onEvent: () => void, onError: (error: unknown) => void) => FSWatcher;

const bunWatcher: DirectoryWatcher = (directory, onEvent, onError) =>
  watch(directory, { persistent: false }, () => onEvent()).on('error', onError);

/** The system error code of a failure (`ENOENT`, `EMFILE`), or `failed` when it carries none. */
const reasonOf = (error: unknown): string => {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'failed';
};

/**
 * What a name points at now: its real path (the path as given when it has none, so the platform says why it cannot watch
 * it) and its identity — device, inode and birth time of that path — or `undefined` when there is none or it is no
 * directory. The birth time is there because a file system reuses a freed inode at once: a folder deleted and recreated
 * can come back with the same number.
 */
const resolveDirectory = (directory: string): { readonly real: string; readonly identity: string | undefined } => {
  try {
    const real = realpathSync(directory);
    const stats = statSync(real);
    return {
      real,
      identity: stats.isDirectory()
        ? `${String(stats.dev)}:${String(stats.ino)}:${String(stats.birthtimeMs)}`
        : undefined,
    };
  } catch {
    return { real: directory, identity: undefined };
  }
};

export function nodeFileEvents(
  clock: Pick<Clock, 'every'>,
  options: { readonly watcher?: DirectoryWatcher; readonly pollMs?: Duration } = {},
): FileEvents {
  const arm = options.watcher ?? bunWatcher;
  const pollMs = options.pollMs ?? milliseconds(FILE_EVENT_POLL_MS);
  const polled = new Set<PolledDirectory>();
  return {
    polled: () => [...polled],
    watchDirectory: (directory, listener) => {
      let closed = false;
      let stop: () => void = () => undefined;
      /** The folder the current watch (or poll) was started on. */
      let armedOn: string | undefined;
      const notify = (): void => {
        if (!closed) listener();
      };
      /** Poll from now on; answers the stop that ends it. */
      const poll = (error: unknown): (() => void) => {
        const reason = reasonOf(error);
        // A folder that is not there is missing, not a platform limit: polled, but not reported as one.
        const entry: PolledDirectory | undefined =
          reason === 'ENOENT' ? undefined : { directory, reason, everyMs: pollMs };
        if (entry !== undefined) polled.add(entry);
        const cancel = clock.every(pollMs, notify);
        // The change the dead watch could not report may already have happened: look once now.
        notify();
        return () => {
          cancel();
          if (entry !== undefined) polled.delete(entry);
        };
      };
      /** Watch the folder the name points at now, on its real path; polls when the platform will not. */
      const start = (): void => {
        const { real, identity } = resolveDirectory(directory);
        armedOn = identity;
        // Only the FIRST report of THIS watch counts: a second `error` would poll twice and leak the first poll, and a
        // watch that was replaced or closed has nothing left to say.
        let ended = false;
        try {
          const watcher = arm(real, notify, error => {
            if (closed || ended) return;
            ended = true;
            watcher.close();
            stop = poll(error);
          });
          stop = () => {
            ended = true;
            watcher.close();
          };
        } catch (error) {
          stop = poll(error);
        }
      };
      start();
      return {
        close: () => {
          if (closed) return;
          closed = true;
          stop();
        },
        recheck: () => {
          if (closed || resolveDirectory(directory).identity === armedOn) return;
          stop();
          start();
          notify();
        },
      };
    },
  };
}

/** The config watcher's view of the file events: its folders (`directories`), each heard through `events`. */
export function configTreeEvents(events: FileEvents, directories: () => Promise<readonly string[]>): ConfigTreeEvents {
  return { directories, subscribeDirectory: (path, listener) => events.watchDirectory(path, listener) };
}
