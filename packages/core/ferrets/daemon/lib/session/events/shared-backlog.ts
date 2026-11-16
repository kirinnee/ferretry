import type { FleetEventBacklog } from './service.ts';

/**
 * Where one fleet backlog pass runs: the storage's full survey of every session plus its bounded tail.
 *
 * `claim` is asked exactly once, AFTER at least one await, at the instant the pass holds the storage's
 * exclusive lock and before it reads anything. Answering false skips the pass, which then settles
 * `undefined`. A pass that ran settles the backlog it proved.
 */
export interface FleetBacklogPasses {
  fleetBacklog(limit: number, claim: () => boolean): Promise<FleetEventBacklog | undefined>;
}

interface QueuedPass {
  /** Every reader that joined while the pass was still queued. */
  readonly readers: Set<AbortSignal>;
  readonly result: Promise<FleetEventBacklog | undefined>;
}

/**
 * Every live feed that opens while a backlog pass is still QUEUED shares that one pass.
 *
 * WHY. Each feed open used to queue its own two full surveys of the fleet behind the storage's exclusive
 * lock. Phones and browsers reconnect in bursts, so the queue grew faster than it drained, and every
 * session write waited behind it: launches, resumes and `fy signal` stalled for minutes on 2026-10-30.
 *
 * SHARING IS SOUND ONLY BEFORE THE PASS STARTS. A feed subscribes to live appends before it asks for its
 * backlog, so a pass that starts after that subscription cannot miss an event between the two. A pass
 * that is already running may have read the tail before this reader subscribed, so a reader that
 * arrives then queues the next pass instead — at most one running and one queued per limit, however many
 * feeds open.
 *
 * A READER THAT LEAVES IS NOT WAITED FOR. Its call rejects the moment its signal aborts, and a pass
 * whose every reader has left is skipped when it reaches the lock rather than surveying for nobody.
 */
export class SharedFleetBacklog {
  /** The joinable pass per tail limit; a pass leaves this map the instant it claims the lock. */
  private readonly queued = new Map<number, QueuedPass>();

  constructor(private readonly passes: FleetBacklogPasses) {}

  async backlog(limit: number, signal: AbortSignal): Promise<FleetEventBacklog> {
    signal.throwIfAborted();
    const pass = this.queued.get(limit) ?? this.queue(limit);
    pass.readers.add(signal);
    return await untilAborted(pass.result, signal);
  }

  private queue(limit: number): QueuedPass {
    const readers = new Set<AbortSignal>();
    const forget = (): void => {
      if (this.queued.get(limit)?.readers === readers) this.queued.delete(limit);
    };
    const result = this.passes.fleetBacklog(limit, () => {
      forget();
      return [...readers].some(reader => !reader.aborted);
    });
    // A pass that fails before it claims must not stay joinable, and a failure nobody is still waiting
    // for is not an unhandled rejection.
    result.then(forget, forget);
    const pass = { readers, result };
    this.queued.set(limit, pass);
    return pass;
  }
}

/**
 * The pass's answer for one reader, or that reader's abort as soon as it happens.
 *
 * A skipped pass (`undefined`) is only possible once every reader has aborted, this one included, so it
 * settles as this reader's abort.
 */
function untilAborted(result: Promise<FleetEventBacklog | undefined>, signal: AbortSignal): Promise<FleetEventBacklog> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    result.then(
      backlog => {
        signal.removeEventListener('abort', abort);
        if (backlog === undefined) abort();
        else resolve(backlog);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
