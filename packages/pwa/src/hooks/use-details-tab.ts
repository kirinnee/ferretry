import { useCallback, useEffect, useMemo, useReducer } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey, daemonSessionScope } from '../lib/daemon-scope.ts';

export type DetailsTab = 'identity' | 'runtime' | 'progress' | 'budget';

export const DETAILS_TAB_ORDER: readonly DetailsTab[] = ['identity', 'runtime', 'progress', 'budget'];

const CAP = 50;

/**
 * In-memory LRU keyed by the full daemon/session identity. A matching session
 * id from a newly paired daemon must always start at the default tab.
 */
const lastTab = new Map<string, DetailsTab>();

const cacheKey = (scope: DaemonSessionScope): string => daemonSessionKey(scope);

/** Test seam that prevents module-level recency leaking between test cases. */
export const resetDetailsTabMemory = (): void => lastTab.clear();

export const readDetailsTab = (map: Map<string, DetailsTab>, scope: DaemonSessionScope): DetailsTab =>
  map.get(cacheKey(scope)) ?? 'identity';

export const touchDetailsTab = (map: Map<string, DetailsTab>, scope: DaemonSessionScope): void => {
  const key = cacheKey(scope);
  const tab = map.get(key);
  if (!tab) return;
  map.delete(key);
  map.set(key, tab);
};

export const writeDetailsTab = (
  map: Map<string, DetailsTab>,
  scope: DaemonSessionScope,
  tab: DetailsTab,
  cap = CAP,
): void => {
  const key = cacheKey(scope);
  map.delete(key);
  map.set(key, tab);
  while (map.size > cap) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
};

/**
 * Returns the details-sheet tab for this exact daemon/session pair. The chosen
 * tab survives a close/reopen within a page session but never a page reload.
 */
export function useDetailsTab(
  daemon: Pick<DaemonConnection, 'daemonId'>,
  sessionId: string,
  open: boolean,
): [DetailsTab, (tab: DetailsTab) => void] {
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const { daemonId } = daemon;
  const scope = useMemo(() => daemonSessionScope({ daemonId }, sessionId), [daemonId, sessionId]);

  useEffect(() => {
    if (open) touchDetailsTab(lastTab, scope);
  }, [open, scope]);

  const setTab = useCallback(
    (tab: DetailsTab): void => {
      writeDetailsTab(lastTab, scope, tab);
      bump();
    },
    [scope],
  );

  return [readDetailsTab(lastTab, scope), setTab];
}
