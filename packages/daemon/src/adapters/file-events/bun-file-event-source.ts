import { type FSWatcher, watch } from 'node:fs';
import type { DirectoryWatchOpen, FileEventSource, FileEventTimers, FileStamp } from '../../lib/file-events/ports.ts';
import {
  codeOf,
  describeError,
  directoryIdentity,
  nodeStampPrimitives,
  type StampPrimitives,
  stampAt,
  unavailableFor,
} from './node-stamps.ts';

/** The watch primitive, injected so a test can make the platform refuse. */
export interface FsWatchPrimitives extends StampPrimitives {
  watch(directory: string, onEvent: () => void): FSWatcher;
}

const nodePrimitives: FsWatchPrimitives = {
  ...nodeStampPrimitives,
  watch: (directory, onEvent) => watch(directory, { persistent: false }, () => onEvent()),
};

/**
 * The file-event hub's platform where there is no inotify: Bun's `fs.watch` on a DIRECTORY, never on a
 * file. On macOS Bun watches a directory with FSEvents and a file with a kqueue descriptor, so watching
 * directories only is what keeps the daemon off a descriptor per transcript.
 *
 * It is NOT used on Linux, where Bun 1.3.13's directory watch opens a descriptor and adds an inotify
 * watch for EVERY file in the directory (2,001 of each for a 2,000-file directory), keeps them after
 * `close()` — holding deleted transcripts' disk space — and dies with ENXIO on a directory holding a
 * socket. {@link InotifyFileEventSource} is the Linux source. Measured on 1.3.13; see the PR that added it.
 *
 * What it does on Linux, which is where its tests run, and why the hub trusts so little of it:
 * Bun suppresses an event within a millisecond of the last one it emitted unless it differs in BOTH kind
 * and name (sixty appends across twenty files reported as ONE event), an atomic save can report only
 * its temporary name, and deleting the watched directory reports nothing.
 *
 * WHICH NAMES IT REPORTS DEPENDS ON THE PLATFORM, and getting it wrong costs a 5 s poll (too cautious) or
 * a file nobody hears about (too trusting). Bun 1.3's non-FSEvents directory path
 * (`PathWatcherManager.onFileUpdate`, `path_watcher.zig`) skips every name starting with `.` or `~`, so
 * off macOS such a file is declared unreported and polled. On macOS a directory is an FSEvents stream
 * whose callback (`_events_cb`, `fs_events.zig`: 50 ms latency, `kFSEventStreamCreateFlagFileEvents`)
 * filters nothing by name, and `onFileUpdate` skips FSEvents watchers — so there every name is
 * reported, Claude's `.credentials.json` included. Declaring it unreported there polled `~/.claude` and
 * the credential store every 5 s on the owner's Mac. The macOS CI job runs this adapter's tests on a
 * real Mac (`scripts/ci/darwin-confinement.sh`), which is what holds that claim.
 */
export class BunFileEventSource implements FileEventSource {
  constructor(
    private readonly primitives: FsWatchPrimitives = nodePrimitives,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  watch(directory: string, onEvent: () => void, onError: (detail: string) => void): DirectoryWatchOpen {
    const found = directoryIdentity(this.primitives, directory);
    if ('refused' in found) return found.refused;
    let watcher: FSWatcher;
    try {
      watcher = this.primitives.watch(directory, onEvent);
    } catch (error) {
      return unavailableFor(codeOf(error), describeError(error));
    }
    let open = true;
    watcher.on('error', error => {
      if (open) onError(describeError(error));
    });
    return {
      kind: 'watching',
      identity: found.identity,
      handle: {
        close: () => {
          open = false;
          watcher.close();
        },
      },
    };
  }

  reports(name: string): boolean {
    if (name.length === 0) return false;
    return this.platform === 'darwin' || (!name.startsWith('.') && !name.startsWith('~'));
  }

  /** Bun reports nothing when the watched directory itself goes; the watch just stops. */
  reportsRemoval(): boolean {
    return false;
  }

  async stamp(path: string): Promise<FileStamp | undefined> {
    return await stampAt(this.primitives, path);
  }
}

/** Process timers that never keep the daemon alive on their own. */
export const unrefFileEventTimers: FileEventTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms).unref(),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};
