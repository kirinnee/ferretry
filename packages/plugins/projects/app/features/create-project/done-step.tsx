/** STEP 5: DONE. What was made, and the way into the project. */
import { RouteLink } from '@ferretry/app/ui';
import type { ProjectInfo } from '../../../contract/index.ts';
import { AccountLinksView } from './account-links.tsx';
import type { GitAccountsState } from './use-git-accounts.ts';

export interface DoneStepProps {
  readonly project: ProjectInfo;
  readonly accounts: GitAccountsState;
  readonly projectHref?: (projectId: string) => string;
  readonly onNavigate?: (to: string) => void;
  readonly onClose: () => void;
}

export function DoneStep({ project, accounts, projectHref, onNavigate, onClose }: DoneStepProps) {
  return (
    <div className="grid gap-md" data-create-step="done" data-create-done={project.id}>
      <div className="grid gap-0.5">
        <p className="m-0 text-ui font-semibold text-fg">{project.name} is ready.</p>
        <p className="mono m-0 break-all text-meta text-muted">{project.path}</p>
      </div>
      <div className="grid gap-xs">
        <p className="m-0 text-meta font-semibold uppercase tracking-wide text-muted">GitHub accounts</p>
        <AccountLinksView project={project} existing={accounts.accounts} error={accounts.error} />
      </div>
      <div className="flex flex-wrap items-center gap-sm">
        {projectHref !== undefined && (
          <RouteLink
            to={projectHref(project.id)}
            {...(onNavigate === undefined ? {} : { onNavigate })}
            className="kt-btn min-h-control"
            data-variant="primary"
          >
            Open the project
          </RouteLink>
        )}
        <button type="button" className="kt-btn min-h-control" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
