/**
 * How a caller reads EVERY session at once, with a bound.
 *
 * The bound is not exported as a number for a caller to apply under its own rule: the number is
 * private here and this function is the only way to ask the question "give me one independent read
 * per session, for every session the daemon holds". A second fleet walk gets the bound by calling
 * this, or it does not get to walk the fleet.
 *
 * ## THE UNIT OF THE BOUND IS A SESSION, NOT A DESCRIPTOR.
 *
 * {@link FLEET_READ_CONCURRENCY} limits SESSION CALLBACKS in flight. What one callback costs is the
 * caller's business and this module cannot see it: a caller that starts two document reads per
 * session peaks at 64 sessions and 128 open documents. The bound stops a fleet walk being unbounded
 * in the fleet's size, which is the term that grows without limit; a caller whose per-session cost
 * is higher still gets a fixed multiple of 64 rather than a multiple of the fleet.
 *
 * ## THE THREE PROPERTIES A CALLER IS ENTITLED TO
 *
 * ORDER IS THE INPUT'S ORDER, never completion order. Results are written to their own slot, so a
 * slow session keeps its place.
 *
 * FAILURE STOPS THE WALK AND THEN REACHES THE CALLER. A session whose documents cannot be read
 * makes the whole answer unavailable rather than producing a fleet that is silently short one
 * session. The FIRST failure is recorded and no worker claims another session after it, so the walk
 * stops growing the moment it is doomed.
 *
 * The call returns only once every session callback it started has settled. Letting `Promise.all`
 * reject on the first failure would hand the caller its error while sixty-three workers carried on
 * claiming sessions behind it. Every worker is subscribed before any of them runs and every
 * rejection is caught, so a later failure is a HANDLED rejection and never an unhandled one; the
 * error the caller receives is always the first one that occurred, not the last one to settle.
 */

/**
 * Enough simultaneous SESSIONS to collapse a fleet walk into a handful of event-loop turns, while
 * keeping the walk's cost a fixed multiple of the bound rather than a multiple of the fleet.
 */
const FLEET_READ_CONCURRENCY = 64;

/**
 * One bounded, order-preserving read per session, over the whole fleet.
 *
 * @param sessionIds every session to read, in the order the answer must come back in
 * @param read the independent per-session read; the first rejection stops the walk and is raised
 *   once every already-started session callback has settled
 */
export async function readSessionFleet<T>(
  sessionIds: readonly string[],
  read: (sessionId: string) => Promise<T>,
): Promise<readonly T[]> {
  const results = new Array<T>(sessionIds.length);
  // Boxed rather than a bare `unknown`, so a callback that rejects with `undefined` still counts as
  // a failure and cannot be read as "nothing went wrong".
  let failure: { readonly error: unknown } | undefined;
  let next = 0;
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
