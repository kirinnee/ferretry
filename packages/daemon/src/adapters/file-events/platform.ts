import type { FileEventSource } from '../../lib/file-events/ports.ts';
import { BunFileEventSource } from './bun-file-event-source.ts';
import { InotifyFileEventSource, type InotifySyscalls, loadInotifySyscalls } from './inotify-file-event-source.ts';

/**
 * This platform's file-event source: inotify directly on Linux, Bun's `fs.watch` (FSEvents) elsewhere.
 * On Linux it never falls back to `fs.watch`, whose per-file descriptors are why inotify is used at all:
 * where inotify will not load, every directory is polled and the hub's fallbacks say so.
 */
export function platformFileEventSource(
  platform: NodeJS.Platform = process.platform,
  load: () => InotifySyscalls = loadInotifySyscalls,
): FileEventSource {
  return platform === 'linux' ? new InotifyFileEventSource(load) : new BunFileEventSource();
}
