/**
 * The stepper frame every Machines flow renders inside (docs/design/account-model.md §4.1).
 *
 * A REAL STEPPER, not a progress bar (the approved usability proposal): every step is NAMED and
 * NUMBERED, a step that is done shows ✓, and the current one is highlighted — so a person can see what
 * is done, what this is, and what is next. On a phone it is segments with the step names under them.
 *
 * Two presentations of the same rules (`stepper-model.ts`):
 *
 * - `inline` — inside Settings (Add a runtime, Clone, Import again…): ‹ Back, "Step n of m", Cancel,
 *   the named steps, the page title, then the step.
 * - `screen` — the full-screen first run of a new machine: the numbered steps down the left on a
 *   desktop (segments + names on a phone), "Finish later" at the top, and ‹ Back with the step's own
 *   actions PINNED to the bottom of the screen, above a phone's home indicator, in the same place on
 *   every step ({@link StepperFoot}).
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
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import { Button } from '../../../shell/primitives.tsx';
import { AccountStatus } from './account-status.tsx';
import { StepperFootContext } from './stepper-foot.tsx';
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
  /** Inside Settings, or the full-screen first run. */
  readonly presentation?: 'inline' | 'screen';
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
    .map((step, position) => ({ step, position }))
    .filter(({ step }) => step.final !== true)
    .map(({ step, position }, number) => ({
      id: step.id,
      label: step.label,
      number: number + 1,
      state: position < index ? 'done' : position === index ? 'now' : 'todo',
    }));
};

/** The numbered list: a column beside a full-screen step, a row above an inline one. */
function StepList({ steps, layout }: { readonly steps: readonly ShownStep[]; readonly layout: 'column' | 'row' }) {
  return (
    <ol aria-label="Steps" className={cn('kt-steps', layout === 'row' && 'kt-steps--row')} data-stepper-steps={layout}>
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
  // The pinned footer's slot. Held in state, so the steps' actions move into it once it exists.
  const [footSlot, setFootSlot] = useState<HTMLElement | null>(null);

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

  // The full-screen first run is a page of its own, so its title is the page's; inline it sits under a
  // section and a machine heading.
  const Heading = presentation === 'screen' ? 'h1' : 'h3';
  const title = (className: string) => (
    <Heading
      id="machine-stepper-title"
      ref={titleRef}
      tabIndex={-1}
      className={cn('m-0 font-display font-semibold tracking-display text-fg outline-none', className)}
    >
      {flow.title}
    </Heading>
  );

  if (presentation === 'screen') {
    // Finish later leaves at once: nothing is imported before the last step, and the progress is kept.
    const finishLater = (
      <Button type="button" variant="ghost" data-stepper-finish-later="" onClick={() => onChange(null)}>
        Finish later
      </Button>
    );
    return (
      <section
        data-machine-stepper={flow.kind}
        data-step={flow.at}
        data-presentation="screen"
        aria-labelledby="machine-stepper-title"
        className="flex h-full min-h-0 min-w-0 flex-col md:grid md:grid-cols-[16rem_minmax(0,1fr)]"
      >
        <aside className="hidden min-h-0 border-r border-border-strong px-5 py-6 md:block" data-stepper-rail="">
          <StepList steps={steps} layout="column" />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex flex-col gap-2.5 border-b border-border-strong px-panel py-3 md:hidden">
            <div className="flex min-h-control items-center justify-between gap-2">
              <span className="kt-label" data-stepper-position="">
                {current === -1 ? 'Done' : `Step ${current + 1} of ${steps.length}`}
              </span>
              {final ? null : finishLater}
            </div>
            <StepSegments steps={steps} />
          </header>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-panel py-5 md:px-8 md:py-7">
            <div className="mx-auto flex w-full max-w-[52rem] min-w-0 flex-col gap-4">
              <div className="hidden min-w-0 items-start justify-between gap-3 md:flex">
                <p className="kt-label m-0 pt-1">{position}</p>
                {final ? null : finishLater}
              </div>
              {title('text-display')}
              <div className="min-w-0">
                <StepperFootContext.Provider value={footSlot}>{content}</StepperFootContext.Provider>
              </div>
            </div>
          </div>

          {/* PINNED, above the home indicator: ‹ Back on the left, the step's own actions on the right. */}
          <footer
            className="border-t border-border-strong bg-surface px-panel pt-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))] md:px-8"
            data-stepper-foot=""
          >
            {/* The same column as the step above it, so ‹ Back lines up with the step's own left edge. */}
            <div className="mx-auto flex w-full max-w-[52rem] min-w-0 items-center justify-between gap-2">
              <div className="shrink-0">
                {final || state.confirming || index === 0 ? null : (
                  <Button type="button" variant="ghost" data-stepper-back="" onClick={back}>
                    ‹ Back
                  </Button>
                )}
              </div>
              <div ref={setFootSlot} className="flex min-w-0 flex-wrap items-center justify-end gap-2" />
            </div>
          </footer>
        </div>
      </section>
    );
  }

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
        <StepList steps={steps} layout="row" />
      </div>
      <div className="mt-2 md:hidden">
        <StepSegments steps={steps} />
      </div>
      {title('mt-4 text-title')}

      <div className="mt-3 min-w-0">{content}</div>
    </section>
  );
}
