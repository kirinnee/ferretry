/**
 * One tiny hook behind every Files pane. Three properties matter more than
 * brevity:
 *
 *  1. a superseded response can never paint — the effect aborts its request and
 *     drops any late result via `live`;
 *  2. changing the key CLEARS the old data, so a new path can never briefly
 *     show the previous file's bytes;
 *  3. re-reading the SAME key keeps the last good value on screen and says so,
 *     because a reader who presses Reload has not asked to lose what they were
 *     reading — not while the reread is in flight, and not when it fails.
 *
 * Property 2 is why the key travels WITH the data rather than being compared in
 * an effect: the effect that would reset state runs after paint, so comparing
 * during render is what actually prevents one frame of the previous file under
 * the new file's title. The same mechanism is what keeps one daemon's bytes off
 * another daemon's screen, because every key here is daemon-qualified.
 *
 * Property 3 is why `revision` counts SUCCESSES rather than attempts: it names
 * the snapshot currently on screen, so a failed reread cannot make a derived
 * renderer believe new bytes landed. It is also why starting a reread CLEARS the
 * error it is trying to replace: a settled failure and an unsettled attempt are
 * different states, and a surface that kept showing the alert while a read was
 * genuinely in flight would be asserting a stale failure as current.
 *
 * ASKING AGAIN IS A DECISION, NOT A SIDE EFFECT. A key that this hook already
 * answered successfully, at this reload generation, is NOT re-read when it comes
 * back — flipping to the diff and back re-arms the same key, and the value is
 * still right there. Re-reading it would spend a second network round trip (and,
 * downstream, a second bounded byte read in the preview) on bytes the reader is
 * already looking at. Newer bytes are what Reload is for, and Reload bumps the
 * generation.
 *
 * That default is about BYTES, and a directory is not bytes: an agent creates
 * and deletes files while a session runs, so the listing a reader comes back to
 * is the one thing here most likely to have moved, and serving the pre-open
 * snapshot would hide the change with nothing on screen admitting it. Such a
 * resource passes `refetchOnRearm`, and its re-arm is treated as a generation of
 * its own — the same thing Reload does — so the read is announced by `refreshing`
 * over the list still on screen rather than swapped in silently.
 *
 * Whether a reread actually reaches the disk is NOT decided here. The daemon's
 * fs routes are the owner of that (`noStore` on every response); the
 * `cache: 'no-store'` in `files-api.ts` mirrors that one decision on the request
 * side, and this hook only decides WHEN to ask again.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { describeFsError, isAbort } from './files-api.ts';

export interface FsResource<T> {
  readonly data: T | null;
  readonly error: string | null;
  /** Nothing can be shown yet: this key has no value and a read is outstanding. */
  readonly loading: boolean;
  /** A reread is in flight OVER a value that is still on screen. */
  readonly refreshing: boolean;
  /** The displayed value is not the outcome of the newest attempt. */
  readonly stale: boolean;
  /** Identifies the successfully displayed snapshot; a failed reread never bumps it. */
  readonly revision: number;
  readonly reload: () => void;
}

interface ResourceState<T> {
  /** The key this data BELONGS to; a result is only rendered against its asker. */
  readonly key: string | null;
  /** The reload generation this state answered. */
  readonly nonce: number;
  readonly data: T | null;
  readonly error: string | null;
  readonly revision: number;
}

export interface FsResourceOptions {
  /**
   * Re-read this key when it is merely RE-ARMED (dropped to `null` and asked for
   * again), instead of serving the answer already held. Off by default, and only
   * a resource whose subject can change under the reader — a directory listing —
   * should turn it on; see the head of this file.
   */
  readonly refetchOnRearm?: boolean;
}

export const useFsResource = <T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  options?: FsResourceOptions,
): FsResource<T> => {
  const [state, setState] = useState<ResourceState<T>>({
    key: null,
    nonce: 0,
    data: null,
    error: null,
    revision: 0,
  });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  // Read inside the effect WITHOUT making the effect depend on it: the settled
  // state is what decides whether a re-armed key still needs asking, and adding
  // it as a dependency would re-run the read on every answer it receives.
  const settledRef = useRef(state);
  settledRef.current = state;
  const refetchOnRearm = options?.refetchOnRearm === true;

  // The error goes with the attempt that produced it. Dropping it here is what
  // lets every consumer read "a read is in flight" straight off `refreshing` and
  // `loading`, instead of each deciding for itself whether a settled failure
  // still applies while its replacement is being fetched.
  const askAgain = useCallback(() => {
    setState(previous => (previous.error === null ? previous : { ...previous, error: null }));
    setNonce(current => current + 1);
  }, []);

  // `nonce` carries no value into the read: bumping it IS the reload, and it is
  // the only way to re-run a read for a key that has not changed. It is stamped
  // onto the settled state so a render can tell "answered" from "still asking".
  useEffect(() => {
    if (key === null) return;
    const settled = settledRef.current;
    // This exact key, already answered at this exact generation — the effect can
    // only reach here again because the key was dropped and re-armed.
    if (settled.key === key && settled.nonce === nonce) {
      // A subject that moves under the reader asks again, and asks the way
      // Reload does, so the read it starts is one `refreshing` can report.
      if (refetchOnRearm) {
        askAgain();
        return;
      }
      // Otherwise the held answer is served again — INCLUDING a failure that
      // retained something, which keeps its bytes on screen beside its own Try
      // again. Only a failure with nothing retained re-reads by itself, because
      // there is nothing on that screen for the reader to ask with.
      if (settled.data !== null) return;
    }
    const controller = new AbortController();
    let live = true;
    loadRef
      .current(controller.signal)
      .then(data => {
        if (!live) return;
        setState(previous => ({
          key,
          nonce,
          data,
          error: null,
          revision: (previous.key === key ? previous.revision : 0) + 1,
        }));
      })
      .catch(error => {
        if (!live || controller.signal.aborted || isAbort(error)) return;
        // A failed REREAD keeps the bytes it failed to replace, at the revision
        // they were fetched under. A failed FIRST read has nothing to keep.
        setState(previous =>
          previous.key === key
            ? { ...previous, nonce, error: describeFsError(error) }
            : { key, nonce, data: null, error: describeFsError(error), revision: 0 },
        );
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [askAgain, key, nonce, refetchOnRearm]);

  // Anything belonging to another key is not "old data", it is someone else's.
  const mine = state.key === key;
  const data = mine ? state.data : null;
  const error = mine ? state.error : null;
  const pending = key !== null && !(mine && state.nonce === nonce);
  return {
    data,
    error,
    loading: pending && data === null,
    refreshing: pending && data !== null,
    stale: data !== null && (pending || error !== null),
    revision: mine ? state.revision : 0,
    reload: askAgain,
  };
};
