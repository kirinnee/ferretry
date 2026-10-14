import { describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { MachineStepper, shownSteps } from '../../../../../src/features/fleet/shell/machine-stepper.tsx';
import { StepperFoot } from '../../../../../src/features/fleet/shell/stepper-foot.tsx';
import {
  currentFlow,
  openSubStepper,
  type StepperFlowInput,
  type StepperState,
  saveForReuse,
  startStepper,
  stepForward,
} from '../../../../../src/features/fleet/shell/stepper-model.ts';
import { interact, mount, must } from '../../../../support/dom.ts';

const flow: StepperFlowInput = {
  kind: 'add-runtime',
  title: 'Add a runtime',
  steps: [
    { id: 'credential', label: 'Credential' },
    { id: 'profile', label: 'Profile' },
    { id: 'done', label: 'Done', final: true },
  ],
  leave: {
    question: 'Stop adding a runtime?',
    consequence: 'No runtime is created.',
    stopLabel: 'Stop, add no runtime',
  },
};

interface HostOptions {
  readonly initial: StepperState;
  readonly online?: boolean;
  readonly checking?: boolean;
  readonly retries?: string[];
  readonly left?: string[];
}

function Host({ initial, online = true, checking = false, retries = [], left = [] }: HostOptions) {
  const [state, setState] = useState<StepperState | null>(initial);
  if (state === null) return <p data-left="">left</p>;
  return (
    <MachineStepper
      state={state}
      onChange={next => {
        if (next === null) left.push('left');
        setState(next);
      }}
      machineName="studio-mac"
      online={online}
      checking={checking}
      onRetry={() => retries.push('retry')}
    >
      <button type="button" data-body="" onClick={() => setState(stepForward(state))}>
        body of {currentFlow(state).at}
      </button>
    </MachineStepper>
  );
}

const click = async (container: HTMLElement, selector: string): Promise<void> => {
  const element = must(container.querySelector<HTMLElement>(selector), selector);
  await interact(() => element.click());
};

/** Each named step and the state it is drawn in, from the desktop row. */
const states = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-stepper-steps] [data-stepper-step]')].map(
    step => `${step.getAttribute('data-stepper-step')}:${step.getAttribute('data-state')}`,
  );

const text = (container: HTMLElement, selector: string): string | null | undefined =>
  container.querySelector(selector)?.textContent;

