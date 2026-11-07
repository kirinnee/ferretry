/**
 * The account model's stepper, as data (docs/design/account-model.md §4.1).
 *
 * Every flow on the Machines surface — first run, Add runtime, Build a profile, Clone —
 * is one stepper. The rules live here once so the six tabs cannot each invent their own Back:
 *
 * - Back goes one step back. From step 1 it asks to confirm leaving (unless the flow says leaving is
 *   harmless).
 * - Cancel always confirms.
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
interface StepperLeaveText {
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
  readonly leave: StepperLeaveText;
  /** Back from step 1 leaves without asking (Install, Clone, Import again from Settings). */
  readonly leaveWithoutConfirm?: boolean;
}

export interface StepperState {
  /** The flow on screen. */
  readonly flow: StepperFlow;
  /** The leave confirmation is showing. */
  readonly confirming: boolean;
}

export type StepperFlowInput = Omit<StepperFlow, 'at'> & { readonly at?: string };

const flowFrom = (input: StepperFlowInput): StepperFlow => {
  const first = input.steps[0];
  if (first === undefined) throw new Error(`stepper ${input.kind} has no steps`);
  const at = input.at ?? first.id;
  if (!input.steps.some(step => step.id === at)) throw new Error(`stepper ${input.kind} has no step ${at}`);
  return { ...input, at };
};

/** Starts a top-level flow. */
export const startStepper = (input: StepperFlowInput): StepperState => ({
  flow: flowFrom(input),
  confirming: false,
});

/** The flow on screen. */
export const currentFlow = (state: StepperState): StepperFlow => state.flow;

/** Where the current flow is: its index (0-based), the step count and the step itself. */
export const stepPosition = (
  flow: StepperFlow,
): { readonly index: number; readonly total: number; readonly step: StepperStep } => {
  const index = flow.steps.findIndex(step => step.id === flow.at);
  return { index, total: flow.steps.length, step: flow.steps[index] as StepperStep };
};

const replaceFlow = (flow: StepperFlow): StepperState => ({ flow, confirming: false });

/** Replaces the current flow's step list, keeping the current step when it is still in it. */
export const withSteps = (state: StepperState, steps: readonly StepperStep[]): StepperState => {
  const flow = currentFlow(state);
  const first = steps[0];
  if (first === undefined) throw new Error(`stepper ${flow.kind} has no steps`);
  const at = steps.some(step => step.id === flow.at) ? flow.at : first.id;
  // A flow that recomputes its steps on every render must not lose an open leave confirmation.
  return { ...replaceFlow({ ...flow, steps, at }), confirming: state.confirming };
};

/** Next. The last step stays put: finishing a flow is the consumer's act, not a step. */
export const stepForward = (state: StepperState): StepperState => {
  const flow = currentFlow(state);
  const { index, total } = stepPosition(flow);
  const next = flow.steps[Math.min(index + 1, total - 1)] as StepperStep;
  return replaceFlow({ ...flow, at: next.id });
};

export type BackOutcome =
  | { readonly kind: 'moved'; readonly state: StepperState }
  /** Back from step 1 of a flow that leaves without asking. */
  | { readonly kind: 'left' };

/** Back, by the rules in the module note. */
export const backStep = (state: StepperState): BackOutcome => {
  const flow = currentFlow(state);
  const { index } = stepPosition(flow);
  if (index > 0)
    return { kind: 'moved', state: replaceFlow({ ...flow, at: (flow.steps[index - 1] as StepperStep).id }) };
  if (flow.leaveWithoutConfirm === true) return { kind: 'left' };
  return { kind: 'moved', state: { ...state, confirming: true } };
};

/** Cancel: always asks first. */
export const cancelStepper = (state: StepperState): StepperState => ({ ...state, confirming: true });

/** "Keep going" on the confirmation. */
export const keepGoing = (state: StepperState): StepperState => ({ ...state, confirming: false });
