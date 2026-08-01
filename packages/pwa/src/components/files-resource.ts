/**
 * One tiny hook behind every Files pane. Two properties matter more than
 * brevity:
 *
 *  1. a superseded response can never paint — the effect aborts its request and
 *     drops any late result via `live`;
 *  2. changing the key CLEARS the old data, so a new path can never briefly
 *     show the previous file's bytes.
 *
 * Property 2 is why the key travels WITH the data rather than being compared in
 * an effect: the effect that would reset state runs after paint, so comparing
 * during render is what actually prevents one frame of the previous file under
 * the new file's title. The same mechanism is what keeps one daemon's bytes off
 * another daemon's screen, because every key here is daemon-qualified.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { describeFsError, isAbort } from './files-api.ts';

export interface FsResource<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly reload: () => void;
}

interface ResourceState<T> {
  /** The key this data BELONGS to; a result is only rendered against its asker. */
  readonly key: string | null;
  readonly data: T | null;
  readonly error: string | null;
}

export const useFsResource = <T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): FsResource<T> => {
  const [state, setState] = useState<ResourceState<T>>({ key: null, data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  // `nonce` carries no value into the body: bumping it IS the reload, and it is
  // the only way to re-run a read for a key that has not changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is a deliberate re-read trigger
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    let live = true;
    loadRef
      .current(controller.signal)
      .then(data => {
        if (live) setState({ key, data, error: null });
      })
      .catch(error => {
        if (!live || controller.signal.aborted || isAbort(error)) return;
        setState({ key, data: null, error: describeFsError(error) });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [key, nonce]);

  // Anything belonging to another key is not "old data", it is someone else's.
  const fresh = state.key === key;
  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : null,
    loading: key !== null && !fresh,
    reload: useCallback(() => {
      setState({ key: null, data: null, error: null });
      setNonce(current => current + 1);
    }, []),
  };
};
