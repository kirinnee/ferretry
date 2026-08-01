/**
 * THE MIGRATION'S REPLAY GUARD — one logical migration performs at most one destructive relaunch.
 *
 * WHY THIS EXISTS AT ALL. `FyApiClient.request` retries a POST up to three times on transport
 * failure, 250ms and 500ms apart, and a migration is the most destructive operation the daemon
 * offers: the pane is snapshotted, killed, the configuration document is restamped, and a
 * replacement agent is launched. A relaunch takes seconds, so the second attempt of a retry sequence
 * arrives while the first is still mid-flight, and the third arrives while the session is a
 * half-restamped document. Without this, one lost response means two relaunches — the hazard the
 * START route already names in `session-control.ts` ("without it a retried request starts a second
 * session") and the only destructive session route that had no answer to it.
 *
 * THE GUARD IS A PROMISE CACHE, NOT A LOCK, and the difference is the whole point. A lock makes the
 * replay wait and then run; sharing the in-flight promise makes the replay *be* the first attempt —
 * it observes the same relaunch, and therefore the same view or the same refusal. That is what
 * "returns a coherent result" means here: a replay never learns something the original did not.
 *
 * WHICH FAILURES ARE REMEMBERED IS THE WHOLE SAFETY ARGUMENT, and it is not one rule but two,
 * because a migration has a point of no return in the middle of it.
 *
 *   BEFORE the pane is touched, a refusal means NOTHING HAPPENED. The preflight found in-flight work,
 *   the target account was unknown, the context window would shrink. These are answerable conditions:
 *   the caller resolves them and asks again, and the sheet's own "Retry safety check" button exists
 *   to do exactly that under the same target. Remembering such a refusal would freeze the session's
 *   condition at the moment of the first ask and make every later answer a lie. So it is DROPPED.
 *
 *   AFTER the pane is killed and the document restamped, a failure means THE DESTRUCTION ALREADY
 *   HAPPENED and the relaunch did not complete. Dropping that would let the retry — which is
 *   automatic, and 250ms away — attempt a second destructive relaunch against a session that has
 *   already lost its pane. So it is RETAINED and re-raised, and the caller is told the same thing the
 *   original was told: this migration failed after it committed, the session records why, go look.
 *
 * The guard cannot tell those apart by itself — the failure taxonomy belongs to the route that owns
 * the subsystem — so the caller injects `retainFailure`. A classifier that cannot decide should say
 * `true`: replaying a stale failure is recoverable by a human reading the session, while a second
 * unguarded relaunch is not.
 *
 * THE PAYLOAD FINGERPRINT IS AUTHORIZATION, not an optimisation, and it is the same argument the
 * start's recovery digest makes. A request id is minted by the CALLER. If one arrives twice carrying
 * two different targets, answering the second with the first's result would tell a caller its
 * migration to account B succeeded when what happened was a migration to account A. That is worse
 * than any error, so a mismatch is refused outright and neither migration is performed.
 *
 * WHAT THIS DOES NOT COVER, stated plainly: THE LEDGER IS PROCESS-LOCAL BY DESIGN. It is a `Map` in
 * one daemon process, so a daemon RESTART forgets every migration it has performed, and a retry that
 * spans a restart is unguarded. Nor is it shared between daemons — each paired daemon guards only its
 * own sessions, which is what multi-daemon isolation requires and not a limitation.
 *
 * Closing the restart window needs the record to live beside the session on disk — the session
 * already carries a migration report, so that is where it would go — and it is deliberately not
 * attempted here: whether a destructive operation's receipt belongs in the state home is a durability
 * decision about the state home, not one a route mount gets to make. The window it actually leaves is
 * narrow: a daemon restart landing inside a single client's ~750ms retry sequence, which also means
 * the daemon died mid-relaunch and the session needs a human either way.
 *
 * SCOPING. The key pairs the session id with the request id, because a request id is caller-minted
 * and two sessions could be asked to migrate under the same one; keying on the pair means such a
 * collision cannot make one session's migration answer for another's.
 */

import type { SessionView } from '@ferretry/protocol';

/** How many settled migrations are remembered. */
export const MIGRATION_REPLAY_CAPACITY = 64;

