/**
 * A PROJECT'S LINKED GIT ACCOUNTS, with the ones that no longer exist said plainly.
 *
 * A link outlives the account it names, so the project never silently loses a choice the person made. When an account
 * has been removed the link reads "account removed" (its id, nothing else, because the login went with the account), and
 * a read of the account list that failed says so rather than calling every link removed.
 */
import { ConfirmToSee } from '@ferretry/app/ui';
import { TriangleAlert, UserRound } from 'lucide-react';
import { useState } from 'react';
import { accountLinks, type ProjectInfo, type ProjectsConnectAccount } from '../../../contract/index.ts';
import type { ProjectsClient } from '../../lib/client.ts';
import { setProjectAccounts } from './accounts-api.ts';
import { AccountLinksEditor } from './account-links-editor.tsx';
import { ConnectCard } from './connect-card.tsx';
import { useGitAccounts } from './use-git-accounts.ts';

export interface AccountLinksViewProps {
  readonly project: Pick<ProjectInfo, 'accounts'>;
  /** The accounts that exist now, or `null` when that could not be read. */
  readonly existing: readonly { readonly id: string; readonly login: string }[] | null;
  readonly error: string | null;
  /** The person's press, present when the read was refused only for want of the passkey step-up. */
  readonly onConfirm?: (() => void) | undefined;
}

export function AccountLinksView({ project, existing, error, onConfirm }: AccountLinksViewProps) {
  const linked = project.accounts ?? [];
  if (linked.length === 0) {
    // An unlinked project still needs the passkey press: the editor that links the FIRST account only opens once the
    // account list has been read, so hiding the press here would leave that project with no way to be linked.
    return (
      <div className="grid gap-xs">
        <p className="m-0 text-meta text-faint" data-project-accounts="none">
          No GitHub account is linked to this project.
        </p>
        {existing === null && onConfirm !== undefined && (
          <ConfirmToSee
            line="This machine wants your passkey before it shows its GitHub accounts, so one cannot be linked yet."
            onConfirm={onConfirm}
          />
        )}
      </div>
    );
  }
  if (existing === null && onConfirm !== undefined) {
    return (
      <div data-project-accounts="unread">
        <ConfirmToSee
          line="This machine wants your passkey before it shows its GitHub accounts, so these links cannot be checked yet."
          onConfirm={onConfirm}
        />
      </div>
    );
  }
  if (existing === null) {
    return (
      <p
        className={error === null ? 'm-0 text-meta text-muted' : 'm-0 text-meta text-warn'}
        role="status"
        data-project-accounts="unread"
      >
        {error === null
          ? 'Reading the connected accounts…'
          : `Could not read the connected accounts, so these links cannot be checked: ${error}`}
      </p>
    );
  }
  const logins = new Map(existing.map(account => [account.id, account.login]));
  return (
    <ul className="m-0 grid list-none divide-y divide-border-soft p-0" data-project-accounts="ready">
      {accountLinks(
        linked,
        existing.map(account => account.id),
      ).map(link => (
        <li
          key={link.id}
          className="flex min-h-control items-center gap-xs py-1 text-ui"
          data-project-account={link.id}
          data-project-account-removed={link.removed ? 'true' : 'false'}
        >
          {link.removed ? (
            <TriangleAlert className="shrink-0 text-warn" size={14} aria-hidden="true" />
          ) : (
            <UserRound className="shrink-0 text-muted" size={14} aria-hidden="true" />
          )}
          {link.removed ? (
            <>
              <span className="mono min-w-0 truncate text-muted">{link.id}</span>
              <span className="text-warn">account removed</span>
            </>
          ) : (
            <span className="min-w-0 truncate">@{logins.get(link.id)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The links of one project, bound to a daemon's accounts. Given `edit`, it also offers the control to change them. */
export function ProjectAccountLinks({
  client,
  project,
  edit,
  startEditing = false,
  connect,
}: {
  readonly client: ProjectsClient;
  readonly project: Pick<ProjectInfo, 'accounts'>;
  readonly edit?: {
    readonly projectId: ProjectInfo['id'];
    /** The daemon accepted a new list; the caller re-reads the project so the list above re-renders. */
    readonly onSaved: () => void;
  };
  /** Open the editor as soon as the accounts are read (a caller whose own button already said "link"). */
  readonly startEditing?: boolean;
  /**
   * Offer "Connect a GitHub account" when none is connected, through Git accounts' own card (what the create flow
   * mounts). A connected account is linked to the project at once, as the create flow does. Absent, nothing is offered.
   */
  readonly connect?: { readonly provided: ProjectsConnectAccount | undefined };
}) {
  const { accounts, error, stepUp, confirm, reload } = useGitAccounts(client);
  const [editing, setEditing] = useState(startEditing);
  const canEdit = edit !== undefined && accounts !== null && accounts.length > 0;
  return (
    <div className="grid gap-xs">
      <AccountLinksView project={project} existing={accounts} error={error} onConfirm={stepUp ? confirm : undefined} />
      {canEdit && editing ? (
        <AccountLinksEditor
          client={client}
          project={{ id: edit.projectId, accounts: project.accounts }}
          existing={accounts}
          onSaved={() => {
            setEditing(false);
            edit.onSaved();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        canEdit && (
          <div>
            <button
              type="button"
              className="kt-btn kt-btn--sm"
              data-project-accounts-edit=""
              onClick={() => setEditing(true)}
            >
              {(project.accounts ?? []).length === 0 ? 'Link an account' : 'Change accounts'}
            </button>
          </div>
        )
      )}
      {connect !== undefined && edit !== undefined && accounts !== null && accounts.length === 0 ? (
        <div data-project-accounts-connect="">
          <ConnectCard
            connected={0}
            onConnected={accountId => {
              // The account just connected is the one meant for this project: link it without a second press.
              void setProjectAccounts(client, edit.projectId, [...(project.accounts ?? []), accountId]).then(
                () => {
                  reload();
                  edit.onSaved();
                },
                () => reload(),
              );
            }}
            provided={connect.provided}
          />
        </div>
      ) : null}
    </div>
  );
}
