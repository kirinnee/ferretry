/**
 * A PROJECT'S LINKED GIT ACCOUNTS, with the ones that no longer exist said plainly.
 *
 * A link outlives the account it names, so the project never silently loses a choice the person made. When an account
 * has been removed the link reads "account removed" (its id, nothing else, because the login went with the account), and
 * a read of the account list that failed says so rather than calling every link removed.
 */
import { TriangleAlert, UserRound } from 'lucide-react';
import { accountLinks, type ProjectInfo } from '../../../contract/index.ts';
import type { ProjectsClient } from '../../lib/client.ts';
import { useGitAccounts } from './use-git-accounts.ts';

export interface AccountLinksViewProps {
  readonly project: Pick<ProjectInfo, 'accounts'>;
  /** The accounts that exist now, or `null` when that could not be read. */
  readonly existing: readonly { readonly id: string; readonly login: string }[] | null;
  readonly error: string | null;
}

export function AccountLinksView({ project, existing, error }: AccountLinksViewProps) {
  const linked = project.accounts ?? [];
  if (linked.length === 0) {
    return (
      <p className="m-0 text-meta text-faint" data-project-accounts="none">
        No GitHub account is linked to this project.
      </p>
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
    <ul className="m-0 grid list-none gap-xs p-0" data-project-accounts="ready">
      {accountLinks(
        linked,
        existing.map(account => account.id),
      ).map(link => (
        <li
          key={link.id}
          className="flex min-h-control items-center gap-xs rounded-control border border-border-soft bg-surface-2 px-control-x py-1 text-ui"
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

/** The links of one project, bound to a daemon's accounts. */
export function ProjectAccountLinks({
  client,
  project,
}: {
  readonly client: ProjectsClient;
  readonly project: Pick<ProjectInfo, 'accounts'>;
}) {
  const { accounts, error } = useGitAccounts(client);
  return <AccountLinksView project={project} existing={accounts} error={error} />;
}
