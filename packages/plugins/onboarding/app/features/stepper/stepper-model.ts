/**
 * THE FIRST-RUN STEPPER, AS DATA (pure): the six things a new machine needs before it is a working fleet, and where each
 * one stands, derived from facts the daemon itself holds. Nothing here is a progress record of ours: a step is done
 * because the machine says so (a passkey exists, the machine has a name, a login, a runtime, a ferret), so the stepper
 * cannot disagree with the machine and resuming after a reload needs no bookkeeping.
 *
 * A fact is `true` (it holds), `false` (it does not), `'locked'` (the machine refused the read for want of its unlock: the
 * step is still to do, and its button is Unlock) or `undefined` (the machine could not say: offline, unreadable). An
 * unreadable fact is never guessed: that step is `unknown`, draws no button, and never makes the stepper appear.
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
export type StepperFact = boolean | 'locked' | undefined;
export type StepperFacts = { readonly [Id in Exclude<StepperStepId, 'pair'>]: StepperFact };

/** `done` holds · `current` is the one to do now · `next` is open, after the current one · `unknown` could not be read. */
export type StepperState = 'done' | 'current' | 'next' | 'unknown';

export interface StepperStep {
  readonly id: StepperStepId;
  readonly title: string;
  readonly state: StepperState;
  /** The machine wants its unlock before it can say whether this step holds; the step's button is Unlock. */
  readonly locked?: true;
}

export const UNKNOWN_FACTS: StepperFacts = Object.freeze({
  passkey: undefined,
  name: undefined,
  login: undefined,
  runtime: undefined,
  ferret: undefined,
});

/**
 * The six steps in order, each with its state. Exactly one step is `current` while an open step is known. The current
 * step is never chosen past a step that could not be read: a later step picked first would jump back to the earlier one
 * when it answers (a button that moves), so while an EARLIER step is unknown no step is current and nothing is drawn.
 */
export const deriveSteps = (facts: StepperFacts): readonly StepperStep[] => {
  let currentTaken = false;
  return STEP_IDS.map((id): StepperStep => {
    const held = id === 'pair' ? true : facts[id];
    const title = STEP_TITLES[id];
    if (held === true) return { id, title, state: 'done' };
    if (held === undefined) {
      currentTaken = true; // nothing after an unknown step may be the one to do yet
      return { id, title, state: 'unknown' };
    }
    const lock = held === 'locked' ? ({ locked: true } as const) : {};
    if (currentTaken) return { id, title, state: 'next', ...lock };
    currentTaken = true;
    return { id, title, state: 'current', ...lock };
  });
};

/** Whether a step is known to be the one to do: the only thing that shows the stepper. All done, or an unread step before the open one, shows nothing. */
export const hasOpenStep = (steps: readonly StepperStep[]): boolean => steps.some(step => step.state === 'current');

/**
 * Whether a step the machine SAID is not done is open (a `false` fact), as opposed to one that is only waiting for an
 * unlock: only the former means the person was ever shown work to do, so only it earns a "set up" card later.
 */
export const hasKnownOpenStep = (steps: readonly StepperStep[]): boolean =>
  steps.some(step => (step.state === 'current' || step.state === 'next') && step.locked !== true);

/** Every step is known and done: the moment the stepper may be dismissed (or goes away by itself). */
export const allDone = (steps: readonly StepperStep[]): boolean => steps.every(step => step.state === 'done');

/**
 * One fact's new answer folded into what is known. A `'locked'` answer never erases something already known (what this
 * device remembered, or read before the machine locked): a machine seen set up stays set up while it waits for its unlock,
 * so a configured machine that locks shows nothing here (the shell's own bar offers the unlock).
 */
export const withFact = (known: StepperFacts, key: keyof StepperFacts, fact: StepperFact): StepperFacts => {
  const before = known[key];
  if (fact === 'locked' && typeof before === 'boolean') return known;
  return before === fact ? known : { ...known, [key]: fact };
};
