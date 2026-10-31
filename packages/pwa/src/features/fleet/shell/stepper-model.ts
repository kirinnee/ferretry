/**
 * The account model's stepper, as data (docs/design/account-model.md §4.1).
 *
 * Every flow on the Machines surface — first run, Add runtime, Build a profile, Clone —
 * is a stack of steppers: the flow a person started, plus any sub-stepper it opened to create a
 * missing thing in place ("+ Add a new login", "+ Build a new profile"). The rules live here once so
 * the six tabs cannot each invent their own Back:
 *
 * - Back goes one step back. From step 1 of a SUB-stepper it returns to the parent step; from step 1
 *   of a top-level stepper it asks to confirm leaving (unless the flow says leaving is harmless).
 * - Cancel always confirms, and the confirmation lists what was already **saved for reuse**.
 * - Stopping keeps what was saved: a sub-stepper's saved things move to its parent, so the parent's
 *   own confirmation still names them (E17).
 *
 * Pure and immutable: every move returns a new state, so a view can hold it in `useState`.
 */

export interface StepperStep {
  readonly id: string;
  /** "Credential", "Profile", "Name"; shown as "<label> · n of m". */
  readonly label: string;
  /** A last step ("Done"): Back and Cancel are hidden, because there is nothing left to undo. */
  readonly final?: boolean;
}

/** What the leave confirmation says for this flow (the prototype's `confirmHtml`). */
export interface StepperLeaveText {
  /** "Stop adding a runtime?" */
  readonly question: string;
  /** "No runtime is created." */
  readonly consequence: string;
  /** "Stop, add no runtime" */
  readonly stopLabel: string;
}

export interface StepperFlow {
  /** The consumer's own name for the flow, so it can tell which one is on top. */
  readonly kind: string;
  /** The page title: what is being made. */
  readonly title: string;
  readonly steps: readonly StepperStep[];
  /** The id of the current step. */
  readonly at: string;
  /** Things this flow created that are kept even if it is stopped. */
  readonly saved: readonly string[];
  readonly leave: StepperLeaveText;
  /** Back from step 1 leaves without asking (Install, Clone, Import again from Settings). */
  readonly leaveWithoutConfirm?: boolean;
}

export interface StepperState {
  /** Bottom is the flow the person started; top is the one on screen. */
  readonly stack: readonly StepperFlow[];
  /** The leave confirmation is showing for the top flow. */
  readonly confirming: boolean;
}

export type StepperFlowInput = Omit<StepperFlow, 'at' | 'saved'> & { readonly at?: string };

const flowFrom = (input: StepperFlowInput): StepperFlow => {
  const first = input.steps[0];
  if (first === undefined) throw new Error(`stepper ${input.kind} has no steps`);
  const at = input.at ?? first.id;
  if (!input.steps.some(step => step.id === at)) throw new Error(`stepper ${input.kind} has no step ${at}`);
  return { ...input, at, saved: [] };
};

/** Starts a top-level flow. */
export const startStepper = (input: StepperFlowInput): StepperState => ({
  stack: [flowFrom(input)],
  confirming: false,
});

/** The flow on screen. A state always has one: stopping the last flow returns `null` instead. */
export const currentFlow = (state: StepperState): StepperFlow => state.stack[state.stack.length - 1] as StepperFlow;

/** Where the current flow is: its index (0-based), the step count and the step itself. */
export const stepPosition = (
  flow: StepperFlow,
): { readonly index: number; readonly total: number; readonly step: StepperStep } => {
  const index = flow.steps.findIndex(step => step.id === flow.at);
  return { index, total: flow.steps.length, step: flow.steps[index] as StepperStep };
};

const replaceTop = (state: StepperState, flow: StepperFlow): StepperState => ({
  stack: [...state.stack.slice(0, -1), flow],
  confirming: false,
});

/** Moves the current flow to a named step (for flows whose next step depends on an answer). */
export const goToStep = (state: StepperState, stepId: string): StepperState => {
  const flow = currentFlow(state);
  if (!flow.steps.some(step => step.id === stepId)) throw new Error(`stepper ${flow.kind} has no step ${stepId}`);
  return replaceTop(state, { ...flow, at: stepId });
};

/** Replaces the current flow's step list, keeping the current step when it is still in it. */
export const withSteps = (state: StepperState, steps: readonly StepperStep[]): StepperState => {
  const flow = currentFlow(state);
  const first = steps[0];
  if (first === undefined) throw new Error(`stepper ${flow.kind} has no steps`);
  const at = steps.some(step => step.id === flow.at) ? flow.at : first.id;
  // A flow that recomputes its steps on every render must not lose an open leave confirmation.
  return { ...replaceTop(state, { ...flow, steps, at }), confirming: state.confirming };
};

/** Next. The last step stays put: finishing a flow is the consumer's act, not a step. */
export const stepForward = (state: StepperState): StepperState => {
  const flow = currentFlow(state);
  const { index, total } = stepPosition(flow);
  const next = flow.steps[Math.min(index + 1, total - 1)] as StepperStep;
  return replaceTop(state, { ...flow, at: next.id });
};

/** Records something created inside the current flow, kept even if the flow is stopped. */
export const saveForReuse = (state: StepperState, label: string): StepperState => {
  const flow = currentFlow(state);
  return { ...replaceTop(state, { ...flow, saved: [...flow.saved, label] }), confirming: state.confirming };
};

/** Opens a sub-stepper on top of the current flow ("+ Add a new login"). */
export const openSubStepper = (state: StepperState, input: StepperFlowInput): StepperState => ({
  stack: [...state.stack, flowFrom(input)],
  confirming: false,
});

/**
 * Pops the top flow, handing what it saved to the flow below. `null` when it was the only flow — the
 * stepper is over and the view goes back to the tab it came from.
 */
const popTop = (state: StepperState): StepperState | null => {
  if (state.stack.length === 1) return null;
  const top = currentFlow(state);
  const below = state.stack.slice(0, -1);
  const parent = below[below.length - 1] as StepperFlow;
  return { stack: [...below.slice(0, -1), { ...parent, saved: [...parent.saved, ...top.saved] }], confirming: false };
};

/** A sub-stepper finished: back to the parent step, which can now pick what was made. */
export const returnToParent = (state: StepperState): StepperState | null => popTop(state);

export type BackOutcome =
  | { readonly kind: 'moved'; readonly state: StepperState }
  /** Back from step 1 of a top-level flow that leaves without asking. */
  | { readonly kind: 'left' };

/** Back, by the rules in the module note. */
export const backStep = (state: StepperState): BackOutcome => {
  const flow = currentFlow(state);
  const { index } = stepPosition(flow);
  if (index > 0)
    return { kind: 'moved', state: replaceTop(state, { ...flow, at: (flow.steps[index - 1] as StepperStep).id }) };
  const parent = popTop(state);
  if (parent !== null) return { kind: 'moved', state: parent };
  if (flow.leaveWithoutConfirm === true) return { kind: 'left' };
  return { kind: 'moved', state: { ...state, confirming: true } };
};

/** Cancel: always asks first. */
export const cancelStepper = (state: StepperState): StepperState => ({ ...state, confirming: true });

/** "Keep going" on the confirmation. */
export const keepGoing = (state: StepperState): StepperState => ({ ...state, confirming: false });

/**
 * "Stop" on the confirmation: the top flow ends and what it saved is kept (handed down to its
 * parent). `null` when the whole stepper is over.
 */
export const stopStepper = (state: StepperState): StepperState | null => popTop(state);
