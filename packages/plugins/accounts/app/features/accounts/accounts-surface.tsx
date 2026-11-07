/**
 * The live, daemon-bound Accounts surface (sign-ins and 2FA keys).
 *
 * Like the saved-logins surface it owns no module cache: an account belongs to a machine, and the app shell builds this
 * half once per machine with that machine's client, so a new client is a new load; a load that failed is a stated refusal
 * rather than "no accounts". Every write goes out through a person route and the list is read again afterwards, so the
 * screen is what the daemon holds. Look-alikes and the defaults file are best effort: when either cannot be read the
 * screen says so (defaults) or shows no banner (look-alikes), and the list still stands.
 */

import type { AccountId, AccountList, PutAccountDefaultRequest, TwoFactorStageId } from '../../../contract/routes/index.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DefaultsRead } from '../../lib/accounts-screen.ts';
import { readDefaults } from '../../shell.tsx';
import {
  type AccountsClient,
  addSignIn,
  addTwoFactorKey,
  decideProposal,
  keepApart,
  mergeAccounts,
  putAccount,
  putAccountDefault,
  readAccounts,
  putSignIn,
  readLookAlike,
  removeAccount,
  removeSignIn,
  removeTwoFactorKey,
} from './accounts-api.ts';
import type { AccountOps } from './accounts-parts.tsx';
import { AccountsScreen } from './accounts-screen.tsx';
import type { RulesBinding } from './sign-in-rules-slot.tsx';

interface Loaded {
  readonly list: AccountList;
  readonly lookAlike: readonly (readonly AccountId[])[];
  readonly defaults: DefaultsRead;
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

async function readAll(client: AccountsClient): Promise<Loaded> {
  const list = await readAccounts(client);
  const [lookAlike, defaults] = await Promise.all([
    readLookAlike(client).then(
      found => found.groups,
      () => [],
    ),
    readDefaults(client).catch(
      (): DefaultsRead => ({ kind: 'unreadable', why: 'This daemon would not show accounts.yaml' }),
    ),
  ]);
  return { list, lookAlike, defaults };
}

export function AccountsSurface({
  client: given,
  addKey,
  withKeys = true,
  rules,
}: {
  /** The machine's client (the shell builds the half per machine). */
  readonly client: AccountsClient;
  /** Asks for the passkey bound to a staged seed. Absent when this machine or this browser cannot save a seed. */
  readonly addKey?: (stage: TwoFactorStageId, words: string) => Promise<boolean>;
  /** Whether this machine has 2FA keys; false hides their tab. */
  readonly withKeys?: boolean;
  /** Present only when this machine reports standing sign-in rules: asks the passkey bound to a staged rule. */
  readonly rules?: { readonly askPasskey: RulesBinding['askPasskey'] };
}) {
  const [client, setClient] = useState<AccountsClient | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ readonly reason: string } | null>(null);

  useEffect(() => {
    let current = true;
    setClient(null);
    setLoaded(null);
    setError(null);
    setFailure(null);
    void Promise.resolve(given)
      .then(async next => {
        const all = await readAll(next);
        if (!current) return;
        setClient(next);
        setLoaded(all);
      })
      .catch(cause => {
        if (current) setFailure({ reason: message(cause) });
      });
    return () => {
      current = false;
    };
  }, [given]);

  const refresh = useCallback(async (): Promise<void> => {
    if (client === null) return;
    try {
      setLoaded(await readAll(client));
    } catch (cause) {
      setError(message(cause));
    }
  }, [client]);

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

  if (failure !== null)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Accounts unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">Accounts unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          This browser could not read this daemon’s accounts: {failure.reason}. That is not the same as having none, and
          Ferretry will not show it as one.
        </p>
      </section>
    );

  if (loaded === null || client === null)
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
      rules={rules === undefined ? undefined : { client, askPasskey: rules.askPasskey }}
    />
  );
}
