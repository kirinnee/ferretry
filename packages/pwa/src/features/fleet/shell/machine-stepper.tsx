/**
 * The stepper frame every Machines flow renders inside (docs/design/account-model.md §4.1).
 *
 * A REAL STEPPER, not a progress bar (the approved usability proposal): every step is NAMED and
 * NUMBERED, a step that is done shows ✓, and the current one is highlighted — so a person can see what
 * is done, what this is, and what is next. On a phone it is segments with the step names under them.
 *
 * Two presentations of the same rules (`stepper-model.ts`):
 *
 * - `inline` — inside Settings (Clone, Add a login, Install…): ‹ Back, "Step n of m", Cancel, the named
 *   steps, the page title, then the step.
 * - `embedded` — inside a step of New machine setup (Start from › Clone). That rail is the only stepper
 *   on screen, so this draws NO step list, no "Step n of m" and no title of its own: only the page and,
 *   after its first page, a ‹ Back. A step never holds a stepper.
 *
 * And the two states that replace a step's body:
 *
 * - **Leave confirmation.** Cancel (or Back from step 1) asks first, says what will not be created and
 *   lists what was already saved for reuse, which is kept.
 * - **Paused.** A machine that is asleep or offline pauses the flow (O5): the progress stays exactly
 *   where it was, but the step's body is not rendered, so nothing it would send can be queued. A write
 *   needs the machine awake; Retry asks the caller to check again.
 *
 * The step's own body is the caller's (`children`); this frame never knows what a step asks.
 */

import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { cn } from '../../../lib/class-names.ts';
import { Button } from '../../../shell/primitives.tsx';
import { AccountStatus } from './account-status.tsx';
import {
  backStep,
  cancelStepper,
  currentFlow,
  keepGoing,
  type StepperFlow,
  type StepperState,
  stepPosition,
  stopStepper,
} from './stepper-model.ts';

export interface MachineStepperProps {
  readonly state: StepperState;
  /** The next state, or `null` when the person has left the whole stepper. */
  readonly onChange: (next: StepperState | null) => void;
  /** The machine the flow changes, named on the pause note. */
  readonly machineName: string;
  /** `false` pauses the flow (O5). */
  readonly online: boolean;
  /** A reachability check is running, so Retry is busy. */
  readonly checking?: boolean;
  readonly onRetry: () => void;
  /** Inside Settings, or embedded in a step of New machine setup. */
  readonly presentation?: 'inline' | 'embedded';
  /** The current step's body. Not rendered while confirming or paused. */
  readonly children: ReactNode;
}

type StepState = 'done' | 'now' | 'todo';

interface ShownStep {
  readonly id: string;
  readonly label: string;
  readonly state: StepState;
  readonly number: number;
}

/**
 * The steps a person is walked through. A last "Done" step is not one of them — it is where the walk
 * ends — so on it every named step reads as done.
 */
export const shownSteps = (flow: StepperFlow): readonly ShownStep[] => {
  const { index } = stepPosition(flow);
  return flow.steps
    .filter(step => step.final !== true)
    .map((step, number) => ({
      id: step.id,
      label: step.label,
      number: number + 1,
      state: number > index ? 'todo' : number < index ? 'done' : 'now',
    }));
};

