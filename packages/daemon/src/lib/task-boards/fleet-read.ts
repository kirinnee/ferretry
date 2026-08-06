/**
 * How the task-board domain reads EVERY session at once.
 *
 * Two callers walk the whole daemon one session at a time: the aggregate `GET /v1/tasks` route reads
 * one board snapshot per session, and `StorageTaskBoardSessionDirectory.snapshot()` reads a
 * configuration and a state document per session. They ask the same question — "give me one
 * independent read per session, for every session the daemon holds" — and before this module each
 * answered it differently:
 *
 *   the route      a private 64-wide pool, ported from kteam
 *   the directory  `Promise.all` over every id at once, TWO document reads each, no bound at all
 *
 * That is one fact with two definitions, and the disagreement was invisible because each half passed
 * its own tests. A daemon holding thousands of boards would run one unbounded walk through the
 * directory while the neighbouring route was carefully staying under a limit. So the bound is not
 * exported as a number for each caller to apply under its own rule — the number is private here and
 * this function is the only way to ask the question. A third fleet walk gets the bound by calling
 * this, or it does not get to walk the fleet.
 *
 * ## THE UNIT OF THE BOUND IS A SESSION, NOT A DESCRIPTOR. READ THIS BEFORE QUOTING IT.
 *
 * {@link FLEET_READ_CONCURRENCY} limits SESSION CALLBACKS in flight. What one callback costs is the
 * caller's business and this module cannot see it:
 *
 *   the aggregate route  ONE board snapshot read per callback  → up to  64 documents at once
 *   the session directory  TWO document reads per callback, started together
 *                                                             → up to 128 documents at once
 *
 * So the two callers do NOT share a 64-document ceiling and it is wrong to say they do. They share a
 * 64-SESSION ceiling, which is the thing that stops a fleet walk being unbounded in the fleet's size
 * — the property that matters, because the fleet is the term that grows without limit. A caller
 * whose per-session cost is higher still gets a fixed multiple of 64 rather than a multiple of the
 * fleet. If a future caller's per-session cost makes 64 × that too many, the fix is to bound the
 * documents where they are read, not to quote a number here that its own callers falsify.
 *
 * ## THE THREE PROPERTIES A CALLER IS ENTITLED TO
 *
 * ORDER IS THE INPUT'S ORDER, never completion order. The aggregate route renders its rows in the
 * order the results arrive back, so a gather that returned whichever board answered first would
 * reshuffle a fleet board between two identical requests for no reason a reader could see. Results
 * are written to their own slot, so a slow session keeps its place.
 *
 * FAILURE STOPS THE WALK AND THEN REACHES THE CALLER. Both callers are fail-closed by design: a
 * session whose documents cannot be read makes the whole answer unavailable rather than producing a
 * fleet that is silently short one session's work. The FIRST failure is recorded and no worker
 * claims another session after it, so the walk stops growing the moment it is doomed.
 *
 * The call then returns only once every session callback it started has settled. That ordering is
 * the whole point and it is the defect this module shipped with: letting `Promise.all` reject on the first
 * failure handed the caller its error while sixty-three workers carried on claiming sessions behind
 * it, so a rejected fleet walk kept reading — 64 reads started at rejection and 2,496 fifty
 * milliseconds later, on a 10,000-session reproduction. A route that has already answered 503 must
 * not still be walking the daemon. Every worker is subscribed before any of them runs and every
 * rejection is caught, so a later failure is a HANDLED rejection and never an unhandled one; the
 * error the caller receives is always the first one that occurred, not the last one to settle.
 */

/**
 * Enough simultaneous SESSIONS to collapse a fleet walk into a handful of event-loop turns, while
 * keeping the walk's cost a fixed multiple of the bound rather than a multiple of the fleet.
 *
 * Ported from kteam `src/tasks.ts`'s `FLEET_READ_CONCURRENCY` / `mapPooled` pair, where the same
 * number bounded the same walk. It is deliberately NOT exported: a caller that could read the limit
 * could apply it its own way, which is the second definition this module exists to remove.
 */
const FLEET_READ_CONCURRENCY = 64;

/**
 * One bounded, order-preserving read per session, over the whole fleet.
 *
 * @param sessionIds every session to read, in the order the answer must come back in
 * @param read the independent per-session read; the first rejection stops the walk and is raised
 *   once every already-started session callback has settled
 */
export async function readTaskBoardFleet<T>(
  sessionIds: readonly string[],
  read: (sessionId: string) => Promise<T>,
): Promise<readonly T[]> {
  const results = new Array<T>(sessionIds.length);
  let next = 0;
  // Boxed rather than a bare `unknown`, so a callback that rejects with `undefined` still counts as
  // a failure and cannot be read as "nothing went wrong".
  let failure: { readonly error: unknown } | undefined;
  await Promise.all(
    Array.from({ length: Math.min(FLEET_READ_CONCURRENCY, sessionIds.length) }, async () => {
      // Re-read on every turn, not once: this is what stops a doomed walk claiming more sessions.
      while (failure === undefined) {
        const index = next++;
        if (index >= sessionIds.length) return;
        try {
          results[index] = await read(sessionIds[index] as string);
        } catch (error: unknown) {
          // `??=` keeps the FIRST failure. Later ones are caught only so they cannot become
          // unhandled rejections, and so this worker still resolves and lets the walk finish
          // settling instead of tearing out from under its siblings.
          failure ??= { error };
          return;
        }
      }
    }),
  );
  if (failure !== undefined) throw failure.error;
  return results;
}
