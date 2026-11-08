/**
 * THE LAYOUT IN USE, read from this daemon and kept current: read on mount and again after every
 * `layouts.changed` (the CLI, another device, this tab's own save), so what the tab shows is what the daemon holds.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutsClient, LayoutsRead } from '../lib/layouts-client.ts';

export type LayoutsState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'ready'; readonly read: LayoutsRead };

export function useLayouts(client: LayoutsClient): { readonly state: LayoutsState; readonly refresh: () => void } {
  const [state, setState] = useState<LayoutsState>({ status: 'loading' });
  /** Counts reads, so an answer that lands after a newer one started cannot replace it. */
  const generation = useRef(0);
  const alive = useRef(true);

  const refresh = useCallback((): void => {
    generation.current += 1;
    const mine = generation.current;
    client.read().then(
      read => {
        if (alive.current && generation.current === mine) setState({ status: 'ready', read });
      },
      (error: unknown) => {
        if (!alive.current || generation.current !== mine) return;
        // A read that fails after one that worked keeps what is on screen: the layout did not stop existing.
        setState(previous =>
          previous.status === 'ready'
            ? previous
            : { status: 'failed', error: error instanceof Error ? error.message : 'The layout could not be read.' },
        );
      },
    );
  }, [client]);

  useEffect(() => {
    alive.current = true;
    refresh();
    const stop = client.onChanged(refresh);
    return () => {
      alive.current = false;
      stop();
    };
  }, [client, refresh]);

  return { state, refresh };
}