describe('MachineStepper', () => {
  it('shows the step, its position, the progress and the title, and focuses the title on each step', async () => {
    const view = await mount(<Host initial={startStepper(flow)} />);
    expect(text(view.container, '[data-stepper-position]')).toBe('Step 1 of 2 · Credential');
    // A NAMED, NUMBERED stepper: the final Done is where the walk ends, not one of its steps.
    expect(view.container.querySelectorAll('[data-stepper-progress] .kt-stepsegs span')).toHaveLength(2);
    expect(states(view.container)).toEqual(['credential:now', 'profile:todo']);
    expect(view.container.querySelector('[aria-current="step"]')?.getAttribute('data-stepper-step')).toBe('credential');
    expect(document.activeElement?.id).toBe('machine-stepper-title');
    expect(text(view.container, '#machine-stepper-title')).toBe('Add a runtime');
    await click(view.container, '[data-body]');
    expect(text(view.container, '[data-stepper-position]')).toBe('Step 2 of 2 · Profile');
    expect(view.container.querySelector('[data-step]')?.getAttribute('data-step')).toBe('profile');
    expect(states(view.container)).toEqual(['credential:done', 'profile:now']);
    // Done shows a check, not its number.
    expect(text(view.container, '[data-stepper-step="credential"] .kt-step__num')).toBe('');
    expect(view.container.querySelector('[data-stepper-step="credential"] .kt-step__num svg')).not.toBeNull();
    expect(text(view.container, '[data-stepper-segment-name="credential"]')).toBe('Credential ✓');
    await click(view.container, '[data-stepper-back]');
    expect(text(view.container, '[data-stepper-position]')).toBe('Step 1 of 2 · Credential');
    await view.unmount();
  });

  it('confirms leaving from step 1, lists what was saved, and Keep going returns to the step', async () => {
    const view = await mount(<Host initial={saveForReuse(startStepper(flow), 'Profile Default')} />);
    await click(view.container, '[data-stepper-back]');
    expect(text(view.container, '[data-stepper-confirm] p')).toBe('Stop adding a runtime?');
    expect(text(view.container, '[data-stepper-saved]')).toBe('Profile Default');
    expect(view.container.querySelector('[data-body]')).toBeNull();
    expect(view.container.querySelector('[data-stepper-back]')).toBeNull();
    expect(view.container.querySelector('[data-stepper-cancel]')).toBeNull();
    await click(view.container, '[data-stepper-keep]');
    expect(view.container.querySelector('[data-body]')).not.toBeNull();
    await view.unmount();
  });

  it('Cancel then Stop leaves the stepper; nothing saved means no saved list', async () => {
    const left: string[] = [];
    const view = await mount(<Host initial={startStepper(flow)} left={left} />);
    await click(view.container, '[data-stepper-cancel]');
    expect(view.container.querySelector('[data-stepper-saved]')).toBeNull();
    expect(text(view.container, '[data-stepper-stop]')).toBe('Stop, add no runtime');
    await click(view.container, '[data-stepper-stop]');
    expect(left).toEqual(['left']);
    expect(view.container.querySelector('[data-left]')).not.toBeNull();
    await view.unmount();
  });

  it('Back from a harmless flow leaves without asking, and a sub-stepper returns to its parent', async () => {
    const left: string[] = [];
    const harmless = await mount(<Host initial={startStepper({ ...flow, leaveWithoutConfirm: true })} left={left} />);
    await click(harmless.container, '[data-stepper-back]');
    expect(left).toEqual(['left']);
    await harmless.unmount();

    const nested = openSubStepper(startStepper(flow), { ...flow, kind: 'add-login', title: 'Add a login' });
    const view = await mount(<Host initial={nested} />);
    expect(view.container.querySelector('[data-machine-stepper]')?.getAttribute('data-machine-stepper')).toBe(
      'add-login',
    );
    await click(view.container, '[data-stepper-back]');
    expect(view.container.querySelector('[data-machine-stepper]')?.getAttribute('data-machine-stepper')).toBe(
      'add-runtime',
    );
    await view.unmount();
  });

  it('a final step hides Back and Cancel', async () => {
    const view = await mount(<Host initial={stepForward(stepForward(startStepper(flow)))} />);
    expect(text(view.container, '[data-stepper-position]')).toBe('Add a runtime · done');
    expect(states(view.container)).toEqual(['credential:done', 'profile:done']);
    expect(view.container.querySelector('[data-stepper-back]')).toBeNull();
    expect(view.container.querySelector('[data-stepper-cancel]')).toBeNull();
    await view.unmount();
  });

  it('pauses while the machine is offline: the body is not rendered and the progress is kept', async () => {
    const retries: string[] = [];
    const view = await mount(<Host initial={stepForward(startStepper(flow))} online={false} retries={retries} />);
    expect(view.container.querySelector('[data-body]')).toBeNull();
    expect(text(view.container, '[data-stepper-paused]')).toContain('studio-mac is asleep or offline');
    expect(text(view.container, '[data-stepper-position]')).toBe('Step 2 of 2 · Profile');
    await click(view.container, '[data-stepper-retry]');
    expect(retries).toEqual(['retry']);
    await view.unmount();

    const busy = await mount(<Host initial={startStepper(flow)} online={false} checking />);
    const retry = must(busy.container.querySelector<HTMLButtonElement>('[data-stepper-retry]'), 'retry');
    expect(retry.disabled).toBe(true);
    expect(retry.textContent).toBe('Checking…');
    await busy.unmount();
  });
});

