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
 * THE ONE THING THIS DOES NOT COVER, stated plainly: THE LEDGER IS PROCESS-LOCAL BY DESIGN. It is a
 * `Map` in one daemon process, so a daemon RESTART forgets every migration it has performed, and a
 * retry that spans a restart is unguarded. Nor is it shared between daemons — each paired daemon
 * guards only its own sessions, which is what multi-daemon isolation requires and not a limitation.
 *
 * PROCESS LIFETIME IS THEREFORE THE ONLY BOUNDARY AT WHICH A RECEIPT IS ALLOWED TO DISAPPEAR, and the
 * class below forgets nothing before it. That boundary is defensible because it is VISIBLE — the
 * daemon went down, an operator knows it went down, and a session mid-relaunch at that moment needs a
 * human anyway. An eviction policy is the opposite: it discards receipts silently, on a schedule
 * nobody observes, while the daemon looks healthy. See the class comment for the bug that taught this.
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

/**
 * How many logical migrations one daemon process will admit.
 *
 * A ceiling on RECEIPTS, chosen against how migrations actually happen: a human decides to move a
 * session, so a busy fleet produces a few dozen a day and a single session a handful in its life.
 * Four thousand of them is years of deliberate use, and the whole ledger at that size is a few
 * megabytes — a key, a fingerprint and one `SessionView` per entry. So the cap is unreachable by real
 * operation and reachable only by a caller minting fresh ids on purpose, which is exactly who it is
 * for.
 *
 * Nothing about it is a retention window. Compare `MigrationReplayCapacityError` below.
 */
export const MIGRATION_REPLAY_MAX_ENTRIES = 4096;

/**
 * Raised when a NEW migration cannot be admitted because the ledger is full.
 *
 * THIS IS THE FAIL-CLOSED HALF OF THE LEDGER, and it exists because "never forget a receipt" and
 * "bounded memory" cannot both hold unconditionally — one of them has to yield, and which one is a
 * safety decision rather than a capacity decision.
 *
 * Forgetting yields nothing safely: a discarded receipt re-authorizes a destructive relaunch that
 * already happened, silently, while the daemon looks healthy. Refusing yields safely: the caller is
 * told, in the response, that this daemon will not start another migration, and NOTHING IS DESTROYED
 * to produce that answer. So new work is refused and every existing receipt is still served.
 *
 * The only caller that can reach this is one minting unique request ids without ever completing a
 * migration — the memory-exhaustion path Darcy identified. A real operator hits an unreachable
 * ceiling; an id generator hits a wall instead of the daemon's heap.
 */
export class MigrationReplayCapacityError extends Error {
  constructor(readonly limit: number) {
    super(
      `this daemon has already recorded ${limit} migrations and will not admit another: a migration receipt is never discarded, because discarding one would let a retry relaunch a session that was already relaunched. Restart the daemon to clear the ledger.`,
    );
    this.name = 'MigrationReplayCapacityError';
  }
}

/** The stable string identity of one logical migration. */
export function migrationReplayKey({ sessionId, requestId }: MigrationReplayKey): string {
  return JSON.stringify([sessionId, requestId]);
}

/** Decides whether a rejection happened after the session was already destroyed. */
export type MigrationFailureRetention = (error: unknown) => boolean;

/**
 * The admission cap, normalised so that no input can switch admission off.
 *
 * `Math.max(1, Math.trunc(value))` looked like it clamped everything, and it did not: `Math.trunc`
 * passes `NaN` and `Infinity` straight through, `Math.max` keeps both, and the comparison that spends
 * the cap is `size >= limit` — which is ALWAYS FALSE against either. So a non-finite cap did not raise
 * the ceiling, it removed it, silently restoring the unbounded ledger admission exists to prevent. A
 * `NaN` is easy to arrive at by accident, from a parsed config value or an arithmetic slip.
 *
 * Non-finite therefore normalises to 1 — the same direction every other bad input already took, and
 * the same direction the rest of this file takes when it cannot be sure: refuse rather than allow. A
 * daemon that admits one migration is visibly, immediately wrong and gets fixed; one that admits
 * unlimited migrations looks healthy until it dies. Throwing would also be defensible, but it would
 * make a misconfigured cap fail at daemon boot rather than at the route, and fail-closed keeps every
 * bad value on one path.
 */
