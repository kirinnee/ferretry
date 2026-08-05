/**
 * The numbered track: a real ordered list, because that is what it is.
 *
 * State is never carried by colour alone — a completed step swaps its number for
 * a tick, the current one is the only filled marker and is marked
 * `aria-current="step"`, and an unreached one is dashed. Each item also spells
 * its state out for a reader who hears the list rather than seeing it.
 *
 * It is a RAIL rather than a row of boxes: a 20px marker with its word under it,
 * joined by a hairline. The boxed version spent 44px of a 844px phone on chrome
 * that says nothing the marker does not, and bordered cards above the actual
 * step competed with it for attention.
 *
 * It is a track OF A ROUTE, not of the product: the three entry paths walk
 * different steps, so the list comes from the route rather than from a constant.
 * That is also why the labels are one word — and why the rail WRAPS rather than
 * truncating them: seven of them do not fit a 390px row, and an ellipsis where the
 * next thing to do should be is worse than a second row.
 */

import { Check } from 'lucide-react';

import {
  type OnboardingPath,
  type OnboardingStepId,
  type OnboardingStepStatus,
  onboardingRouteSteps,
  onboardingStep,
  onboardingStepStatus,
} from './onboarding-model.ts';

const STATUS_WORD: Record<OnboardingStepStatus, string> = {
  completed: 'completed, go back to it',
  current: 'current step',
  upcoming: 'not reached yet',
};

const ITEM = 'flex w-full min-w-0 flex-col items-center gap-1 py-1 text-center';

const MARKER = 'flex h-5 w-5 items-center justify-center rounded-full border text-2xs font-semibold';

const MARKER_TONE: Record<OnboardingStepStatus, string> = {
  completed: 'border-accent bg-accent-bg text-accent',
  current: 'border-accent bg-accent text-accent-fg',
  upcoming: 'border-dashed border-border text-faint',
};

const LABEL_TONE: Record<OnboardingStepStatus, string> = {
  completed: 'text-muted',
  current: 'font-semibold text-fg',
  upcoming: 'text-faint',
};

export interface OnboardingTrackProps {
  /**
   * Which route's steps this is a track OF, ON WHICH DEVICE.
   *
   * The device belongs in the path rather than beside it: first-time setup is a
   * genuinely different list on a phone than on a computer, and a track that
   * could be rendered without knowing which would draw the wrong journey.
   */
  readonly path: OnboardingPath;
  readonly current: OnboardingStepId;
  readonly furthest: OnboardingStepId;
  readonly onJump: (id: OnboardingStepId) => void;
}

export function OnboardingTrack({ path, current, furthest, onJump }: OnboardingTrackProps) {
  return (
    <ol className="m-0 flex list-none flex-wrap items-start gap-1 p-0" aria-label="Setup steps">
      {onboardingRouteSteps(path).map((id, index) => {
        const step = onboardingStep(id);
        const status = onboardingStepStatus(path, step.id, current, furthest);
        const body = (
          <>
            <span className={`${MARKER} ${MARKER_TONE[status]}`} aria-hidden="true">
              {status === 'completed' ? <Check size={12} strokeWidth={3} /> : index + 1}
            </span>
            {/*
              WHOLE WORDS, ON HOWEVER MANY ROWS THAT TAKES. `truncate` was
              affordable while the longest journey a phone could reach was five
              steps; at seven, 390px divided seven ways clipped the two steps
              immediately ahead of the reader to "Daem…" and "Conn…" — an ellipsis
              where the next thing they have to do should be. Breaking mid-word
              instead ("Daemo/n") is not better. So the RAIL wraps rather than the
              word: `basis` gives each item a floor wide enough for its label, and a
              seven-step journey becomes two rows on a phone and stays one on
              anything wider. The eleven-step self-hosted journey gains the most.
            */}
            <span className={`w-full text-center text-2xs leading-tight ${LABEL_TONE[status]}`}>{step.short}</span>
            <span className="sr-only">{STATUS_WORD[status]}</span>
          </>
        );
        return (
          <li key={step.id} className="min-w-0 flex-1 basis-[4.25rem]">
            {status === 'completed' ? (
              <button
                type="button"
                className={`${ITEM} rounded-control focus-visible:outline-focus focus-visible:outline-offset-focus`}
                onClick={() => onJump(step.id)}
                data-onboarding-jump={step.id}
              >
                {body}
              </button>
            ) : (
              <span
                className={ITEM}
                aria-current={status === 'current' ? 'step' : undefined}
                data-onboarding-track={status}
              >
                {body}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
