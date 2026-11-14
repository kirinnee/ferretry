import { PanelPath } from '@ferretry/app/ui';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import type { ConfigIssue } from './api.ts';

/** Where an issue is: `path:line:col`, as far as the daemon could place it. */
const issueLocation = (issue: ConfigIssue): string =>
  [issue.path, issue.line, issue.line === undefined ? undefined : issue.column]
    .filter(part => part !== undefined)
    .join(':');

/** Each issue located, with its plain fix. An error keeps the file's last good version in effect; a warning does not. */
export function ConfigIssueList({ issues }: { readonly issues: readonly ConfigIssue[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-config-issues="">
      {issues.map((issue, index) => (
        <li
          // Issues have no id; a list is replaced whole on every read, so position is stable.
          key={`${issueLocation(issue)}-${String(index)}`}
          data-config-issue={issue.severity}
          className={
            issue.severity === 'error'
              ? 'flex min-w-0 items-start gap-2 rounded-control border border-err-border bg-err-bg px-3 py-2'
              : 'flex min-w-0 items-start gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2'
          }
        >
          {issue.severity === 'error' ? (
            <CircleAlert size={14} aria-hidden="true" className="mt-1 shrink-0 text-err" />
          ) : (
            <TriangleAlert size={14} aria-hidden="true" className="mt-1 shrink-0 text-warn" />
          )}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="sr-only">{issue.severity === 'error' ? 'Error' : 'Warning'}: </span>
            <PanelPath value={issueLocation(issue)} className="text-meta text-fg" />
            <span className="min-w-0 break-words text-ui leading-base text-fg">{issue.message}</span>
            {issue.fix === undefined ? null : (
              <span className="min-w-0 break-words text-meta leading-base text-muted">{issue.fix}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
