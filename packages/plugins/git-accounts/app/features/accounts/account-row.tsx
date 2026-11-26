/**
 * One connected account: a letter avatar, the login, which keys Ferretry registered on it, and Remove (asked twice,
 * because it deletes those keys on GitHub). The avatar is the login's first letter: the app's Content-Security-Policy
 * lets no image in from GitHub's avatar host, and this screen does not widen it.
 */
import { useState } from 'react';
import type { GitAccount } from '../../../contract/index.ts';
import type { GitAccountsClient } from '../../shell.tsx';
import { SigningControls } from './signing-controls.tsx';

export interface AccountRowProps {
  readonly account: GitAccount;
  readonly busy: boolean;
  readonly onRemove: (account: GitAccount) => void;
  readonly client: GitAccountsClient;
  readonly onChanged: () => void;
}

function Chip({ on, label }: { readonly on: boolean; readonly label: string }) {
  return (
    <span
      className={`rounded-control px-2 py-0.5 text-meta font-medium ${on ? 'bg-ok-bg text-ok' : 'bg-surface-3 text-muted'}`}
      data-key-chip={label}
      data-on={on ? 'yes' : 'no'}
    >
      {on ? '✓' : '–'} {label}: {on ? 'registered' : 'none'}
    </span>
  );
}

export function AccountRow({ account, busy, onRemove, client, onChanged }: AccountRowProps) {
  const [asking, setAsking] = useState(false);
  return (
    <li className="flex flex-col gap-2 py-3" data-account={account.id}>
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-ui font-semibold uppercase text-accent"
        >
          {account.login.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 break-all text-ui font-semibold text-fg">@{account.login}</p>
          <p className="m-0 break-words text-meta text-faint">
            <span className="whitespace-nowrap">
              {account.name === undefined || account.name === '' ? 'GitHub' : `${account.name} · GitHub`}
            </span>{' '}
            <span className="whitespace-nowrap">· connected {account.createdAt.slice(0, 10)}</span>
          </p>
        </div>
        {/* Kept in place (invisible) while the question is open, so the row does not reflow. */}
        <button
          type="button"
          className={`kt-btn min-h-[44px] ${asking ? 'invisible' : ''}`}
          data-variant="danger"
          disabled={busy || asking}
          tabIndex={asking ? -1 : 0}
          aria-hidden={asking ? 'true' : undefined}
          {...(asking ? {} : { 'aria-label': `Remove @${account.login}` })}
          onClick={() => setAsking(true)}
        >
          Remove
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Chip on={account.keys.ssh !== undefined} label="SSH key" />
        <Chip on={account.keys.signing !== undefined} label="Signing key" />
      </div>
      <SigningControls account={account} client={client} onChanged={onChanged} />
      {asking ? (
        <section className="flex flex-col gap-2 rounded-panel bg-warn-bg p-4" aria-label={`Remove @${account.login}?`}>
          <p className="m-0 text-cell leading-base text-muted">
            This deletes the keys Ferretry registered on @{account.login} at GitHub, then forgets its token on this
            machine. To fully revoke the app, open github.com/settings/applications afterwards.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              data-variant="danger"
              disabled={busy}
              onClick={() => {
                setAsking(false);
                onRemove(account);
              }}
            >
              Remove @{account.login}
            </button>
            <button type="button" className="kt-btn min-h-[44px]" onClick={() => setAsking(false)}>
              Keep it
            </button>
          </div>
        </section>
      ) : null}
    </li>
  );
}
