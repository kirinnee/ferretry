/**
 * THE LAST PAGE: a real ending, not a box. A small mascot slot (the waving ferret takes its place when access exports it),
 * two borderless checklists side by side on a desktop (this machine, this device; `setup-summary.tsx`), then the way on:
 * ONE primary button (the footer's "Open this machine") and the two ways to start work as secondary buttons, all three
 * ONE width (`end-page.css`): a project, or a conversation without one. Those two buttons and the sentence about working
 * projectless are the Home card's (`../stepper/project-action.ts`), so the words never differ between the two places.
 * Either one missing (its plugin is paused) leaves the other; both missing leaves just the way to the machine's Home.
 */
import { daemonHomeHref, StepPageFrame, useOptionalRouter, useScreenHref } from '@ferretry/app';
import { Button } from '@ferretry/app/ui';
import { PartyPopper } from 'lucide-react';
import './end-page.css';
import type { Unsaved } from './use-setup-flow.ts';
import { type ReactNode, useMemo } from 'react';
import type { SummaryStep } from '../../views/steps-screen.tsx';
import { SetupSummary } from './setup-summary.tsx';
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
      line="Your machine is ready."
      {...(onBack === undefined ? {} : { back: { onClick: onBack } })}
      next={{ label: 'Open this machine', onClick: home }}
    >
      <div className="fy-end" data-flow-end="">
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
        <div className="fy-end__mascot" data-end-mascot="" aria-hidden="true">
          <PartyPopper size={28} strokeWidth={1.75} />
        </div>
        <SetupSummary daemon={daemon} steps={summary} />
        {action === undefined ? null : (
          <section className="fy-end__start" data-flow-end-start="" aria-label="Start with">
            <div className="fy-end__actions">
              <Button onClick={action.run} data-flow-end-project="">
                {action.label}
              </Button>
              {action.alternative === undefined ? null : (
                <Button onClick={action.alternative.run} data-flow-end-alternative="">
                  {action.alternative.label}
                </Button>
              )}
            </div>
            {action.note === undefined ? null : (
              <details className="fy-end__more" data-flow-end-note="">
                <summary>Without a project?</summary>
                <p className="fy-end__note">{action.note}</p>
              </details>
            )}
          </section>
        )}
      </div>
    </StepPageFrame>
  );
}
