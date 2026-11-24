/**
 * A login's live model list for the model field of a picker (docs/model-catalog.md § Live model list).
 *
 * Opening a picker asks the daemon ONCE (`POST …/model-list/refresh`, `fleet.use`): it answers the held list and reads the
 * provider again only when that list is a day old or more, so a fresh list costs no request to the provider. "Refresh list"
 * is `POST …/model-list/force` (`fleet.configure`); it is offered only to a browser that may make it, so a limited device
 * never sees a button it would be refused. Neither call touches a runtime's default. A login with no way to list models, or
 * a read that failed, gives no list and the picker reads as it did before: nothing here is an error a person must act on.
 */
import { type ModelListRefreshResult, ModelListRefreshResultSchema } from '@ferretry/plugin-logins/contract';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChangeAuthority } from '@ferretry/app/ui';
import type { LiveRuntimesClient } from '../lib/client.ts';

/** What the picker draws from it: the held list and, where allowed, how to refresh it. */
export interface LiveModelListState {
  readonly list: ModelListRefreshResult['list'];
  readonly refresh?: { readonly run: () => void; readonly busy: boolean };
}

const REFRESH = 'POST /v1/logins/:loginId/model-list/refresh' as const;
const FORCE = 'POST /v1/logins/:loginId/model-list/force' as const;

/** `undefined` until the login has answered, and when it has no model list to give. */
export function useLiveModelList(
  client: LiveRuntimesClient,
  loginId: string | undefined,
): LiveModelListState | undefined {
  const authority = useChangeAuthority(client);
  const mayForce = authority?.kind === 'open' || authority?.kind === 'step-up';
  const [read, setRead] = useState<{ readonly loginId: string; readonly result: ModelListRefreshResult } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRead(null);
    setBusy(false);
    if (loginId === undefined) return;
    let live = true;
    client.call(REFRESH, { params: { loginId }, body: {} }).then(
      answer => {
        const result = ModelListRefreshResultSchema.safeParse(answer);
        if (live && result.success) setRead({ loginId, result: result.data });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, loginId]);
  const run = useCallback(() => {
    if (loginId === undefined) return;
    setBusy(true);
    client.call(FORCE, { params: { loginId }, body: {} }).then(
      answer => {
        const result = ModelListRefreshResultSchema.safeParse(answer);
        if (result.success) setRead({ loginId, result: result.data });
        setBusy(false);
      },
      () => setBusy(false),
    );
  }, [client, loginId]);
  // The same object while nothing it holds changed: the picker panel tells the page from an effect keyed on this value, and a
  // page keeps what it is told in state, so an object built on every render re-told the page on every render, for ever.
  return useMemo(
    () =>
      loginId === undefined || read === null || read.loginId !== loginId || read.result.outcome === 'unavailable'
        ? undefined
        : { list: read.result.list, ...(mayForce ? { refresh: { run, busy } } : {}) },
    [loginId, read, mayForce, run, busy],
  );
}
