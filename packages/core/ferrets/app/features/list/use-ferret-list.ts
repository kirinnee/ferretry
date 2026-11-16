/**
 * THE FERRET LIST, KEPT CURRENT: read on mount, re-read whenever `ferrets.changed` is heard.
 *
 * KEYED BY THE CLIENT, NOT THE ROUTE. The list sits in the side column, which re-renders on every navigation (the open
 * ferret is route-driven); reading in an effect keyed by the route would re-read `GET /v1/ferrets` on every click.
 *
 * COALESCED: at most one read in flight and one queued, however many events arrive. A `gone` event drops its row at
 * once, without waiting for the read. A failed re-read keeps the rows on screen and says they may be stale.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { FerretsChanged, type FerretSummary } from '../../../contract/index.ts';
import type { LiveFerretsClient } from '../../lib/client.ts';
import { type FerretListRead, readFerretList } from './list-wire.ts';

/** What the list says when a re-read failed but earlier rows are still drawn. */
export const STALE_LIST = 'the ferret list could not be refreshed — these ferrets may be out of date';

type FerretListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly sentence: string }
  | { readonly kind: 'ready'; readonly ferrets: readonly FerretSummary[]; readonly stale: boolean };

export interface UseFerretList {
  readonly read: FerretListState;
  /** Reads again now (the Retry button). */
  readonly retry: () => void;
}

const sentenceOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

export function useFerretList(client: LiveFerretsClient): UseFerretList {
  const [read, setRead] = useState<FerretListState>({ kind: 'loading' });
  const refresh = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let queued = false;
    let held: FerretListRead | undefined;
    const run = async (): Promise<void> => {
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      while (alive) {
        queued = false;
        try {
          const next = await readFerretList(client, held);
          if (!alive) break;
          held = next;
          setRead({ kind: 'ready', ferrets: next.ferrets, stale: false });
        } catch (reason) {
          if (!alive) break;
          setRead(previous =>
            previous.kind === 'ready' ? { ...previous, stale: true } : { kind: 'failed', sentence: sentenceOf(reason) },
          );
        }
        if (!queued) break;
      }
      inFlight = false;
    };
    refresh.current = () => void run();
    void run();
    const stop = client.subscribe?.(FerretsChanged, change => {
      if (change.gone === true) {
        // The row goes now. The held answer no longer matches the daemon, so the re-read is unconditional.
        held = undefined;
        setRead(previous =>
          previous.kind === 'ready'
            ? { ...previous, ferrets: previous.ferrets.filter(ferret => ferret.id !== change.ferret) }
            : previous,
        );
      }
      void run();
    });
    return () => {
      alive = false;
      stop?.();
    };
  }, [client]);
  const retry = useCallback(() => {
    setRead(previous => (previous.kind === 'failed' ? { kind: 'loading' } : previous));
    refresh.current?.();
  }, []);
  return { read, retry };
}
