/**
 * THE LAST PAGE: a real ending. A short summary of what was set up and what was skipped (each skipped thing a button to
 * its Settings), ONE primary button (the footer's "Open this machine"), and the two ways to start work as secondary buttons:
 * a project, or a conversation without one. Those two buttons and the sentence about working projectless are the Home
 * card's (`../stepper/project-action.ts`), so the words never differ between the two places. Either one missing (its plugin
 * is paused) leaves the other; both missing leaves just the way to the machine's Home.
 */
import { daemonHomeHref, StepPageFrame, useOptionalRouter, useScreenHref } from '@ferretry/app';
import { Button } from '@ferretry/app/ui';
import type { Unsaved } from './use-setup-flow.ts';
import { type ReactNode, useMemo } from 'react';
import { SetupSummary, type SummaryStep } from '../../views/steps-screen.tsx';
import { addProjectHref, projectAction } from '../stepper/project-action.ts';

export function EndPage({
  daemon,
  onBack,
  summary,
  unsaved = [],
  onRetry,
}: {
  readonly daemon: string;
  readonly onBack: (() => void) | undefined;
  readonly summary: readonly SummaryStep[];
  /** Answers the machine did not take: each is named, with its own Try again. */
  readonly unsaved?: readonly Unsaved[];
  readonly onRetry?: (key: string) => void;
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
      line="Here is what was set up, and what is left for later."
      {...(onBack === undefined ? {} : { back: { onClick: onBack } })}
      next={{ label: 'Open this machine', onClick: home }}
    >
      <div className="fy-sf-end" data-flow-end="">
        {unsaved.length === 0 ? null : (
          <div className="fy-sf-unsaved fy-sf-unsaved--end" data-flow-unsaved="">
            <p role="alert" className="fy-sf-note">
              {unsaved.length === 1 ? 'This answer was not saved:' : `${unsaved.length} answers were not saved:`}
            </p>
            <ul className="fy-sf-unsaved__list">
              {unsaved.map(item => (
                <li key={item.step.key} data-flow-unsaved-step={item.step.key}>
                  <span>{item.step.title}</span>
                  <Button size="sm" onClick={() => onRetry?.(item.step.key)} data-flow-retry-save={item.step.key}>
                    Try again
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <SetupSummary daemon={daemon} steps={summary} />
        {action === undefined ? null : (
          <section className="fy-sf-end__start" data-flow-end-start="">
            <p className="fy-sf-end__lead">Or start with:</p>
            <div className="fy-sf-end__actions">
              <Button onClick={action.run} data-flow-end-project="">
                {action.label}
              </Button>
              {action.alternative === undefined ? null : (
                <Button onClick={action.alternative.run} data-flow-end-alternative="">
                  {action.alternative.label}
                </Button>
              )}
            </div>
            {action.note === undefined ? null : <p className="fy-sf-note">{action.note}</p>}
          </section>
        )}
      </div>
    </StepPageFrame>
  );
}
