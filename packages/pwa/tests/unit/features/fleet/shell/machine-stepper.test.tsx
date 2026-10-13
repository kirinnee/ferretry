import { describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { MachineStepper } from '../../../../../src/features/fleet/shell/machine-stepper.tsx';
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

const text = (container: HTMLElement, selector: string): string | null | undefined =>
  container.querySelector(selector)?.textContent;

describe('MachineStepper', () => {
  it('shows the step, its position, the progress and the title, and focuses the title on each step', async () => {
    const view = await mount(<Host initial={startStepper(flow)} />);
    expect(text(view.container, '[data-stepper-position]')).toBe('Credential · 1 of 3');
    expect(view.container.querySelectorAll('[data-stepper-progress] span')).toHaveLength(3);
    expect(document.activeElement?.id).toBe('machine-stepper-title');
    expect(text(view.container, '#machine-stepper-title')).toBe('Add a runtime');
    await click(view.container, '[data-body]');
    expect(text(view.container, '[data-stepper-position]')).toBe('Profile · 2 of 3');
    expect(view.container.querySelector('[data-step]')?.getAttribute('data-step')).toBe('profile');
    await click(view.container, '[data-stepper-back]');
    expect(text(view.container, '[data-stepper-position]')).toBe('Credential · 1 of 3');
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
    expect(text(view.container, '[data-stepper-position]')).toBe('Done · 3 of 3');
    expect(view.container.querySelector('[data-stepper-back]')).toBeNull();
    expect(view.container.querySelector('[data-stepper-cancel]')).toBeNull();
    await view.unmount();
  });

  it('pauses while the machine is offline: the body is not rendered and the progress is kept', async () => {
    const retries: string[] = [];
    const view = await mount(<Host initial={stepForward(startStepper(flow))} online={false} retries={retries} />);
    expect(view.container.querySelector('[data-body]')).toBeNull();
    expect(text(view.container, '[data-stepper-paused]')).toContain('studio-mac is asleep or offline');
    expect(text(view.container, '[data-stepper-position]')).toBe('Profile · 2 of 3');
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
