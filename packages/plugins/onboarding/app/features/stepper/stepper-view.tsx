/**
 * THE STEPPER, DRAWN FROM PLAIN VALUES (so every state renders without a daemon): six steps in a row, a check for the
 * ones done, the one to do now carrying the only highlight and the only button, the rest quiet. Each step is a list item
 * that says its state in words as well as in marks, for a reader who cannot see colour.
 */
import { ActionRow, Button, LivingBackground } from '@ferretry/app/ui';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { allDone, type StepperState, type StepperStep } from './stepper-model.ts';

/** What the current step offers: a label and what pressing it does (the owner of the place, not this view, decides where). */
export interface StepperAction {
  readonly label: string;
  readonly run: () => void;
  /** A second way to finish the same step (the Project step: "Continue a conversation"): a plain button beside the primary one, never a second highlight. */
  readonly alternative?: { readonly label: string; readonly run: () => void } | undefined;
  /** One sentence under the list that says what the choice means (the projectless words). */
  readonly note?: string | undefined;
}

export interface StepperViewProps {
  readonly steps: readonly StepperStep[];
  /** The action for the current step; absent means the step has no place to go from here. */
  readonly action?: StepperAction | undefined;
  readonly onDismiss: () => void;
}

const STATE_WORD: Readonly<Record<StepperState, string>> = {
  done: 'done',
  current: 'up next',
  next: 'later',
  unknown: 'not known',
};

function Mark({ state, index }: { readonly state: StepperState; readonly index: number }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={
        state === 'current'
          ? 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent bg-accent text-cell font-semibold text-bg'
          : state === 'done'
            ? 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface text-fg'
            : 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border-strong text-cell text-muted'
      }
    >
      {state === 'done' ? <Check size={14} strokeWidth={3} /> : index + 1}
    </span>
  );
}

export function StepperView({ steps, action, onDismiss }: StepperViewProps): ReactNode {
  const finished = allDone(steps);
  const current = steps.find(step => step.state === 'current');
  /** A step with a second way through, or words to read first, is drawn as a block under the list rather than squeezed into its row. */
  const offersChoice = action !== undefined && (action.alternative !== undefined || action.note !== undefined);
  return (
    <section
      aria-labelledby="first-run-stepper-heading"
      className="mx-auto mt-2 w-full max-w-[1320px] min-w-0 rounded-control border border-border-strong bg-surface-2 px-3 py-2"
      data-first-run-stepper={finished ? 'done' : 'open'}
    >
      <LivingBackground fill="parent" />
      <div className="flex min-h-9 min-w-0 items-center justify-between gap-2">
        <h2 id="first-run-stepper-heading" className="m-0 text-row font-semibold text-fg">
          {finished ? 'This machine is set up' : 'Get this machine ready'}
        </h2>
        {finished ? (
          <Button size="sm" onClick={onDismiss} data-first-run-stepper-dismiss="">
            Dismiss
          </Button>
        ) : null}
      </div>
      <ol className="m-0 mt-2 flex list-none flex-col gap-2 p-0 sm:flex-row sm:flex-wrap sm:gap-x-4">
        {steps.map((step, index) => (
          <li
            key={step.id}
            aria-current={step.state === 'current' ? 'step' : undefined}
            className="flex min-h-9 min-w-0 flex-wrap items-center gap-2"
            data-step={step.id}
            data-state={step.state}
          >
            <Mark index={index} state={step.state} />
            <span
              className={
                step.state === 'current'
                  ? 'min-w-0 flex-1 text-cell font-semibold text-fg sm:flex-none'
                  : step.state === 'done'
                    ? 'min-w-0 flex-1 text-cell text-fg sm:flex-none'
                    : 'min-w-0 flex-1 text-cell text-muted sm:flex-none'
              }
            >
              {step.title}
              <span className="sr-only"> — {STATE_WORD[step.state]}</span>
            </span>
            {step.state === 'current' && action !== undefined && !offersChoice ? (
              <Button size="sm" variant="primary" onClick={action.run} data-first-run-stepper-action={step.id}>
                {action.label}
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
      {current === undefined || action === undefined || !offersChoice ? null : (
        <div
          className="mt-3 flex min-w-0 flex-col gap-2 border-t border-border-strong pt-3"
          data-first-run-stepper-choice=""
        >
          {/* The shared answer row (C59 audit): equal size, the alternative at the left end and the way on at the right on a
              desktop, both the column's width on a phone, so neither answer is narrower or louder than the other. */}
          <ActionRow
            secondary={
              action.alternative === undefined ? undefined : (
                <Button onClick={action.alternative.run} data-first-run-stepper-alternative={current.id}>
                  {action.alternative.label}
                </Button>
              )
            }
            primary={
              <Button variant="primary" onClick={action.run} data-first-run-stepper-action={current.id}>
                {action.label}
              </Button>
            }
          />
          {action.note === undefined ? null : (
            <p className="m-0 max-w-[70ch] text-cell text-muted" data-first-run-stepper-note="">
              {action.note}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
