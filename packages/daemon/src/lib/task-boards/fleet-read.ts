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
 *   the directory  `Promise.all` over every id at once, TWO file reads each, no bound at all
 *
 * That is one fact with two definitions, and the disagreement was invisible because each half passed
 * its own tests. A daemon holding thousands of boards would exhaust its descriptors through the
 * directory while the neighbouring route was carefully staying under the same limit. So the bound is
 * not exported as a number for each caller to apply under its own rule — the number is private here
 * and this function is the only way to ask the question. A third fleet walk gets the bound by
 * calling this, or it does not get to walk the fleet.
 *
 * ## THE THREE PROPERTIES A CALLER IS ENTITLED TO
 *
 * ORDER IS THE INPUT'S ORDER, never completion order. The aggregate route renders its rows in the
 * order the results arrive back, so a gather that returned whichever board answered first would
 * reshuffle a fleet board between two identical requests for no reason a reader could see. Results
 * are written to their own slot, so a slow session keeps its place.
 *
 * FAILURE REACHES THE CALLER, and reaches it immediately. Both callers are fail-closed by design: a
 * session whose documents cannot be read makes the whole answer unavailable rather than producing a
 * fleet that is silently short one session's work. This function therefore never swallows, collects
 * or counts a rejection — the first one to occur rejects the call, and the caller decides what that
 * means. Reads already in flight are allowed to settle; they are subscribed to before any of them
 * runs, so a second failure arriving later is a HANDLED rejection and never an unhandled one.
 *
 * THE BOUND HOLDS whatever the fleet size. At most {@link FLEET_READ_CONCURRENCY} reads are in
 * flight, so a daemon with thousands of sessions opens tens of descriptors rather than thousands,
 * and a fleet smaller than the bound simply starts fewer workers.
 */

/**
 * Enough simultaneous reads to collapse a fleet walk into a handful of event-loop turns, while
 * keeping a daemon with thousands of sessions below its file-descriptor limit.
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
 * @param read the independent per-session read; its rejection rejects the whole walk
 */
export async function readTaskBoardFleet<T>(
  sessionIds: readonly string[],
  read: (sessionId: string) => Promise<T>,
): Promise<readonly T[]> {
  const results = new Array<T>(sessionIds.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FLEET_READ_CONCURRENCY, sessionIds.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= sessionIds.length) return;
        results[index] = await read(sessionIds[index] as string);
      }
    }),
  );
  return results;
}
