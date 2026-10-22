/**
 * CODEX ROLLOUT DISCOVERY, WALKED ON THE HOUSEKEEPING WORKER (docs/design/housekeeping-worker.md §2.1,
 * `codex.discover`).
 *
 * An undiscovered Codex session finds its rollout by walking the Codex home: a `stat` per directory and
 * per rollout outside its baseline, and a read of each one that changed. That walk ran on the main thread
 * on every read inside a session's first two minutes and every 30 s after (#697) — on the owner-scale
 * fixture it was the one housekeeping frame left on the idle main thread (#751). It is now a job: the
 * worker walks with its own kept index and answers what each candidate file is; main keeps the pace, the
 * claims and the binding, exactly as before.
 *
 * AND MAIN HEARS THE HOME. Each answer names the directories a new rollout would appear in (the index's
 * `frontier`: `sessions`, its newest year and month, its two newest days). They are watched through the
 * file-event hub, and {@link heard} counts the events, so the pacer can skip a walk that no event could
 * have changed the answer of. A directory the hub cannot watch live makes the count unknown, and the
 * pacer falls back to its clock.
 */
import type { FileSubscription } from '../../lib/file-events/hub.ts';
import type { HousekeepingJobs } from '../../lib/housekeeping/ports.ts';
import type { CodexRolloutCandidate, CodexRolloutIndex } from '../../lib/session/transcript/index.ts';

export interface HousekeepingCodexRolloutsOptions {
  /** Where a walk runs: read at each walk, so the composition root can wire the worker after this exists. */
  readonly jobs: () => HousekeepingJobs;
  /** Hear when a directory's entries may have changed: the file-event hub's `subscribeDirectory`. */
  readonly watch: (directory: string, listener: () => void) => FileSubscription;
}

interface WatchedHome {
  /** The frontier's directories, each with its watch. */
  readonly watches: Map<string, FileSubscription>;
  /** File events heard in them, plus one for every directory newly watched. */
  heard: number;
  /** Listing changes the walks reported. */
  changes: number;
}

const SKIP_NOTHING: ReadonlySet<string> = new Set();

export class HousekeepingCodexRollouts implements CodexRolloutIndex {
  readonly #homes = new Map<string, WatchedHome>();

  constructor(private readonly options: HousekeepingCodexRolloutsOptions) {}

  async candidates(
    home: string,
    correlationToken: string,
    skip: ReadonlySet<string> = SKIP_NOTHING,
  ): Promise<readonly CodexRolloutCandidate[]> {
    const found = await this.options.jobs().run({ kind: 'codex.discover', home, correlationToken, skip: [...skip] });
    const watched = this.#home(home);
    watched.changes += found.changed;
    this.#follow(watched, found.frontier);
    return found.candidates;
  }

  /** How many listing changes the walks of this home have reported. */
  changes(home: string): number {
    return this.#homes.get(home)?.changes ?? 0;
  }

  /** Events heard in this home's frontier, or `undefined` before a walk named it or while any of it is not live. */
  heard(home: string): number | undefined {
    const watched = this.#homes.get(home);
    if (watched === undefined || watched.watches.size === 0) return undefined;
    for (const watch of watched.watches.values()) if (!watch.live()) return undefined;
    return watched.heard;
  }

  /** Stop every watch. */
  close(): void {
    for (const watched of this.#homes.values()) {
      for (const watch of watched.watches.values()) watch.close();
      watched.watches.clear();
    }
    this.#homes.clear();
  }

  #home(home: string): WatchedHome {
    let watched = this.#homes.get(home);
    if (watched === undefined) {
      watched = { watches: new Map(), heard: 0, changes: 0 };
      this.#homes.set(home, watched);
    }
    return watched;
  }

  /** Watch exactly the frontier the last walk named. */
  #follow(watched: WatchedHome, frontier: readonly string[]): void {
    const wanted = new Set(frontier);
    for (const [directory, watch] of watched.watches)
      if (!wanted.has(directory)) {
        watch.close();
        watched.watches.delete(directory);
      }
    let opened = false;
    for (const directory of wanted)
      if (!watched.watches.has(directory)) {
        watched.watches.set(
          directory,
          this.options.watch(directory, () => {
            watched.heard += 1;
          }),
        );
        opened = true;
      }
    // A directory watched only from now on may have changed while the walk was listing it, unheard, so a
    // new watch counts as an event: the next walk the pace allows runs once more, under the watch.
    if (opened) watched.heard += 1;
  }
}
