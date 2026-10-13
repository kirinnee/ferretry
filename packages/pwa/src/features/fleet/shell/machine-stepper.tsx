/**
 * The stepper frame every Machines flow renders inside (docs/design/account-model.md §4.1).
 *
 * It draws what the rules in `stepper-model.ts` decide — ‹ Back, "<step> · n of m", Cancel, the
 * progress bar and the page title — and the two states that replace a step's body:
 *
 * - **Leave confirmation.** Cancel (or Back from step 1) asks first, says what will not be created and
 *   lists what was already saved for reuse, which is kept.
 * - **Paused.** A machine that is asleep or offline pauses the flow (O5): the progress stays exactly
 *   where it was, but the step's body is not rendered, so nothing it would send can be queued. A write
 *   needs the machine awake; Retry asks the caller to check again.
 *
 * The step's own body is the caller's (`children`); this frame never knows what a step asks.
 */

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
  /** The current step's body. Not rendered while confirming or paused. */
  readonly children: ReactNode;
}

export function MachineStepper({
  state,
  onChange,
  machineName,
  online,
  checking = false,
  onRetry,
  children,
}: MachineStepperProps) {
  const flow = currentFlow(state);
  const { index, total, step } = stepPosition(flow);
  const final = step.final === true;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const stepKey = `${state.stack.length}:${flow.kind}:${flow.at}`;

  // A new page, so the reader starts at its title — the prototype moves focus the same way.
  useEffect(() => {
    if (stepKey) titleRef.current?.focus({ preventScroll: true });
  }, [stepKey]);

  const back = (): void => {
    const outcome = backStep(state);
    onChange(outcome.kind === 'left' ? null : outcome.state);
  };

  return (
    <section
      data-machine-stepper={flow.kind}
      data-step={flow.at}
      aria-labelledby="machine-stepper-title"
      className="min-w-0"
    >
      <div className="flex min-h-control items-center gap-2">
        {final || state.confirming ? null : (
          <Button type="button" variant="ghost" size="sm" data-stepper-back="" onClick={back}>
            ‹ Back
          </Button>
        )}
        <span className="min-w-0 flex-1 truncate text-meta text-muted" data-stepper-position="">
          {step.label} · {index + 1} of {total}
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
      <div aria-hidden="true" className="mt-1 flex gap-1" data-stepper-progress="">
        {flow.steps.map((candidate, position) => (
          <span
            key={candidate.id}
            className={cn(
              'h-1 min-w-0 flex-1 rounded-full',
              position < index ? 'bg-accent' : position === index ? 'bg-accent opacity-60' : 'bg-surface-2',
            )}
          />
        ))}
      </div>
      <h3
        id="machine-stepper-title"
        ref={titleRef}
        tabIndex={-1}
        className="mb-0 mt-3 font-display text-title font-semibold tracking-display text-fg outline-none"
      >
        {flow.title}
      </h3>

      <div className="mt-3 min-w-0">
        {state.confirming ? (
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
              <Button
                type="button"
                variant="danger"
                size="sm"
                data-stepper-stop=""
                onClick={() => onChange(stopStepper(state))}
              >
                {flow.leave.stopLabel}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                data-stepper-keep=""
                onClick={() => onChange(keepGoing(state))}
              >
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
              <Button
                type="button"
                variant="primary"
                size="sm"
                data-stepper-retry=""
                disabled={checking}
                onClick={onRetry}
              >
                {checking ? 'Checking…' : 'Retry'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