/** The numbered list above an inline step. */
function StepList({ steps }: { readonly steps: readonly ShownStep[] }) {
  return (
    <ol aria-label="Steps" className="kt-steps kt-steps--row" data-stepper-steps="row">
      {steps.map(step => (
        <li
          key={step.id}
          className="kt-step"
          data-state={step.state}
          data-stepper-step={step.id}
          aria-current={step.state === 'now' ? 'step' : undefined}
        >
          <span className="kt-step__num" aria-hidden="true">
            {step.state === 'done' ? <Check size={14} strokeWidth={3} /> : step.number}
          </span>
          <span className="kt-step__name">
            {step.label}
            <span className="sr-only">
              {step.state === 'done' ? ', done' : step.state === 'now' ? ', current' : ''}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A phone's stepper: one segment per step, and the step names under them. */
function StepSegments({ steps }: { readonly steps: readonly ShownStep[] }) {
  return (
    <div className="flex flex-col gap-2" data-stepper-progress="">
      <div aria-hidden="true" className="kt-stepsegs">
        {steps.map(step => (
          <span key={step.id} data-state={step.state} />
        ))}
      </div>
      <div aria-hidden="true" className="flex justify-between gap-2 text-meta text-muted">
        {steps.map(step => (
          <span
            key={step.id}
            className={cn('min-w-0 truncate', step.state === 'now' && 'font-semibold text-fg')}
            data-stepper-segment-name={step.id}
          >
            {step.label}
            {step.state === 'done' ? ' ✓' : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

export function MachineStepper({
  state,
  onChange,
  machineName,
  online,
  checking = false,
  onRetry,
  presentation = 'inline',
  children,
}: MachineStepperProps) {
  const flow = currentFlow(state);
  const { index, step } = stepPosition(flow);
  const final = step.final === true;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const stepKey = `${state.stack.length}:${flow.kind}:${flow.at}`;
  const steps = shownSteps(flow);
  const current = steps.findIndex(candidate => candidate.state === 'now');
  const position =
    current === -1 ? `${flow.title} · done` : `Step ${current + 1} of ${steps.length} · ${steps[current]?.label}`;

  // A new page, so the reader starts at its title — the prototype moves focus the same way.
  useEffect(() => {
    if (stepKey) titleRef.current?.focus({ preventScroll: true });
  }, [stepKey]);

  const back = (): void => {
    const outcome = backStep(state);
    onChange(outcome.kind === 'left' ? null : outcome.state);
  };

  const content = state.confirming ? (
    <div role="alert" data-stepper-confirm="" className="kt-panel p-panel">
      <p className="m-0 text-row font-semibold text-fg">{flow.leave.question}</p>
      <p className="mb-0 mt-1 text-cell leading-base text-muted">{flow.leave.consequence}</p>
      {flow.saved.length > 0 ? (
        <>
          <p className="mb-0 mt-3 text-cell font-medium text-fg">Saved for reuse:</p>
          <ul className="mb-0 mt-1 list-disc pl-5 text-cell leading-base text-fg" data-stepper-saved="">
            {flow.saved.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="danger" data-stepper-stop="" onClick={() => onChange(stopStepper(state))}>
          {flow.leave.stopLabel}
        </Button>
        <Button type="button" variant="primary" data-stepper-keep="" onClick={() => onChange(keepGoing(state))}>
          Keep going
        </Button>
      </div>
    </div>
  ) : online ? (
    children
  ) : (
    <div role="status" data-stepper-paused="" className="kt-panel p-panel">
      <p className="m-0 flex items-center gap-2 text-row font-semibold text-fg">
        <AccountStatus word="needs_sign_in" label="Offline" />
        <span className="min-w-0">{machineName} is asleep or offline</span>
      </p>
      <p className="mb-0 mt-1 text-cell leading-base text-muted">
        This is paused. Your progress is kept. Wake {machineName} and tap Retry.
      </p>
      <div className="mt-3">
        <Button type="button" variant="primary" data-stepper-retry="" disabled={checking} onClick={onRetry}>
          {checking ? 'Checking…' : 'Retry'}
        </Button>
      </div>
    </div>
  );

  const title = (className: string) => (
    <h3
      id="machine-stepper-title"
      ref={titleRef}
      tabIndex={-1}
      className={cn('m-0 font-display font-semibold tracking-display text-fg outline-none', className)}
    >
      {flow.title}
    </h3>
  );

  if (presentation === 'embedded')
    return (
      <section data-machine-stepper={flow.kind} data-step={flow.at} data-presentation="embedded" className="min-w-0">
        {index === 0 || final || state.confirming ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="kt-btn--flush-start"
            data-stepper-back=""
            onClick={back}
          >
            ‹ Back
          </Button>
        )}
        <div className="min-w-0">{content}</div>
      </section>
    );

  return (
    <section
      data-machine-stepper={flow.kind}
      data-step={flow.at}
      data-presentation="inline"
      aria-labelledby="machine-stepper-title"
      className="min-w-0"
    >
      <div className="flex min-h-control items-center gap-2">
        {final || state.confirming ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="kt-btn--flush-start"
            data-stepper-back=""
            onClick={back}
          >
            ‹ Back
          </Button>
        )}
        <span className="min-w-0 flex-1 truncate text-meta text-muted" data-stepper-position="">
          {position}
        </span>
        {final || state.confirming ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-stepper-cancel=""
            onClick={() => onChange(cancelStepper(state))}
          >
            Cancel
          </Button>
        )}
      </div>
      <div className="mt-2 hidden md:block">
        <StepList steps={steps} />
      </div>
      <div className="mt-2 md:hidden">
        <StepSegments steps={steps} />
      </div>
      {title('mt-4 text-title')}

      <div className="mt-3 min-w-0">{content}</div>
    </section>
  );
}