function ScreenHost({ initial, left = [] }: { readonly initial: StepperState; readonly left?: string[] }) {
  const [state, setState] = useState<StepperState | null>(initial);
  if (state === null) return <p data-left="">left</p>;
  return (
    <MachineStepper
      state={state}
      presentation="screen"
      onChange={next => {
        if (next === null) left.push('left');
        setState(next);
      }}
      machineName="studio-mac"
      online
      onRetry={() => undefined}
    >
      <p data-body="">body of {currentFlow(state).at}</p>
      <StepperFoot>
        <button type="button" data-next="" onClick={() => setState(stepForward(state))}>
          Next
        </button>
      </StepperFoot>
    </MachineStepper>
  );
}

describe('MachineStepper as a full screen', () => {
  it('draws the numbered rail and the phone segments, pins the step actions to the footer, and Finish later leaves', async () => {
    const left: string[] = [];
    const view = await mount(<ScreenHost initial={startStepper(flow)} left={left} />);
    const section = must(view.container.querySelector('[data-machine-stepper]'), 'stepper');
    expect(section.getAttribute('data-presentation')).toBe('screen');
    expect(view.container.querySelector('[data-stepper-rail] [data-stepper-steps="column"]')).not.toBeNull();
    expect(view.container.querySelector('[data-stepper-progress]')).not.toBeNull();
    expect(text(view.container, '[data-stepper-position]')).toBe('Step 1 of 2');
    expect(view.container.querySelector('h1#machine-stepper-title')?.textContent).toBe('Add a runtime');
    // The step's own action lands in the pinned footer, still inside the stepper's section.
    const foot = must(view.container.querySelector('[data-stepper-foot]'), 'footer');
    expect(foot.querySelector('[data-next]')).not.toBeNull();
    expect(section.contains(foot)).toBe(true);
    // Step 1 has nowhere to go back to.
    expect(foot.querySelector('[data-stepper-back]')).toBeNull();
    await click(view.container, '[data-next]');
    expect(text(view.container, '[data-stepper-position]')).toBe('Step 2 of 2');
    await click(view.container, '[data-stepper-back]');
    expect(text(view.container, '[data-stepper-position]')).toBe('Step 1 of 2');
    // Finish later leaves at once: nothing was sent, and the progress is the caller's to keep.
    await click(view.container, '[data-stepper-finish-later]');
    expect(left).toEqual(['left']);
    await view.unmount();
  });

  it('on the final step offers neither Back nor Finish later', async () => {
    const view = await mount(<ScreenHost initial={stepForward(stepForward(startStepper(flow)))} />);
    expect(text(view.container, '[data-stepper-position]')).toBe('Done');
    expect(view.container.querySelector('[data-stepper-back]')).toBeNull();
    expect(view.container.querySelector('[data-stepper-finish-later]')).toBeNull();
    await view.unmount();
  });
});

describe('StepperFoot', () => {
  it('renders a step’s actions under it when no stepper offers a footer', async () => {
    const view = await mount(
      <StepperFoot>
        <button type="button">Skip</button>
      </StepperFoot>,
    );
    expect(view.container.querySelector('div > button')?.textContent).toBe('Skip');
    await view.unmount();
  });
});

describe('shownSteps', () => {
  it('names a step that will apply later as still to come, and drops it once the walk is done', () => {
    const later = [{ id: 'name', label: 'Name' }];
    const start = currentFlow(startStepper(flow));
    expect(shownSteps(start, later).map(step => `${step.number} ${step.id}:${step.state}`)).toEqual([
      '1 credential:now',
      '2 profile:todo',
      '3 name:todo',
    ]);
    // A step that is already in the flow is not drawn twice.
    expect(shownSteps(start, [{ id: 'profile', label: 'Profile' }])).toHaveLength(2);
    const done = currentFlow(stepForward(stepForward(startStepper(flow))));
    expect(shownSteps(done, later).map(step => `${step.id}:${step.state}`)).toEqual([
      'credential:done',
      'profile:done',
    ]);
  });
});
