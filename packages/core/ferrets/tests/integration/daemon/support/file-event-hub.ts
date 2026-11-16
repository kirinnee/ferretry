/**
 * A stand-in for today's file-event hub (`daemon/src/lib/file-events/hub.ts` over `platformFileEventSource()`),
 * which is placed to the kernel and is not in it yet. It keeps the one property the session tests lean on: after
 * any event in a directory, every path subscribed in that directory is told, so a write to one watched file is
 * heard only after the writes to the others before it. Whether a path really changed is the subscriber's to decide
 * (it compares stamps), exactly as with the real hub.
 */
import { type FSWatcher, watch } from 'node:fs';
import { dirname } from 'node:path';

interface Directory {
  readonly watcher: FSWatcher;
  readonly listeners: Map<string, Set<(path: string) => void>>;
}

export class FileEventHub {
  private readonly directories = new Map<string, Directory>();

  subscribe(path: string, listener: (path: string) => void): { close(): void } {
    const folder = dirname(path);
    let directory = this.directories.get(folder);
    if (directory === undefined) {
      const listeners = new Map<string, Set<(path: string) => void>>();
      const watcher = watch(folder, () => {
        for (const [file, each] of [...listeners]) for (const told of [...each]) told(file);
      });
      watcher.unref();
      directory = { watcher, listeners };
      this.directories.set(folder, directory);
    }
    const listeners = directory.listeners;
    const forPath = listeners.get(path) ?? new Set<(path: string) => void>();
    listeners.set(path, forPath);
    forPath.add(listener);
    return {
      close: () => {
        forPath.delete(listener);
        if (forPath.size === 0) listeners.delete(path);
      },
    };
  }

  close(): void {
    for (const directory of this.directories.values()) directory.watcher.close();
    this.directories.clear();
  }
}
