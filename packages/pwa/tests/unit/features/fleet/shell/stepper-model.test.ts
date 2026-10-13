import { describe, expect, it } from 'bun:test';
import {
  backStep,
  cancelStepper,
  currentFlow,
  goToStep,
  keepGoing,
  openSubStepper,
  returnToParent,
  type StepperFlowInput,
  type StepperState,
  saveForReuse,
  startStepper,
  stepForward,
  stepPosition,
  stopStepper,
  withSteps,
} from '../../../../../src/features/fleet/shell/stepper-model.ts';

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

const addLogin: StepperFlowInput = {
  kind: 'add-login',
  title: 'Add a login',
  steps: [
    { id: 'tool', label: 'Choose tool' },
    { id: 'sign-in', label: 'Sign in' },
  ],
  leave: { question: 'Stop adding a login?', consequence: 'No login is added.', stopLabel: 'Stop' },
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
    expect(currentFlow(state).saved).toEqual([]);
    expect(currentFlow(startStepper({ ...addRuntime, at: 'name' })).at).toBe('name');
    expect(() => startStepper({ ...addRuntime, steps: [] })).toThrow('has no steps');
    expect(() => startStepper({ ...addRuntime, at: 'nowhere' })).toThrow('has no step nowhere');
  });

  it('moves forward, stops at the last step, and jumps to a named step', () => {
    let state = stepForward(startStepper(addRuntime));
    expect(currentFlow(state).at).toBe('profile');
    state = goToStep(state, 'done');
    expect(currentFlow(stepForward(state)).at).toBe('done');
    expect(() => goToStep(state, 'nowhere')).toThrow('has no step nowhere');
  });

  it('replaces the step list, keeping the current step only when it survives', () => {
    const state = stepForward(startStepper(addRuntime));
    expect(currentFlow(withSteps(state, addRuntime.steps.slice(1))).at).toBe('profile');
    expect(currentFlow(withSteps(state, [{ id: 'other', label: 'Other' }])).at).toBe('other');
    expect(() => withSteps(state, [])).toThrow('has no steps');
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

  it('a sub-stepper returns to its parent step, carrying what it saved', () => {
    const parent = saveForReuse(startStepper(addRuntime), 'Profile Default');
    const child = openSubStepper(parent, addLogin);
    expect(currentFlow(child).kind).toBe('add-login');
    const back = moved(child);
    expect(currentFlow(back).kind).toBe('add-runtime');
    expect(currentFlow(back).at).toBe('credential');

    const signedIn = saveForReuse(stepForward(child), 'Claude Code login you@example.com');
    const returned = returnToParent(signedIn);
    expect(returned === null ? null : currentFlow(returned).saved).toEqual([
      'Profile Default',
      'Claude Code login you@example.com',
    ]);
  });

  it('Cancel always confirms, and Stop keeps what was saved', () => {
    const child = saveForReuse(openSubStepper(startStepper(addRuntime), addLogin), 'Codex login');
    const confirming = cancelStepper(child);
    expect(confirming.confirming).toBe(true);
    // Saving while the confirmation is up leaves it up.
    expect(saveForReuse(confirming, 'x').confirming).toBe(true);
    const stopped = stopStepper(confirming);
    expect(stopped?.confirming).toBe(false);
    expect(stopped === null ? null : currentFlow(stopped)).toMatchObject({
      kind: 'add-runtime',
      saved: ['Codex login'],
    });
    expect(stopStepper(cancelStepper(startStepper(addRuntime)))).toBeNull();
    expect(returnToParent(startStepper(addRuntime))).toBeNull();
  });
});
