/**
 * THE LAST PAGE: the flow is over, and the next move is a project (primary) or a conversation without one. The two
 * buttons and the sentence about working projectless are the Home card's (`../stepper/project-action.ts`), so the
 * words never differ between the two places. Either one missing (its plugin is paused) leaves the other; both missing
 * leaves the way to the machine's Home.
 */
import { daemonHomeHref, StepPageFrame, useOptionalRouter, useScreenHref } from '@ferretry/app';
import { Button } from '@ferretry/app/ui';
import { type ComponentProps, type ReactNode, useMemo } from 'react';
import { SetupSummary } from '../../views/steps-screen.tsx';
import { addProjectHref, projectAction } from '../stepper/project-action.ts';

export function EndPage({
  daemon,
  onBack,
  summary,
}: {
  readonly daemon: string;
  readonly onBack: (() => void) | undefined;
  readonly summary: ComponentProps<typeof SetupSummary>['steps'];
}): ReactNode {
  const router = useOptionalRouter();
  const screenHref = useScreenHref();
  const action = useMemo(() => {
    const go = (href: string | undefined) => (href === undefined ? undefined : () => router?.navigate(href));
    const projects = screenHref(daemon, 'projects', 'projects');
    return projectAction(
      go(projects === undefined ? undefined : addProjectHref(projects)),
      go(screenHref(daemon, 'conversation', 'links')),
    );
  }, [daemon, router, screenHref]);
  const home = (): void => router?.navigate(daemonHomeHref(daemon));
  return (
    <StepPageFrame
      title="You're set up"
      line="Your machine is ready. Pick a first project, or start a conversation."
      {...(onBack === undefined ? {} : { back: { onClick: onBack } })}
      next={{ label: action?.label ?? 'Open this machine', onClick: action?.run ?? home }}
    >
      <div className="fy-sf-end" data-flow-end="">
        <SetupSummary daemon={daemon} steps={summary} />
        {action?.alternative === undefined ? null : (
          <div className="fy-sf-end__actions">
            <Button onClick={action.alternative.run} data-flow-end-alternative="">
              {action.alternative.label}
            </Button>
          </div>
        )}
        {action?.note === undefined ? null : <p className="fy-sf-note">{action.note}</p>}
        {action === undefined ? null : (
          <Button variant="ghost" size="sm" onClick={home} data-flow-end-home="">
            Open this machine
          </Button>
        )}
      </div>
    </StepPageFrame>
  );
}
