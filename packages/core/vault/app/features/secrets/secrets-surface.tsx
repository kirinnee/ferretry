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
import { ConfirmToSee, isStepUpRefusal, Loading } from '@ferretry/app/ui';
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
  /** The read was refused for want of the passkey step-up (a cancelled prompt): offer to ask again. */
  const [stepUp, setStepUp] = useState(false);
  /** How many times the owner pressed "Confirm it's you to see this"; the read after a press is theirs. */
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let current = true;
    setList(null);
    setError(null);
    setLoadFailure(null);
    setStepUp(false);
    void listSecrets(client, reads > 0)
      .then(next => {
        if (current) setList(next);
      })
      .catch(cause => {
        if (!current) return;
        setStepUp(isStepUpRefusal(cause));
        setLoadFailure(message(cause));
      });
    return () => {
      current = false;
    };
  }, [client, reads]);

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

  if (loadFailure !== null && stepUp)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Secrets need your passkey">
        <h3 className="m-0 text-row font-semibold text-fg">Secrets</h3>
        <div className="mt-2">
          <ConfirmToSee
            line="This machine wants your passkey before it shows its secret store."
            onConfirm={() => setReads(n => n + 1)}
          />
        </div>
      </section>
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

  if (list === null) return <Loading kind="page" label="Reading this daemon’s secret store…" />;

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
