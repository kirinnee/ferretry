/**
 * The live, machine-bound secret surface (Settings › ‹machine› › Secrets).
 *
 * IT OWNS NO MODULE CACHE. A secret belongs to a machine; the app builds this half once per machine with that machine's
 * client, so a list fetched for one daemon is never rendered as another's.
 *
 * A LOAD THAT FAILED IS NOT AN EMPTY STORE. A daemon that answered nothing renders as a stated refusal, never as "no
 * secrets" — a person shown that over a store the browser simply could not reach will set every secret again, which is
 * the exact failure this project keeps finding.
 */
import { useCallback, useEffect, useState } from 'react';
import type { SecretList } from '../../../contract/index.ts';
import type { VaultClient } from '../../shell.tsx';
import { listSecrets, putSecret, removeSecret } from './secrets-api.ts';
import { SecretsCard } from './secrets-card.tsx';

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function SecretsSurface({ client }: { readonly client: VaultClient }) {
  const [list, setList] = useState<SecretList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setList(null);
    setError(null);
    setLoadFailure(null);
    void listSecrets(client)
      .then(next => {
        if (current) setList(next);
      })
      .catch(cause => {
        if (current) setLoadFailure(message(cause));
      });
    return () => {
      current = false;
    };
  }, [client]);

  /** Re-reads after a write, so what is on screen is what the daemon holds rather than a guess. */
  const write = useCallback(
    async (name: string, act: () => Promise<unknown>) => {
      setBusy(name);
      setError(null);
      try {
        await act();
        setList(await listSecrets(client));
      } catch (cause) {
        setError(message(cause));
      } finally {
        setBusy(null);
      }
    },
    [client],
  );

  if (loadFailure !== null)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Secrets unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">Secrets unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          This browser could not read this daemon’s secret store: {loadFailure}. That is not the same as an empty store,
          and Ferretry will not show it as one.
        </p>
      </section>
    );

  if (list === null)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Loading secrets">
        <p className="m-0 text-ui text-faint">Reading this daemon’s secret store…</p>
      </section>
    );

  return (
    <SecretsCard
      list={list}
      busy={busy}
      error={error}
      onPut={(name, value) => write(name, () => putSecret(client, name, value))}
      onRemove={name => write(name, () => removeSecret(client, name))}
    />
  );
}
