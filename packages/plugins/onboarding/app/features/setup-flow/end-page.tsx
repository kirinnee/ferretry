/**
 * THE LAST PAGE: a real ending, not a box. The picture is the `onboarding.end` slot's (Access places the cheering ferret,
 * which answers a hover or a tap; Onboarding imports nothing of it) and fills the frame's demo column: the right half on a
 * desktop, above the page on a phone. The body is the two borderless checklists (this machine, this device;
 * `setup-summary.tsx`), then the way on:
 * ONE primary button (the footer's "Open this machine") and the two ways to start work as secondary buttons, all three
 * ONE width (`end-page.css`): a project, or a conversation without one. Those two buttons and the sentence about working
 * projectless are the Home card's (`../stepper/project-action.ts`), so the words never differ between the two places.
 * Either one missing (its plugin is paused) leaves the other; both missing leaves just the way to the machine's Home.
 */
import {
  daemonHomeHref,
  PanelSlot,
  StepDemo,
  StepPageFrame,
  useOptionalRouter,
  useScreenHref,
  useSlotHasUsablePanels,
} from '@ferretry/app';
import { Button } from '@ferretry/app/ui';
import './end-page.css';
import { ONBOARDING_END_SLOT } from '../../../contract/index.ts';
import type { Unsaved } from './use-setup-flow.ts';
import { type ReactNode, useMemo } from 'react';
import type { SummaryStep } from '../../views/steps-screen.tsx';
import { leftToFinish, SetupSummary } from './setup-summary.tsx';
import { addProjectHref, continueConversationHref, projectAction } from '../stepper/project-action.ts';

/** The picture, in the frame's demo column. */
function Picture({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <StepDemo>
      <div className="fy-end__mascot" data-end-mascot="" aria-hidden="true">
        {children}
      </div>
    </StepDemo>
  );
}

/** The `onboarding.end` slot's panels; with none usable (Access off) the page draws no column. */
function SlotPicture({ daemon }: { readonly daemon: string }): ReactNode {
  const usable = useSlotHasUsablePanels(daemon, ONBOARDING_END_SLOT);
  return usable ? (
    <Picture>
      <PanelSlot daemon={daemon} slot={ONBOARDING_END_SLOT} />
    </Picture>
  ) : null;
}

export function EndPage({
  daemon,
  opens,
  onBack,
  summary,
  unsaved = [],
  onRetry,
  picture,
}: {
  readonly daemon: string;
  /** Where project setup left the person (the project it registered): the way on is then "Open <project>", not a second project button. */
  readonly opens?: { readonly label: string; readonly href: string } | undefined;
  readonly onBack: (() => void) | undefined;
  readonly summary: readonly SummaryStep[];
  /** Answers the machine did not take: each is named, with its own Try again. */
  readonly unsaved?: readonly Unsaved[];
  readonly onRetry?: (key: string) => void;
  /** Stands in for the `onboarding.end` slot's picture (a browser scene has no shell); `null` is no picture. */
  readonly picture?: ReactNode;
}): ReactNode {
  const router = useOptionalRouter();
  const screenHref = useScreenHref();
  const action = useMemo(() => {
    const go = (href: string | undefined) => (href === undefined ? undefined : () => router?.navigate(href));
    const projects = screenHref(daemon, 'projects', 'projects');
    return projectAction(
      opens === undefined ? go(projects === undefined ? undefined : addProjectHref(projects)) : undefined,
      go(continueConversationHref(screenHref, daemon)),
    );
  }, [daemon, opens, router, screenHref]);
  const left = useMemo(() => leftToFinish(summary), [summary]);
  const home = (): void => router?.navigate(opens?.href ?? daemonHomeHref(daemon));
  return (
    <StepPageFrame
      title={left.length === 0 ? "You're set up" : 'Setup is partly done'}
      line={left.length === 0 ? 'Your machine is ready.' : `Still to finish: ${left.join(', ')}.`}
      {...(onBack === undefined ? {} : { back: { onClick: onBack } })}
      next={{ label: opens?.label ?? 'Open this machine', onClick: home }}
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
        {picture === undefined ? (
          <SlotPicture daemon={daemon} />
        ) : picture === null ? null : (
          <Picture>{picture}</Picture>
        )}
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
