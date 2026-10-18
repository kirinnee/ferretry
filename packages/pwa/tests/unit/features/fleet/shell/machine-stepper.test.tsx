import { describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { MachineStepper, shownSteps } from '../../../../../src/features/fleet/shell/machine-stepper.tsx';
import {
  currentFlow,
  cancelStepper,
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

function EmbeddedHost({ initial, online = true }: { readonly initial: StepperState; readonly online?: boolean }) {
  const [state, setState] = useState<StepperState | null>(initial);
  if (state === null) return <p data-left="">left</p>;
  return (
    <MachineStepper
      state={state}
      presentation="embedded"
      onChange={setState}
      machineName="studio-mac"
      online={online}
      onRetry={() => undefined}
    >
      <button type="button" data-body="" onClick={() => setState(stepForward(state))}>
        body of {currentFlow(state).at}
      </button>
    </MachineStepper>
  );
}

describe('MachineStepper embedded in a step', () => {
  it('draws no step list, position or title, and offers Back only after the first page', async () => {
    const view = await mount(<EmbeddedHost initial={startStepper(flow)} />);
    const section = must(view.container.querySelector('[data-machine-stepper]'), 'stepper');
    expect(section.getAttribute('data-presentation')).toBe('embedded');
    expect(view.container.querySelector('[data-stepper-steps]')).toBeNull();
    expect(view.container.querySelector('[data-stepper-progress]')).toBeNull();
    expect(view.container.querySelector('[data-stepper-position]')).toBeNull();
    expect(view.container.querySelector('#machine-stepper-title')).toBeNull();
    expect(view.container.querySelector('[data-stepper-cancel]')).toBeNull();
    // The first page has nowhere to go back to.
    expect(view.container.querySelector('[data-stepper-back]')).toBeNull();
    await click(view.container, '[data-body]');
    expect(section.getAttribute('data-step')).toBe('profile');
    await click(view.container, '[data-stepper-back]');
    expect(section.getAttribute('data-step')).toBe('credential');
    expect(view.container.querySelector('[data-stepper-back]')).toBeNull();
    await view.unmount();
  });

  it('hides Back on the final page and while confirming, and still pauses offline', async () => {
    const done = await mount(<EmbeddedHost initial={stepForward(stepForward(startStepper(flow)))} />);
    expect(done.container.querySelector('[data-stepper-back]')).toBeNull();
    expect(done.container.querySelector('[data-body]')).not.toBeNull();
    await done.unmount();

    const confirming = await mount(<EmbeddedHost initial={cancelStepper(stepForward(startStepper(flow)))} />);
    expect(confirming.container.querySelector('[data-stepper-confirm]')).not.toBeNull();
    expect(confirming.container.querySelector('[data-stepper-back]')).toBeNull();
    expect(confirming.container.querySelector('[data-body]')).toBeNull();
    await confirming.unmount();

    const paused = await mount(<EmbeddedHost initial={stepForward(startStepper(flow))} online={false} />);
    expect(paused.container.querySelector('[data-body]')).toBeNull();
    expect(text(paused.container, '[data-stepper-paused]')).toContain('studio-mac is asleep or offline');
    await paused.unmount();
  });
});

describe('shownSteps', () => {
  it('names every step but the final Done, numbered, and reads them all done once the walk ends', () => {
    expect(shownSteps(currentFlow(startStepper(flow))).map(step => `${step.number} ${step.id}:${step.state}`)).toEqual([
      '1 credential:now',
      '2 profile:todo',
    ]);
    const done = currentFlow(stepForward(stepForward(startStepper(flow))));
    expect(shownSteps(done).map(step => `${step.id}:${step.state}`)).toEqual(['credential:done', 'profile:done']);
  });
});
