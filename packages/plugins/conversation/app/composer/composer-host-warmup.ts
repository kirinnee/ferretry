/**
 * The composer's commit handshake: waiting for a host answer it can READ.
 *
 * A host publishes what it read as PROPS, and props are only readable after
 * React commits. Its readiness promise settles strictly earlier, on the
 * microtask queue, while the `setState` that publishes the arrived family
 * schedules a render behind it. So a menu that resumed on that promise alone
 * re-read the host getter one render too soon and published a READY result from
 * stale values — an empty family presented as fact, or a "not read yet" notice
 * about a catalog that had just arrived. It self-corrected on the next render,
 * which is what made the defect a flash rather than a durable wrong answer, and
 * is why it survived review.
 *
 * This module owns the fix and nothing else: a wait that ends on a COMMIT.
 * Keeping it here rather than inline in the component is what makes the
 * post-unmount branch reachable by a test, because the returned warm-up is the
 * very function the providers are given.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** What a host reports about its own in-flight reads: a promise while something
 *  is still running, and `undefined` once there is nothing left to wait for. */
export type ComposerHostReadiness = () => Promise<void> | undefined;

export interface ComposerHostWarmup {
  /**
   * Resolves once the host's read has settled AND the render publishing it has
   * committed, so a caller that re-reads a host getter afterwards sees the
   * arrived value. Returns `undefined` when the host has nothing in flight:
   * whatever it holds is already committed, so there is nothing to wait for and
   * a caller may answer immediately.
   */
  readonly warmup: () => Promise<void> | undefined;
  /** Resolves on the next commit, or immediately once unmounted. */
  readonly nextCommit: () => Promise<void>;
}

/**
 * Stable by construction, so a warm-up never rebuilds the providers it belongs
 * to — `readiness` is read through a ref rather than closed over.
 */
export function useComposerHostWarmup(readiness: () => ComposerHostReadiness | undefined): ComposerHostWarmup {
  const readinessRef = useRef(readiness);
  readinessRef.current = readiness;
  const commitWaiters = useRef<(() => void)[]>([]);
  const [, bumpCommit] = useState(0);
  /**
   * An unmounted composer commits no more, so this fence is what keeps the wait
   * TOTAL rather than merely usually-terminating. Releasing the waiters already
   * parked at cleanup is not enough on its own: a host read that settles AFTER
   * the composer came off screen resumes the warm-up with nothing left to
   * release it, and a waiter appended then would be parked behind a render that
   * can never happen. So the flag is checked on the way IN as well, and a
   * post-unmount wait resolves immediately — the provider's own abort fencing
   * then decides what that menu does, which is where that decision belongs.
   */
  const mounted = useRef(true);
  const releaseCommitWaiters = useCallback((): void => {
    for (const resolve of commitWaiters.current.splice(0)) resolve();
  }, []);
  // Deliberately no dependency list: every commit is a chance for the props a
  // waiter is waiting on to have landed.
  useLayoutEffect(releaseCommitWaiters);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      releaseCommitWaiters();
    };
  }, [releaseCommitWaiters]);
  const nextCommit = useCallback(
    () =>
      new Promise<void>(resolve => {
        if (!mounted.current) {
          resolve();
          return;
        }
        commitWaiters.current.push(resolve);
        bumpCommit(count => count + 1);
      }),
    [],
  );
  // NOT an `async` function: one of those always returns a promise, and every
  // caller reads "nothing to wait for" from `undefined`. An async wrapper
  // therefore told a settled host it had a wait in progress, which is how a
  // provider with a loaded store ended up reporting loading forever.
  //
  // A rejected host read RESOLVES rather than propagates: "we could not read
  // it" leaves the family unproved, and unproved is the honest answer.
  const warmup = useCallback((): Promise<void> | undefined => {
    const pending = readinessRef.current()?.();
    if (pending === undefined) return undefined;
    return pending.catch(() => undefined).then(() => nextCommit());
  }, [nextCommit]);
  return { warmup, nextCommit };
}
