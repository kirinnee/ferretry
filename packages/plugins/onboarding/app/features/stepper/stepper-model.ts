/**
 * THE FIRST-RUN STEPPER, AS DATA (pure): the six things a new machine needs before it is a working fleet, and where each
 * one stands, derived from facts the daemon itself holds. Nothing here is a progress record of ours: a step is done
 * because the machine says so (a passkey exists, the machine has a name, a login, a runtime, a ferret), so the stepper
 * cannot disagree with the machine and resuming after a reload needs no bookkeeping.
 *
 * A fact is `true` (it holds), `false` (it does not) or `undefined` (the machine could not say: locked, offline, refused).
 * An unreadable fact is never guessed: that step is `unknown`, draws no button, and never makes the stepper appear.
 */

export const STEP_IDS = ['pair', 'passkey', 'name', 'login', 'runtime', 'ferret'] as const;
type StepperStepId = (typeof STEP_IDS)[number];

const STEP_TITLES: Readonly<Record<StepperStepId, string>> = {
  pair: 'Pair',
  passkey: 'Passkey',
  name: 'Name',
  login: 'Login',
  runtime: 'Runtime',
  ferret: 'First ferret',
};

/** What each fact says; `pair` is not here: a machine this page is drawn for is paired by definition. */
export type StepperFacts = { readonly [Id in Exclude<StepperStepId, 'pair'>]: boolean | undefined };

/** `done` holds · `current` is the one to do now · `next` is open, after the current one · `unknown` could not be read. */
export type StepperState = 'done' | 'current' | 'next' | 'unknown';

export interface StepperStep {
  readonly id: StepperStepId;
  readonly title: string;
  readonly state: StepperState;
}

export const UNKNOWN_FACTS: StepperFacts = Object.freeze({
  passkey: undefined,
  name: undefined,
  login: undefined,
  runtime: undefined,
  ferret: undefined,
});

/** The six steps in order, each with its state. Exactly one step is `current` while any step is open. */
export const deriveSteps = (facts: StepperFacts): readonly StepperStep[] => {
  let currentTaken = false;
  return STEP_IDS.map((id): StepperStep => {
    const held = id === 'pair' ? true : facts[id];
    const title = STEP_TITLES[id];
    if (held === true) return { id, title, state: 'done' };
    if (held === undefined) return { id, title, state: 'unknown' };
    if (currentTaken) return { id, title, state: 'next' };
    currentTaken = true;
    return { id, title, state: 'current' };
  });
};

/** Whether any step is known to be open: the only thing that shows the stepper. All done, or all unreadable, shows nothing. */
export const hasOpenStep = (steps: readonly StepperStep[]): boolean =>
  steps.some(step => step.state === 'current' || step.state === 'next');

/** Every step is known and done: the moment the stepper may be dismissed (or goes away by itself). */
export const allDone = (steps: readonly StepperStep[]): boolean => steps.every(step => step.state === 'done');
