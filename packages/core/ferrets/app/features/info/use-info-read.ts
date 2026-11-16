/**
 * One read behind one Info row group: started the first time its tab is shown and kept while the panel stays open, so
 * moving between tabs neither re-reads nor blanks what is there. `reload` reads again. A failure is a value
 * (`failed` with words), never a throw.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { readableReason } from './info-model.ts';

export type InfoRead<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'failed'; readonly reason: string };

export function useInfoRead<T>(
  load: () => Promise<T>,
  enabled: boolean,
): { readonly read: InfoRead<T>; readonly reload: () => void } {
  const [read, setRead] = useState<InfoRead<T>>({ kind: 'idle' });
  const [generation, setGeneration] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  /** The generation last started; an answer for any other is dropped. */
  const current = useRef(-1);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled || current.current === generation) return;
    current.current = generation;
    const mine = generation;
    setRead(previous => (previous.kind === 'ready' ? previous : { kind: 'loading' }));
    loader.current().then(
      value => {
        if (mounted.current && current.current === mine) setRead({ kind: 'ready', value });
      },
      (failure: unknown) => {
        if (mounted.current && current.current === mine)
          setRead({
            kind: 'failed',
            reason: readableReason(failure instanceof Error ? failure.message : String(failure)),
          });
      },
    );
  }, [enabled, generation]);
  const reload = useCallback(() => setGeneration(value => value + 1), []);
  return { read, reload };
}
