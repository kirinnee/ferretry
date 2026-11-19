import { describe, expect, it } from 'bun:test';
import {
  allDone,
  deriveSteps,
  hasOpenStep,
  STEP_IDS,
  type StepperFacts,
  UNKNOWN_FACTS,
  hasKnownOpenStep,
  withFact,
} from '../../../app/features/stepper/stepper-model.ts';

const facts = (over: Partial<StepperFacts>): StepperFacts => ({
  passkey: true,
  name: true,
  login: true,
  runtime: true,
  ferret: true,
  ...over,
});
const states = (input: StepperFacts): string[] => deriveSteps(input).map(step => `${step.id}:${step.state}`);

describe('the first-run stepper derivation', () => {
  it('lists the six steps in the owner’s order', () => {
    expect(deriveSteps(UNKNOWN_FACTS).map(step => step.id)).toEqual([...STEP_IDS]);
    expect(deriveSteps(UNKNOWN_FACTS).map(step => step.title)).toEqual([
      'Pair',
      'Passkey',
      'Name',
      'Login',
      'Runtime',
      'First ferret',
    ]);
  });

  it('a fresh machine: paired, everything else open, the passkey the one to do now', () => {
    const fresh = facts({ passkey: false, name: false, login: false, runtime: false, ferret: false });
    expect(states(fresh)).toEqual([
      'pair:done',
      'passkey:current',
      'name:next',
      'login:next',
      'runtime:next',
      'ferret:next',
    ]);
  });

  it.each([
    ['passkey', facts({ passkey: false })],
    ['name', facts({ name: false })],
    ['login', facts({ login: false })],
    ['runtime', facts({ runtime: false })],
    ['ferret', facts({ ferret: false })],
  ] as const)('only the %s step open: it is the current one and everything else is done', (open, input) => {
    const steps = deriveSteps(input);
    expect(steps.filter(step => step.state === 'current').map(step => step.id)).toEqual([open]);
    expect(steps.filter(step => step.state === 'done')).toHaveLength(5);
  });

  it('the current step is the FIRST open one, even when a later one is done (name named before the passkey)', () => {
    expect(states(facts({ passkey: false, name: true, login: false }))).toEqual([
      'pair:done',
      'passkey:current',
      'name:done',
      'login:next',
      'runtime:done',
      'ferret:done',
    ]);
  });

  it('a fact the machine could not say is unknown, never guessed open or done, and nothing after it is the current step', () => {
    expect(states({ ...UNKNOWN_FACTS, name: false })).toEqual([
      'pair:done',
      'passkey:unknown',
      'name:next',
      'login:unknown',
      'runtime:unknown',
      'ferret:unknown',
    ]);
  });

  it('shows only when a step is known to be open: all done or all unreadable shows nothing to do', () => {
    expect(hasOpenStep(deriveSteps(facts({})))).toBe(false);
    expect(hasOpenStep(deriveSteps(UNKNOWN_FACTS))).toBe(false);
    expect(hasOpenStep(deriveSteps(facts({ ferret: false })))).toBe(true);
    // An open step behind an unread one is not drawn yet: it would be the wrong button once the earlier one answers.
    expect(hasOpenStep(deriveSteps({ ...UNKNOWN_FACTS, login: false }))).toBe(false);
  });

  it('is finished only when every step is known and done', () => {
    expect(allDone(deriveSteps(facts({})))).toBe(true);
    expect(allDone(deriveSteps(facts({ ferret: undefined })))).toBe(false);
    expect(allDone(deriveSteps(facts({ ferret: false })))).toBe(false);
  });

  it('a locked fact is still to do: it takes the current step and says it is locked', () => {
    const steps = deriveSteps(facts({ passkey: 'locked', login: 'locked' }));
    expect(steps.map(step => `${step.id}:${step.state}${step.locked === true ? ':locked' : ''}`)).toEqual([
      'pair:done',
      'passkey:current:locked',
      'name:done',
      'login:next:locked',
      'runtime:done',
      'ferret:done',
    ]);
    expect(hasOpenStep(steps)).toBe(true);
  });

  it('a locked answer never erases what is already known, but fills what is not', () => {
    expect(withFact(facts({ login: true }), 'login', 'locked').login).toBe(true);
    expect(withFact(facts({ login: false }), 'login', 'locked').login).toBe(false);
    expect(withFact(UNKNOWN_FACTS, 'login', 'locked').login).toBe('locked');
    expect(withFact(facts({ login: 'locked' }), 'login', true).login).toBe(true);
  });

  it('only a step the machine said is not done counts as known open (an Unlock wait does not)', () => {
    expect(hasKnownOpenStep(deriveSteps(facts({ passkey: 'locked', login: 'locked' })))).toBe(false);
    expect(hasKnownOpenStep(deriveSteps(facts({ passkey: 'locked', login: false })))).toBe(true);
    expect(hasKnownOpenStep(deriveSteps(facts({})))).toBe(false);
  });
});
