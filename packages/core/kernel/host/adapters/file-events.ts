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
 * and the reason for a performance report to say so. A watch that dies after it opened falls back the same way.
 */
import { type FSWatcher, watch } from 'node:fs';
import { type Duration, milliseconds } from '@ferretry/std';
import type { Clock, FileEventsPort, PolledDirectory } from '../../contract/ports.ts';
import type { ConfigTreeEvents } from '../config/watcher.ts';

/** How often a directory the platform will not watch has its listener called. */
const FILE_EVENT_POLL_MS = 1_000;

/** The host's file events: what `kernel.fileEvents` lists (`polled`), and the watch the host's own services use. */
export interface FileEvents extends FileEventsPort {
  /** Call `listener` when something in `directory` may have changed. Never called after `close`. */
  watchDirectory(directory: string, listener: () => void): { close(): void };
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
      let stop: () => void;
      const notify = (): void => {
        if (!closed) listener();
      };
      /** Poll from now on; answers the stop that ends it. */
      const poll = (error: unknown): (() => void) => {
        const entry: PolledDirectory = { directory, reason: reasonOf(error), everyMs: pollMs };
        polled.add(entry);
        const cancel = clock.every(pollMs, notify);
        // The change the dead watch could not report may already have happened: look once now.
        notify();
        return () => {
          cancel();
          polled.delete(entry);
        };
      };
      try {
        const watcher = arm(directory, notify, error => {
          if (closed) return;
          watcher.close();
          stop = poll(error);
        });
        stop = () => watcher.close();
      } catch (error) {
        stop = poll(error);
      }
      return {
        close: () => {
          if (closed) return;
          closed = true;
          stop();
        },
      };
    },
  };
}

/** The config watcher's view of the file events: its folders (`directories`), each heard through `events`. */
export function configTreeEvents(events: FileEvents, directories: () => Promise<readonly string[]>): ConfigTreeEvents {
  return { directories, subscribeDirectory: (path, listener) => events.watchDirectory(path, listener) };
}
