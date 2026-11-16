import type { Log } from '@ferretry/kernel/contract';
import type { IndexRebuildOptions, IndexRebuildResult } from '../lib/storage-types.ts';

/** The job that gives the session index a row for every session a lost cache file left unlisted (BG-049). */
export const INDEX_REBUILD_JOB = 'ferrets.index-rebuild';

/**
 * Sessions per slice. One session costs ~0.13 ms of main-thread time to read and index, so a slice of 50 is a few
 * milliseconds — far inside the 208/263 ms stall budget — and ~2,400 sessions (the owner's fleet) are ~48 slices.
 */
const INDEX_REBUILD_SLICE = 50;

/** What the job stands on: the storage's yielding rebuild, the kernel clock, the log. */
export interface IndexRebuildDeps {
  readonly storage: { rebuildIndexYielding(options: IndexRebuildOptions): Promise<IndexRebuildResult> };
  /** A macrotask turn on the kernel clock. */
  readonly yieldToLoop: () => Promise<void>;
  readonly nowMs: () => number;
  readonly log: Log;
}

/**
 * The session index is the kernel's `sqlite-cache` (`index.sqlite`): a file the kernel may drop and recreate empty, and
 * which the conversion from the previous version does not carry. Until something rebuilt it, every reader of the
 * session list (the observer's roster, resume, the archive sweep, ancestry, monitor waits) saw an empty fleet.
 *
 * Runs once after the daemon serves. The observer and the other readers tolerate an empty roster for the first pass
 * (an empty list is a valid roster), and the rows arrive slice by slice while they run; every write to a session also
 * indexes it, so a session written meanwhile is never lost. Logs ONE line: what was rebuilt, and how long it took.
 */
export async function runIndexRebuild(deps: IndexRebuildDeps, signal: AbortSignal): Promise<IndexRebuildResult> {
  const began = deps.nowMs();
  const result = await deps.storage.rebuildIndexYielding({
    sliceSize: INDEX_REBUILD_SLICE,
    yieldToLoop: deps.yieldToLoop,
    signal,
  });
  deps.log.info('the session index was rebuilt', {
    rebuilt: result.rebuilt,
    missing: result.missing,
    complete: result.complete,
    failed: result.failedSessionIds.length,
    ms: Math.round(deps.nowMs() - began),
  });
  return result;
}