/** One logical migration, identified the way the route identifies it. */
export interface MigrationReplayKey {
  readonly sessionId: string;
  readonly requestId: string;
}

/** Raised when one request id is presented with two different targets. */
export class MigrationReplayMismatchError extends Error {
  constructor(readonly requestId: string) {
    super(
      `request id ${JSON.stringify(requestId)} was already used for a different migration target: one request id names one migration`,
    );
    this.name = 'MigrationReplayMismatchError';
  }
}

/** The stable string identity of one logical migration. */
export function migrationReplayKey({ sessionId, requestId }: MigrationReplayKey): string {
  return JSON.stringify([sessionId, requestId]);
}

/** Decides whether a rejection happened after the session was already destroyed. */
export type MigrationFailureRetention = (error: unknown) => boolean;

interface ReplayEntry {
  readonly fingerprint: string;
  /** Present while the migration is running; every replay awaits this exact promise. */
  running?: Promise<SessionView>;
  /** Present once it succeeded. */
  view?: SessionView;
  /** Present once it failed AFTER committing; re-raised rather than re-attempted. */
  committedFailure?: unknown;
}

/**
 * Remembers migrations by logical identity so a retried POST joins the original instead of starting
 * a second one.
 *
 * Bounded on purpose: a daemon runs for weeks and every migration would otherwise leave a permanent
 * entry. Insertion order is eviction order — the oldest retained outcome goes first — because a
 * client's retry window is under a second and its recovery window is minutes, both far inside a
 * 64-entry history of an operation a human performs by hand.
 */
export class MigrationReplayGuard {
  readonly #entries = new Map<string, ReplayEntry>();
  readonly #capacity: number;
  readonly #retainFailure: MigrationFailureRetention;

  constructor(retainFailure: MigrationFailureRetention, capacity: number = MIGRATION_REPLAY_CAPACITY) {
    this.#retainFailure = retainFailure;
    this.#capacity = Math.max(1, Math.trunc(capacity));
  }

  /**
   * The view this logical migration produced, performing it at most once.
   *
   * `perform` is a thunk rather than a promise so it is never invoked for a replay: the whole
   * guarantee is that the destructive work does not begin a second time. `fingerprint` is the
   * caller's rendering of the target this id names.
   */
  async run(key: MigrationReplayKey, fingerprint: string, perform: () => Promise<SessionView>): Promise<SessionView> {
    const identity = migrationReplayKey(key);
    const existing = this.#entries.get(identity);

    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new MigrationReplayMismatchError(key.requestId);
      if (existing.view !== undefined) return existing.view;
      if ('committedFailure' in existing) throw existing.committedFailure;
      if (existing.running !== undefined) return await existing.running;
    }

    const started = perform();
    const entry: ReplayEntry = { fingerprint, running: started };
    this.#remember(identity, entry);
    try {
      const view = await started;
      // Replace rather than mutate-in-place-only so eviction order tracks completion.
      this.#entries.delete(identity);
      this.#remember(identity, { fingerprint, view });
      return view;
    } catch (error) {
      this.#entries.delete(identity);
      // A failure that happened after the pane was destroyed must never be retried; one that
      // happened before it was touched must never be cached.
      if (this.#retainFailure(error)) this.#remember(identity, { fingerprint, committedFailure: error });
      throw error;
    }
  }

  /**
   * A RUNNING entry is never evicted, at any pressure. Evicting one would hand the very next replay
   * a clean slate and let it start a second destructive relaunch of a migration already in progress —
   * the exact failure this class exists to prevent, reintroduced by its own bookkeeping. So eviction
   * only ever consumes SETTLED entries, oldest first, and when every entry is still running the map
   * is allowed over capacity until they finish. That excess is bounded by the number of migrations
   * genuinely in flight, which is bounded by callers, not by history.
   */
  #remember(identity: string, entry: ReplayEntry): void {
    this.#entries.set(identity, entry);
    while (this.#entries.size > this.#capacity) {
      const evictable = this.#oldestSettled();
      if (evictable === undefined) break;
      this.#entries.delete(evictable);
    }
  }

  #oldestSettled(): string | undefined {
    for (const [identity, entry] of this.#entries) if (entry.running === undefined) return identity;
    return undefined;
  }
}
