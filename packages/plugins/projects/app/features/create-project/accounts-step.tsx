/**
 * STEP 3: CONNECT GITHUB ACCOUNTS. Pick from the connected ones (as many as you like, the first is the default) or
 * connect another by device flow. Skipping is fine: a project without an account still works.
 */
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { ProjectsClient } from '../../lib/client.ts';
import { reasonOf } from '../../lib/client.ts';
import { setProjectAccounts } from './accounts-api.ts';
import { ConnectAccount } from './connect-account.tsx';
import type { GitAccountsState } from './use-git-accounts.ts';
import { useDeviceFlow } from './use-device-flow.ts';

export interface AccountsStepProps {
  readonly client: ProjectsClient;
  readonly projectId: string;
  readonly accounts: GitAccountsState;
  readonly selected: readonly string[];
  readonly onSelectedChange: (ids: readonly string[]) => void;
  /** Linked; the project record now holds these ids. */
  readonly onLinked: (ids: readonly string[]) => void;
  readonly onSkip: () => void;
}

export function AccountsStep({
  client,
  projectId,
  accounts,
  selected,
  onSelectedChange,
  onLinked,
  onSkip,
}: AccountsStepProps) {
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const flow = useDeviceFlow(client, (accountId: string) => {
    accounts.reload();
    // A freshly connected account is the one meant to be used: link it without a second press.
    onSelectedChange(selected.includes(accountId) ? selected : [...selected, accountId]);
  });
  const toggle = (id: string, on: boolean): void =>
    onSelectedChange(
      on ? (selected.includes(id) ? selected : [...selected, id]) : selected.filter(each => each !== id),
    );

  const save = (): void => {
    if (saving) return;
    setSaving(true);
    setRefused(null);
    void setProjectAccounts(client, projectId, selected).then(
      () => onLinked(selected),
      (cause: unknown) => {
        setSaving(false);
        setRefused(reasonOf(cause));
      },
    );
  };

  return (
    <div className="grid gap-md" data-create-step="accounts">
      <p className="m-0 max-w-prose text-meta leading-base text-muted">
        Link the GitHub accounts this project uses. Ferrets working here push and sign as the first one. You can connect
        as many as you like, and change this later.
      </p>
      {accounts.error !== null && (
        <p className="m-0 flex items-start gap-xs text-meta text-warn" role="status" data-create-accounts-error="">
          <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
          Could not read the connected accounts: {accounts.error}
        </p>
      )}
      {accounts.accounts === null ? (
        accounts.error === null && <p className="m-0 text-meta text-muted">Reading the connected accounts…</p>
      ) : accounts.accounts.length === 0 ? (
        <p className="m-0 text-meta text-faint" data-create-accounts-empty="">
          No GitHub account is connected on this machine yet.
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-xs p-0">
          {accounts.accounts.map(account => (
            <li key={account.id}>
              <label
                className="flex min-h-control cursor-pointer items-center gap-sm rounded-control border border-border-soft bg-surface-2 px-control-x py-1 text-ui"
                data-create-account={account.id}
              >
                <input
                  type="checkbox"
                  className="size-4 accent-accent"
                  checked={selected.includes(account.id)}
                  onChange={event => toggle(account.id, event.target.checked)}
                />
                <span className="min-w-0 truncate">@{account.login}</span>
                {selected[0] === account.id && selected.length > 1 && (
                  <span className="text-meta text-muted">default</span>
                )}
              </label>
            </li>
          ))}
        </ul>
      )}
      <ConnectAccount controls={flow} />
      {refused !== null && (
        <p className="m-0 flex items-start gap-xs text-meta text-err" role="alert">
          <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
          This daemon refused the link: {refused}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-sm">
        <button
          type="button"
          className="kt-btn min-h-control"
          data-variant="primary"
          disabled={saving || selected.length === 0}
          onClick={save}
        >
          {saving && <LoaderCircle className="animate-spin motion-reduce:animate-none" size={14} aria-hidden="true" />}
          Link {selected.length === 1 ? 'this account' : 'these accounts'}
        </button>
        <button type="button" className="kt-btn min-h-control" onClick={onSkip} disabled={saving}>
          Skip for now
        </button>
      </div>
    </div>
  );
}
