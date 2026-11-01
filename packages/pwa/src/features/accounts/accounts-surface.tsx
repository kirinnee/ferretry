/**
 * The live, daemon-bound Accounts surface (sign-ins and 2FA keys).
 *
 * Like the saved-logins surface it owns no module cache: an account belongs to a machine, the loaded list is stamped
 * with the daemon it came from and dropped when the connection changes, and a load that failed is a stated refusal
 * rather than "no accounts". Every write goes out through a person route and the list is read again afterwards, so the
 * screen is what the daemon holds. Look-alikes and the defaults file are best effort: when either cannot be read the
 * screen says so (defaults) or shows no banner (look-alikes), and the list still stands.
 */

import type { AccountId, AccountList, PutAccountDefaultRequest, TwoFactorStageId } from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type DefaultsRead, readDefaultsText } from '../../lib/accounts-screen.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { putAccountDefault, readAccounts } from '../../lib/input-api.ts';
import { readConfigFile } from '../config-files/config-files-api.ts';
import {
  type AccountsClient,
  addSignIn,
  addTwoFactorKey,
  decideProposal,
  keepApart,
  mergeAccounts,
  putAccount,
  putSignIn,
  readLookAlike,
  removeAccount,
  removeSignIn,
  removeTwoFactorKey,
} from './accounts-api.ts';
import type { AccountOps } from './accounts-parts.tsx';
import { AccountsScreen } from './accounts-screen.tsx';

export type AccountsClientFactory = (connection: DaemonConnection) => Promise<AccountsClient>;

interface Loaded {
  readonly daemonId: DaemonConnection['daemonId'];
  readonly list: AccountList;
  readonly lookAlike: readonly (readonly AccountId[])[];
  readonly defaults: DefaultsRead | undefined;
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const DEFAULTS_FILE = 'account-defaults.yaml';

async function readAll(client: AccountsClient, daemonId: DaemonConnection['daemonId']): Promise<Loaded> {
  const list = await readAccounts(client);
  const [lookAlike, defaults] = await Promise.all([
    readLookAlike(client).then(
      found => found.groups,
      () => [],
    ),
    readConfigFile(client, DEFAULTS_FILE).then(
      (file): DefaultsRead => readDefaultsText(file.text, file.exists),
      (): DefaultsRead => ({ kind: 'unreadable', why: 'This daemon would not show account-defaults.yaml' }),
    ),
  ]);
  return { daemonId, list, lookAlike, defaults };
}

export function AccountsSurface({
  connection,
  createClient,
  addKey,
  withKeys = true,
}: {
  readonly connection: DaemonConnection;
  readonly createClient: AccountsClientFactory;
  /** Asks for the passkey bound to a staged seed. Absent when this machine or this browser cannot save a seed. */
  readonly addKey?: (stage: TwoFactorStageId, words: string) => Promise<boolean>;
  /** Whether this machine has 2FA keys; false hides their tab. */
  readonly withKeys?: boolean;
}) {
  const [client, setClient] = useState<AccountsClient | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
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
        const all = await readAll(next, connection.daemonId);
        if (!current) return;
        setClient(next);
        setLoaded(all);
      })
      .catch(cause => {
        if (current) setFailure({ daemonId: connection.daemonId, reason: message(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  const refresh = useCallback(async (): Promise<void> => {
    if (client === null) return;
    try {
      setLoaded(await readAll(client, connection.daemonId));
    } catch (cause) {
      setError(message(cause));
    }
  }, [client, connection.daemonId]);

  /** Runs one write, reads again so the screen is what the daemon holds, and says whether it took. */
  const write = useCallback(
    async (action: (next: AccountsClient) => Promise<unknown>): Promise<boolean> => {
      if (client === null) return false;
      setBusy(true);
      setError(null);
      try {
        await action(client);
      } catch (cause) {
        setError(message(cause));
        return false;
      } finally {
        setBusy(false);
      }
      await refresh();
      return true;
    },
    [client, refresh],
  );

  const ops = useMemo<AccountOps>(
    () => ({
      putAccount: (id, body) => write(next => putAccount(next, id, body)),
      removeAccount: id => write(next => removeAccount(next, id)),
      addSignIn: (id, body) => write(next => addSignIn(next, id, body)),
      putSignIn: (id, body) => write(next => putSignIn(next, id, body)),
      removeSignIn: id => write(next => removeSignIn(next, id)),
      decide: (id, proposalId, decision) => write(next => decideProposal(next, id, proposalId, decision)),
      addKey: (id, body) => write(next => addTwoFactorKey(next, id, body)),
      removeKey: (id, key) => write(next => removeTwoFactorKey(next, id, key)),
      merge: (keep, from) => write(next => mergeAccounts(next, keep, from)),
      apart: (one, other) => write(next => keepApart(next, one, other)),
      setDefault: (body: PutAccountDefaultRequest) => write(next => putAccountDefault(next, body)),
    }),
    [write],
  );

  if (failure !== null && failure.daemonId === connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Accounts unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">Accounts unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          This browser could not read this daemon’s accounts: {failure.reason}. That is not the same as having none, and
          Ferretry will not show it as one.
        </p>
      </section>
    );

  if (loaded === null || client === null || loaded.daemonId !== connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Loading accounts">
        <p className="m-0 text-ui text-faint">Reading this daemon’s accounts…</p>
      </section>
    );

  return (
    <AccountsScreen
      addKey={addKey}
      withKeys={withKeys}
      busy={busy}
      client={client}
      defaults={loaded.defaults}
      error={error}
      list={loaded.list}
      lookAlike={loaded.lookAlike}
      onNavigate={() => setError(null)}
      onRefresh={() => void refresh()}
      ops={ops}
    />
  );
}
