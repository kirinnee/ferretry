/**
 * The tab's one source of truth: the connector's status for this machine, read on a short loop while the page is
 * visible, and the four acts that change it. There is no optimistic state — an act is pending while it runs, then the tab
 * shows exactly what the daemon answers next.
 *
 * A failed poll keeps what is on screen; only a tab with nothing yet says it failed. A hidden page stops reading and
 * reads at once when it comes back.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectorGrantView, ConnectorStatus } from '../../contract/index.ts';
import {
  approveSignIn,
  type ConnectorClient,
  denySignIn,
  readConnector,
  revokeGrant,
  switchConnector,
} from './client.ts';
import { actFailureSentence, CONNECTOR_POLL_MS, isOutdatedMachine } from './words.ts';

type ConnectorRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly status: ConnectorStatus }
  | { readonly kind: 'outdated' }
  | { readonly kind: 'failed' };

export interface Connector {
  readonly read: ConnectorRead;
  /** The id of the sign-in or grant an act is running on; `null` when none. */
  readonly busy: string | null;
  readonly switching: boolean;
  readonly failure: string | null;
  readonly switchTo: (enabled: boolean) => Promise<void>;
  readonly approve: (id: string) => Promise<void>;
  readonly deny: (id: string) => Promise<void>;
  readonly revoke: (grant: ConnectorGrantView) => Promise<boolean>;
}

export function useConnector(client: ConnectorClient, pollMs: number = CONNECTOR_POLL_MS): Connector {
  const [read, setRead] = useState<ConnectorRead>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const live = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const status = await readConnector(client);
      if (live.current) setRead({ kind: 'ready', status });
    } catch (error) {
      if (!live.current) return;
      if (isOutdatedMachine(error)) setRead({ kind: 'outdated' });
      else setRead(held => (held.kind === 'ready' ? held : { kind: 'failed' }));
    }
  }, [client]);

  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      timer = undefined;
      if (!live.current || document.visibilityState === 'hidden') return;
      await refresh();
      if (live.current) timer = setTimeout(() => void tick(), pollMs);
    };
    const wake = (): void => {
      if (document.visibilityState === 'visible' && timer === undefined) void tick();
    };
    document.addEventListener('visibilitychange', wake);
    void tick();
    return () => {
      live.current = false;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [refresh, pollMs]);

  /** One act on one id: said when it fails, and the status read again either way so the tab never shows a guess. */
  const act = useCallback(
    async (id: string, run: () => Promise<void>): Promise<boolean> => {
      setBusy(id);
      setFailure(null);
      let ok = true;
      try {
        await run();
      } catch (error) {
        ok = false;
        if (live.current) setFailure(actFailureSentence(error));
      }
      await refresh();
      if (live.current) setBusy(null);
      return ok;
    },
    [refresh],
  );

  const switchTo = useCallback(
    async (enabled: boolean): Promise<void> => {
      setSwitching(true);
      setFailure(null);
      try {
        const status = await switchConnector(client, enabled);
        if (live.current) setRead({ kind: 'ready', status });
      } catch (error) {
        if (live.current) setFailure(actFailureSentence(error));
      }
      if (live.current) setSwitching(false);
    },
    [client],
  );

  return {
    read,
    busy,
    switching,
    failure,
    switchTo,
    approve: async id => void (await act(id, () => approveSignIn(client, id))),
    deny: async id => void (await act(id, () => denySignIn(client, id))),
    revoke: grant => act(grant.id, () => revokeGrant(client, grant.id)),
  };
}
