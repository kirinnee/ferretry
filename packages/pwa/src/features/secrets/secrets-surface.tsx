/**
 * The live, daemon-bound secret surface.
 *
 * IT OWNS NO MODULE CACHE. A secret belongs to a machine, and this browser can be paired to several;
 * a list fetched for daemon A must never be rendered as daemon B's. So the loaded list is STAMPED
 * with the daemon it came from and discarded the moment the connection changes.
 *
 * A LOAD THAT FAILED IS NOT AN EMPTY STORE. A daemon that answered nothing renders as a stated
 * refusal, never as "no secrets" — a person shown that over a store the browser simply could not
 * reach will set every secret again, which is the exact failure this project keeps finding.
 */

import type { SecretList } from '@ferretry/protocol';
import { ArrowRightLeft } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { SecretCopyPanel } from './secret-copy-panel.tsx';
import { listSecrets, putSecret, removeSecret, type SecretClient } from './secrets-api.ts';
import { SecretsCard } from './secrets-card.tsx';

export type SecretClientFactory = (connection: DaemonConnection) => Promise<SecretClient>;

interface Loaded {
  readonly daemonId: DaemonConnection['daemonId'];
  readonly list: SecretList;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function SecretsSurface({
  connection,
  createClient: injectedClient,
  others = [],
  machineName = other => other.daemonName ?? other.baseUrl,
}: {
  readonly connection: DaemonConnection;
  readonly createClient?: SecretClientFactory;
  /** The other machines this browser is paired with, for "Copy to another machine…". */
  readonly others?: readonly DaemonConnection[];
  readonly machineName?: (connection: DaemonConnection) => string;
}) {
  // The carrier-routed client unless a test or the harness hands one in: a plain-network client
  // reaches no daemon at all, because a paired browser is answered only inside its own session.
  const routedClient = useDaemonClient();
  const createClient = injectedClient ?? routedClient;
  const [client, setClient] = useState<SecretClient | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<{
    readonly daemonId: DaemonConnection['daemonId'];
    readonly reason: string;
  } | null>(null);

  useEffect(() => {
    let current = true;
    setClient(null);
    setLoaded(null);
    setError(null);
    setLoadFailure(null);
    void createClient(connection)
      .then(async next => {
        const list = await listSecrets(next);
        if (!current) return;
        setClient(next);
        setLoaded({ daemonId: connection.daemonId, list });
      })
      .catch(cause => {
        if (current) setLoadFailure({ daemonId: connection.daemonId, reason: message(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  /** Re-reads after a write, so what is on screen is what the daemon holds rather than a guess. */
  const refresh = useCallback(
    async (next: SecretClient) => {
      const list = await listSecrets(next);
      setLoaded({ daemonId: connection.daemonId, list });
    },
    [connection.daemonId],
  );

  const put = useCallback(
    async (name: string, value: string) => {
      if (!client) return;
      setBusy(name);
      setError(null);
      try {
        await putSecret(client, name, value);
        await refresh(client);
      } catch (cause) {
        setError(message(cause));
      } finally {
        setBusy(null);
      }
    },
    [client, refresh],
  );

  const remove = useCallback(
    async (name: string) => {
      if (!client) return;
      setBusy(name);
      setError(null);
      try {
        await removeSecret(client, name);
        await refresh(client);
      } catch (cause) {
        setError(message(cause));
      } finally {
        setBusy(null);
      }
    },
    [client, refresh],
  );

  if (loadFailure !== null && loadFailure.daemonId === connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Secrets unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">Secrets unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          This browser could not read this daemon’s secret store: {loadFailure.reason}. That is not the same as an empty
          store, and Ferretry will not show it as one.
        </p>
      </section>
    );

  if (loaded === null || loaded.daemonId !== connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Loading secrets">
        <p className="m-0 text-ui text-faint">Reading this daemon’s secret store…</p>
      </section>
    );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SecretsCard list={loaded.list} busy={busy} error={error} onPut={put} onRemove={remove} />
      {copying ? (
        <SecretCopyPanel
          direction="to"
          here={connection}
          others={others}
          createClient={createClient}
          machineName={machineName}
          onClose={() => setCopying(false)}
        />
      ) : (
        loaded.list.secrets.length > 0 && (
          <div>
            <button type="button" className="kt-btn min-h-[44px]" onClick={() => setCopying(true)}>
              <ArrowRightLeft size={14} aria-hidden="true" /> Copy to another machine…
            </button>
          </div>
        )
      )}
    </div>
  );
}
