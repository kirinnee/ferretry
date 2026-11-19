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
  claude: true,
  codex: true,
  project: true,
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
      'Claude Code',
      'Codex',
      'Project',
    ]);
  });

  it('a fresh machine: paired, everything else open, the passkey the one to do now', () => {
    const fresh = facts({ passkey: false, name: false, claude: false, codex: false, project: false });
    expect(states(fresh)).toEqual([
      'pair:done',
      'passkey:current',
      'name:next',
      'claude:next',
      'codex:next',
      'project:next',
    ]);
  });

  it.each([
    ['passkey', facts({ passkey: false })],
    ['name', facts({ name: false })],
    ['claude', facts({ claude: false })],
    ['codex', facts({ codex: false })],
    ['project', facts({ project: false })],
  ] as const)('only the %s step open: it is the current one and everything else is done', (open, input) => {
    const steps = deriveSteps(input);
    expect(steps.filter(step => step.state === 'current').map(step => step.id)).toEqual([open]);
    expect(steps.filter(step => step.state === 'done')).toHaveLength(5);
  });

  it('the current step is the FIRST open one, even when a later one is done (name named before the passkey)', () => {
    expect(states(facts({ passkey: false, name: true, claude: false }))).toEqual([
      'pair:done',
      'passkey:current',
      'name:done',
      'claude:next',
      'codex:done',
      'project:done',
    ]);
  });

  it('a fact the machine could not say is unknown, never guessed open or done, and nothing after it is the current step', () => {
    expect(states({ ...UNKNOWN_FACTS, name: false })).toEqual([
      'pair:done',
      'passkey:unknown',
      'name:next',
      'claude:unknown',
      'codex:unknown',
      'project:unknown',
    ]);
  });

  it('shows only when a step is known to be open: all done or all unreadable shows nothing to do', () => {
    expect(hasOpenStep(deriveSteps(facts({})))).toBe(false);
    expect(hasOpenStep(deriveSteps(UNKNOWN_FACTS))).toBe(false);
    expect(hasOpenStep(deriveSteps(facts({ project: false })))).toBe(true);
    // An open step behind an unread one is not drawn yet: it would be the wrong button once the earlier one answers.
    expect(hasOpenStep(deriveSteps({ ...UNKNOWN_FACTS, claude: false }))).toBe(false);
  });

  it('is finished only when every step is known and done', () => {
    expect(allDone(deriveSteps(facts({})))).toBe(true);
    expect(allDone(deriveSteps(facts({ project: undefined })))).toBe(false);
    expect(allDone(deriveSteps(facts({ project: false })))).toBe(false);
  });

  it('a locked fact is still to do: it takes the current step and says it is locked', () => {
    const steps = deriveSteps(facts({ passkey: 'locked', claude: 'locked' }));
    expect(steps.map(step => `${step.id}:${step.state}${step.locked === true ? ':locked' : ''}`)).toEqual([
      'pair:done',
      'passkey:current:locked',
      'name:done',
      'claude:next:locked',
      'codex:done',
      'project:done',
    ]);
    expect(hasOpenStep(steps)).toBe(true);
  });

  it('a locked answer never erases what is already known, but fills what is not', () => {
    expect(withFact(facts({ claude: true }), 'claude', 'locked').claude).toBe(true);
    expect(withFact(facts({ claude: false }), 'claude', 'locked').claude).toBe(false);
    expect(withFact(UNKNOWN_FACTS, 'claude', 'locked').claude).toBe('locked');
    expect(withFact(facts({ claude: 'locked' }), 'claude', true).claude).toBe(true);
  });

  it('only a step the machine said is not done counts as known open (an Unlock wait does not)', () => {
    expect(hasKnownOpenStep(deriveSteps(facts({ passkey: 'locked', claude: 'locked' })))).toBe(false);
    expect(hasKnownOpenStep(deriveSteps(facts({ passkey: 'locked', claude: false })))).toBe(true);
    expect(hasKnownOpenStep(deriveSteps(facts({})))).toBe(false);
  });
});
