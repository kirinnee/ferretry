import { describe, expect, it } from 'bun:test';
import {
  backStep,
  cancelStepper,
  currentFlow,
  keepGoing,
  type StepperFlowInput,
  type StepperState,
  startStepper,
  stepForward,
  stepPosition,
  withSteps,
} from '../../../../../../app/features/fleet/shell/stepper-model.ts';

const addRuntime: StepperFlowInput = {
  kind: 'add-runtime',
  title: 'Add a runtime',
  steps: [
    { id: 'credential', label: 'Credential' },
    { id: 'profile', label: 'Profile' },
    { id: 'name', label: 'Name' },
    { id: 'done', label: 'Done', final: true },
  ],
  leave: {
    question: 'Stop adding a runtime?',
    consequence: 'No runtime is created.',
    stopLabel: 'Stop, add no runtime',
  },
};

const moved = (state: StepperState): StepperState => {
  const outcome = backStep(state);
  if (outcome.kind !== 'moved') throw new Error('expected Back to stay in the stepper');
  return outcome.state;
};

describe('stepper model', () => {
  it('starts on the first step, or a named one, and refuses a flow it cannot show', () => {
    const state = startStepper(addRuntime);
    expect(stepPosition(currentFlow(state))).toEqual({
      index: 0,
      total: 4,
      step: { id: 'credential', label: 'Credential' },
    });
    expect(currentFlow(startStepper({ ...addRuntime, at: 'name' })).at).toBe('name');
    expect(() => startStepper({ ...addRuntime, steps: [] })).toThrow('has no steps');
    expect(() => startStepper({ ...addRuntime, at: 'nowhere' })).toThrow('has no step nowhere');
  });

  it('moves forward and stops at the last step', () => {
    const state = stepForward(startStepper(addRuntime));
    expect(currentFlow(state).at).toBe('profile');
    const last = startStepper({ ...addRuntime, at: 'done' });
    expect(currentFlow(stepForward(last)).at).toBe('done');
  });

  it('replaces the step list, keeping the current step only when it survives', () => {
    const state = stepForward(startStepper(addRuntime));
    expect(currentFlow(withSteps(state, addRuntime.steps.slice(1))).at).toBe('profile');
    expect(currentFlow(withSteps(state, [{ id: 'other', label: 'Other' }])).at).toBe('other');
    expect(() => withSteps(state, [])).toThrow('has no steps');
  });

  it('keeps an open leave confirmation when the steps are recomputed', () => {
    const confirming = cancelStepper(stepForward(startStepper(addRuntime)));
    expect(withSteps(confirming, addRuntime.steps).confirming).toBe(true);
    expect(withSteps(keepGoing(confirming), addRuntime.steps).confirming).toBe(false);
  });

  it('Back goes one step back, and from step 1 of a top-level flow asks to confirm leaving', () => {
    const second = stepForward(startStepper(addRuntime));
    const first = moved(second);
    expect(currentFlow(first).at).toBe('credential');
    const asking = moved(first);
    expect(asking.confirming).toBe(true);
    expect(keepGoing(asking).confirming).toBe(false);
  });

  it('Back from step 1 leaves at once when the flow says leaving is harmless', () => {
    expect(backStep(startStepper({ ...addRuntime, leaveWithoutConfirm: true }))).toEqual({ kind: 'left' });
  });

  it('Cancel always confirms', () => {
    expect(cancelStepper(startStepper(addRuntime)).confirming).toBe(true);
  });
});
