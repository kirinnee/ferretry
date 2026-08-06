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
 * already looking at, while `refreshing` said nothing was happening. Newer bytes
 * are what Reload is for, and Reload bumps the generation.
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

export const useFsResource = <T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): FsResource<T> => {
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

  // `nonce` carries no value into the read: bumping it IS the reload, and it is
  // the only way to re-run a read for a key that has not changed. It is stamped
  // onto the settled state so a render can tell "answered" from "still asking".
  useEffect(() => {
    if (key === null) return;
    const settled = settledRef.current;
    // Already answered, for this exact key and this exact generation. A failure
    // is deliberately NOT covered: re-arming a key whose read failed is worth
    // one more attempt, because the reader has no other way to ask for one.
    if (settled.key === key && settled.nonce === nonce && settled.data !== null) return;
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
  }, [key, nonce]);

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
    // The error goes with the attempt that produced it. Dropping it here is what
    // lets every consumer read "a read is in flight" straight off `refreshing`
    // and `loading`, instead of each deciding for itself whether a settled
    // failure still applies while its replacement is being fetched.
    reload: useCallback(() => {
      setState(previous => (previous.error === null ? previous : { ...previous, error: null }));
      setNonce(current => current + 1);
    }, []),
  };
};
