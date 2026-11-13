/**
 * Reading one ferret: `GET /v1/ferrets/:ferretId` through the half's own client, the answer parsed with the contract's
 * own schema (parse, don't validate), re-read when the daemon says a ferret changed. A panel reads it by `subject`.
 */

import { useCallback, useEffect, useState } from 'react';
import { FerretsChanged, type FerretSummary, FerretSummarySchema } from '../../contract/index.ts';
import { callFailure, type LiveFerretsClient } from './client.ts';

const FERRET_ROUTE = 'GET /v1/ferrets/:ferretId';

/** Why a ferret could not be read, in a sentence a person can use. */
interface FerretReadFailure {
  readonly status: number | null;
  readonly sentence: string;
}

type FerretRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly ferret: FerretSummary }
  | { readonly kind: 'failed'; readonly failure: FerretReadFailure };

/** One read of one ferret. A 404 is a failure with its own status: the ferret is gone, or was never here. */
const readFerret = async (client: Pick<LiveFerretsClient, 'call'>, ferret: string): Promise<FerretSummary> => {
  const answer = await client.call<unknown>(FERRET_ROUTE, { params: { ferretId: ferret } });
  return FerretSummarySchema.parse(answer);
};

const failureOf = (reason: unknown): FerretReadFailure => {
  const failure = callFailure(reason);
  const status = typeof failure?.status === 'number' ? failure.status : null;
  const message = reason instanceof Error ? reason.message : String(reason);
  if (reason instanceof Error && reason.name === 'ZodError')
    return { status, sentence: 'the daemon answered with something this page cannot read' };
  return { status, sentence: message };
};

export interface UseFerret {
  readonly read: FerretRead;
  /** Reads again now; a view that just changed the ferret calls it so it never waits for the event. */
  readonly reload: () => Promise<void>;
}

/** The ferret named by `subject`, kept current: read on mount, again whenever `ferrets.changed` names it. */
export function useFerret(client: LiveFerretsClient, subject: string | undefined): UseFerret {
  const [read, setRead] = useState<FerretRead>({ kind: 'loading' });
  const load = useCallback(
    async (isCurrent: () => boolean): Promise<void> => {
      if (subject === undefined) return;
      try {
        const ferret = await readFerret(client, subject);
        if (isCurrent()) setRead({ kind: 'ready', ferret });
      } catch (reason) {
        if (isCurrent()) setRead({ kind: 'failed', failure: failureOf(reason) });
      }
    },
    [client, subject],
  );
  useEffect(() => {
    let current = true;
    setRead({ kind: 'loading' });
    void load(() => current);
    const stop = client.subscribe?.(FerretsChanged, change => {
      if (change.ferret === subject) void load(() => current);
    });
    return () => {
      current = false;
      stop?.();
    };
  }, [client, subject, load]);
  const reload = useCallback(() => load(() => true), [load]);
  return { read, reload };
}
