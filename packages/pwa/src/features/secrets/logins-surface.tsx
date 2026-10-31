/**
 * The live, daemon-bound saved-logins surface.
 *
 * Like the secrets surface it owns no module cache: a login belongs to a machine, the loaded list is stamped
 * with the daemon it came from and dropped when the connection changes, and a load that failed is a stated
 * refusal rather than "no saved logins".
 */

import type { LoginEntryList, PutLoginEntryRequest } from '@ferretry/protocol';
import { useCallback, useEffect, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type LoginClient, listLogins, putLogin, removeLogin, renameLogin } from './logins-api.ts';
import { LoginsCard } from './logins-card.tsx';

export type LoginClientFactory = (connection: DaemonConnection) => Promise<LoginClient>;

interface Loaded {
  readonly daemonId: DaemonConnection['daemonId'];
  readonly list: LoginEntryList;
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function LoginsSurface({
  connection,
  createClient,
}: {
  readonly connection: DaemonConnection;
  readonly createClient: LoginClientFactory;
}) {
  const [client, setClient] = useState<LoginClient | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    readonly daemonId: DaemonConnection['daemonId'];
    readonly reason: string;
  } | null>(null);

  useEffect(() => {
    let current = true;
    setClient(null);
    setLoaded(null);
    setError(null);
    setFailure(null);
    void createClient(connection)
      .then(async next => {
        const list = await listLogins(next);
        if (!current) return;
        setClient(next);
        setLoaded({ daemonId: connection.daemonId, list });
      })
      .catch(cause => {
        if (current) setFailure({ daemonId: connection.daemonId, reason: message(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  /** Runs one write, re-reads so the screen is what the daemon holds, and says whether it took. */
  const write = useCallback(
    async (id: string, action: (next: LoginClient) => Promise<unknown>): Promise<boolean> => {
      if (client === null) return false;
      setBusy(id);
      setError(null);
      try {
        await action(client);
        setLoaded({ daemonId: connection.daemonId, list: await listLogins(client) });
        return true;
      } catch (cause) {
        setError(message(cause));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [client, connection.daemonId],
  );

  const put = useCallback(
    (id: string, body: PutLoginEntryRequest) => write(id, next => putLogin(next, id, body)),
    [write],
  );
  const rename = useCallback((id: string, to: string) => write(id, next => renameLogin(next, id, to)), [write]);
  const remove = useCallback((id: string) => write(id, next => removeLogin(next, id)), [write]);

  if (failure !== null && failure.daemonId === connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Saved logins unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">Saved logins unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          This browser could not read this daemon’s saved logins: {failure.reason}. That is not the same as having none,
          and Ferretry will not show it as one.
        </p>
      </section>
    );

  if (loaded === null || loaded.daemonId !== connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Loading saved logins">
        <p className="m-0 text-ui text-faint">Reading this daemon’s saved logins…</p>
      </section>
    );

  return <LoginsCard list={loaded.list} busy={busy} error={error} onPut={put} onRename={rename} onRemove={remove} />;
}
