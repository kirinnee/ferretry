/**
 * THE STEPPER, DRAWN FROM PLAIN VALUES (so every state renders without a daemon): six steps in a row, a check for the
 * ones done, the one to do now carrying the only highlight and the only button, the rest quiet. Each step is a list item
 * that says its state in words as well as in marks, for a reader who cannot see colour.
 */
import { Button, LivingBackground } from '@ferretry/app/ui';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { allDone, type StepperState, type StepperStep } from './stepper-model.ts';

/** What the current step offers: a label and what pressing it does (the owner of the place, not this view, decides where). */
export interface StepperAction {
  readonly label: string;
  readonly run: () => void;
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
            className="flex min-h-9 min-w-0 items-center gap-2"
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
            {step.state === 'current' && action !== undefined ? (
              <Button size="sm" variant="primary" onClick={action.run} data-first-run-stepper-action={step.id}>
                {action.label}
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