function admissionLimit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
}

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
 * A SETTLED RECEIPT IS NEVER FORGOTTEN WHILE THE PROCESS LIVES, and that is a correctness
 * requirement rather than a tuning choice. An earlier version of this class kept a bounded 64-entry
 * history, reasoning that a client's retry window is under a second and no real fleet migrates often
 * enough for the bound to matter. That reasoning was wrong in the only direction that counts: the
 * bound is measured in MIGRATIONS, not in time, so 64 later migrations silently discard an earlier
 * receipt, and the next request carrying that earlier id finds a clean slate and RELAUNCHES A SESSION
 * THAT WAS ALREADY RELAUNCHED. A cache whose eviction policy can re-authorize destruction is not a
 * safety mechanism. There is no capacity to tune, because no capacity is safe: any finite bound is a
 * number of migrations after which the guard stops guarding.
 *
 * WHAT THIS COSTS, so the trade is explicit: one map entry per logical migration for the daemon's
 * lifetime — a key string, a fingerprint, and either a `SessionView` or one error. Migrations are
 * destructive operations a human performs deliberately, a handful per session at most, so the ledger
 * grows at human pace and is bounded in practice by the process lifetime the section below describes.
 * Retaining a few thousand receipts costs a few megabytes; forgetting one costs a destroyed session.
 *
 * THE LEDGER IS THEREFORE CAPPED BY ADMISSION RATHER THAN BY EVICTION, and the difference is the whole
 * design. Eviction bounds memory by dropping OLD receipts, which re-authorizes destruction that
 * already happened. Admission bounds memory by refusing NEW work, which destroys nothing: at
 * `MIGRATION_REPLAY_MAX_ENTRIES` a fresh identity is turned away with
 * `MigrationReplayCapacityError` — before `perform` is called — while every receipt already held is
 * still served in full. Read the cap as "how many migrations this process will ever start", never as
 * "how many it remembers"; those were the same number in the bug this class used to have, and they
 * must never be the same number again.
 *
 * ONLY COMMITTED OUTCOMES OCCUPY A SLOT, which is what keeps the cap far away from real use. A
 * migration refused BEFORE the pane is touched frees its slot on the way out, so a fleet that trips
 * the preflight all day long consumes no admission at all. The ledger grows only when destruction
 * actually happened, or while it is happening.
 */
export class MigrationReplayGuard {
  readonly #entries = new Map<string, ReplayEntry>();
  readonly #retainFailure: MigrationFailureRetention;
  readonly #maxEntries: number;

  constructor(retainFailure: MigrationFailureRetention, maxEntries: number = MIGRATION_REPLAY_MAX_ENTRIES) {
    this.#retainFailure = retainFailure;
    this.#maxEntries = admissionLimit(maxEntries);
  }

  /** How many logical migrations this process is currently holding. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * The view this logical migration produced, performing it at most once.
   *
   * `perform` is a thunk rather than a promise so it is never invoked for a replay: the whole
   * guarantee is that the destructive work does not begin a second time. `fingerprint` is the
   * caller's rendering of the target this id names.
   *
   * Admission is checked ONLY on the path that would add an identity, and only after every replay
   * branch above it has been ruled out. A full ledger must never stop answering for the migrations it
   * already holds — that would turn a memory limit into exactly the re-destruction hazard the limit
   * was added to avoid.
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

    // Admitting a new identity is the only thing a full ledger refuses, and it is refused HERE:
    // before `perform`, so a rejected admission has destroyed nothing.
    //
    // The cap holds under concurrency without a lock. This function does not suspend between the
    // check and the reservation below it: `perform()` is a call, not an `await`, and it runs
    // synchronously to its own first suspension point before handing a promise back — so no other
    // caller's `run` can interleave in the gap and let two admissions pass one free slot.
    if (this.#entries.size >= this.#maxEntries) throw new MigrationReplayCapacityError(this.#maxEntries);

    const started = perform();
    this.#entries.set(identity, { fingerprint, running: started });
    try {
      const view = await started;
      this.#entries.set(identity, { fingerprint, view });
      return view;
    } catch (error) {
      // A failure that happened after the pane was destroyed must never be retried; one that
      // happened before it was touched must never be cached.
      if (this.#retainFailure(error)) this.#entries.set(identity, { fingerprint, committedFailure: error });
      else this.#entries.delete(identity);
      throw error;
    }
  }
}
