/**
 * Settings › ‹machine› › GitHub accounts. Built once per machine with that machine's client; it keeps no module cache.
 *
 * A LOAD THAT FAILED IS NOT AN EMPTY LIST: a refusal is said as a refusal (and a missing passkey step-up offers the
 * button), never drawn as "no accounts", because a person shown that over a list the browser could not read would
 * connect everything again.
 */
import { ConfirmToSee, ExternalLink, isStepUpRefusal, Loading } from '@ferretry/app/ui';
import { useCallback, useEffect, useState } from 'react';
import { GITHUB_REVOKE_URL, type GitAccount, type GitAccountRemoved } from '../../../contract/index.ts';
import { listAccounts, removeAccount } from '../../lib/accounts-api.ts';
import { explainFailure } from '../../lib/connect-state.ts';
import type { GitAccountsClient } from '../../shell.tsx';
import { ConnectPanel } from '../connect/connect-panel.tsx';
import { AccountRow } from './account-row.tsx';

export interface AccountsSurfaceProps {
  readonly client: GitAccountsClient;
  readonly pollDelay?: (seconds: number) => number;
  readonly now?: () => number;
}

interface Removal {
  readonly login: string;
  readonly result: GitAccountRemoved;
}

export function AccountsSurface({ client, pollDelay, now }: AccountsSurfaceProps) {
  const [accounts, setAccounts] = useState<readonly GitAccount[] | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [reads, setReads] = useState(0);
  const [busy, setBusy] = useState(false);
  const [removeFailure, setRemoveFailure] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Removal | null>(null);

  useEffect(() => {
    let current = true;
    setLoadFailure(null);
    setStepUp(false);
    void listAccounts(client, reads > 0).then(
      next => {
        if (current) setAccounts(next);
      },
      cause => {
        if (!current) return;
        setStepUp(isStepUpRefusal(cause));
        setLoadFailure(explainFailure(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [client, reads]);

  /** Re-reads after a change, so what is on screen is what the daemon holds. */
  const reload = useCallback(() => {
    void listAccounts(client).then(setAccounts, cause => setLoadFailure(explainFailure(cause)));
  }, [client]);

  const remove = useCallback(
    async (account: GitAccount) => {
      setBusy(true);
      setRemoveFailure(null);
      setRemoved(null);
      try {
        const result = await removeAccount(client, account.id);
        setRemoved({ login: account.login, result });
        setAccounts(await listAccounts(client));
      } catch (cause) {
        setRemoveFailure(explainFailure(cause));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  if (loadFailure !== null && stepUp)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="GitHub accounts need your passkey">
        <h3 className="m-0 text-row font-semibold text-fg">GitHub accounts</h3>
        <div className="mt-2">
          <ConfirmToSee
            line="This machine wants your passkey before it shows its GitHub accounts."
            onConfirm={() => setReads(n => n + 1)}
          />
        </div>
      </section>
    );
  if (loadFailure !== null)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="GitHub accounts unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">GitHub accounts unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          This browser could not read this daemon’s GitHub accounts: {loadFailure} That is not the same as having none,
          and Ferretry will not show it as such.
        </p>
      </section>
    );
  if (accounts === null) return <Loading kind="page" label="Reading this daemon’s GitHub accounts…" />;

  return (
    <section className="kt-panel flex flex-col gap-3 p-panel" aria-label="GitHub accounts" data-testid="git-accounts">
      {/* The tab's title is the Settings shell's one heading for this panel; the card draws none of its own. */}
      <p className="m-0 text-cell leading-base text-muted">
        Connect the GitHub accounts ferrets may act as. Ferretry keeps each token sealed on this machine; a ferret can
        use it through the daemon and can never read it.
      </p>

      {accounts.length === 0 ? null : (
        <ul
          className="m-0 list-none p-0 [&>li+li]:border-t [&>li+li]:border-border"
          aria-label="Connected GitHub accounts"
        >
          {accounts.map(account => (
            <AccountRow
              key={account.id}
              account={account}
              busy={busy}
              client={client}
              onChanged={reload}
              onRemove={account => void remove(account)}
            />
          ))}
        </ul>
      )}

      {removed === null ? null : (
        <div
          role="status"
          className="m-0 flex flex-col gap-1 text-cell leading-base text-muted"
          data-testid="git-removed"
        >
          <p className="m-0 text-ui text-fg">Removed @{removed.login}.</p>
          {removed.result.keysLeftOnProvider.length === 0 ? null : (
            <p className="m-0 text-warn">
              These keys could not be taken off GitHub; delete them there:{' '}
              {removed.result.keysLeftOnProvider.join(', ')}.
            </p>
          )}
          {removed.result.gpgUploadsToCheck.length === 0 ? null : (
            <p className="m-0 break-words text-warn">
              These GPG uploads have unknown outcomes. Compare these public fingerprints at github.com/settings/keys and
              confirm who registered each key before taking any action:{' '}
              <span className="mono break-all">{removed.result.gpgUploadsToCheck.join(', ')}</span>.
            </p>
          )}
          <p className="m-0">
            To fully revoke Ferretry, open{' '}
            <ExternalLink href={GITHUB_REVOKE_URL} className="text-accent underline">
              github.com/settings/applications
            </ExternalLink>
            .
          </p>
        </div>
      )}
      {removeFailure === null ? null : (
        <p role="alert" className="m-0 text-ui text-err">
          {removeFailure}
        </p>
      )}

      <ConnectPanel
        client={client}
        onConnected={reload}
        connected={accounts.length}
        idleNote={
          accounts.length === 0 ? (
            <p className="m-0 text-ui text-faint" data-testid="git-accounts-empty">
              No GitHub account is connected yet.
            </p>
          ) : null
        }
        {...(pollDelay === undefined ? {} : { pollDelay })}
        {...(now === undefined ? {} : { now })}
      />
    </section>
  );
}
