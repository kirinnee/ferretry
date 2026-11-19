/** STEP 5: DONE. What was made, and the way into the project. */
import { StepPageFrame, type StepProgressProps } from '@ferretry/app';
import type { ProjectInfo } from '../../../contract/index.ts';
import { AccountLinksView } from './account-links.tsx';
import type { GitAccountsState } from './use-git-accounts.ts';

export interface DoneStepProps {
  readonly project: ProjectInfo;
  readonly accounts: GitAccountsState;
  readonly progress: StepProgressProps;
  readonly projectHref?: (projectId: string) => string;
  readonly onNavigate?: (to: string) => void;
  readonly onClose: () => void;
}

export function DoneStep({ project, accounts, progress, projectHref, onNavigate, onClose }: DoneStepProps) {
  const href = projectHref?.(project.id);
  return (
    <StepPageFrame
      title={`${project.name} is ready`}
      progress={progress}
      next={{
        label: href === undefined ? 'Close' : 'Open the project',
        onClick: () => {
          if (href !== undefined) onNavigate?.(href);
          onClose();
        },
      }}
    >
      <div className="grid gap-md" data-create-step="done" data-create-done={project.id}>
        <p className="mono m-0 break-all text-meta text-muted">{project.path}</p>
        <div className="grid gap-xs">
          <p className="m-0 text-meta font-semibold uppercase tracking-wide text-muted">GitHub accounts</p>
          <AccountLinksView
            project={project}
            existing={accounts.accounts}
            error={accounts.error}
            onConfirm={accounts.stepUp ? accounts.confirm : undefined}
          />
        </div>
      </div>
    </StepPageFrame>
  );
}
