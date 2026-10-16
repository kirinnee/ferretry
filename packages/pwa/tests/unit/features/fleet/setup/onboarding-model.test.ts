import { describe, expect, it } from 'bun:test';
import {
  backOnboardingStep,
  chooseOnboardingStart,
  continueOnboarding,
  goToOnboardingStep,
  isMachineSetupStepId,
  type MachineSetupProgress,
  type MachineSetupTaskId,
  markOnboardingStep,
  ONBOARDING_START,
  ONBOARDING_STEPS,
  ONBOARDING_TASKS,
  onboardingDoneRows,
  onboardingLaterHref,
  onboardingRailMarker,
  onboardingSetCount,
  onboardingSkippedSteps,
  onboardingStepLabel,
  skipOnboardingStep,
  wardenStartingDraft,
} from '../../../../../src/features/fleet/setup/onboarding-model.ts';
import { daemonId } from '../../../../../src/lib/daemon-connection.ts';
import { wardenConfig } from '../../../../support/warden.ts';

const studio = daemonId('studio');

const progress = (overrides: Partial<MachineSetupProgress> = {}): MachineSetupProgress => ({
  ...ONBOARDING_START,
  ...overrides,
});

describe('onboarding steps', () => {
  it('lists the nine steps in rail order, ending on Done', () => {
    expect(ONBOARDING_STEPS.map(step => step.id)).toEqual([
      'pair',
      'start',
      'logins',
      'speedups',
      'voice',
      'warden',
      'learning',
      'controls',
      'done',
    ]);
  });

  it('keeps Done out of the steps that can be set or skipped', () => {
    expect(ONBOARDING_TASKS).toHaveLength(8);
    expect(ONBOARDING_TASKS).not.toContain('done' as MachineSetupTaskId);
  });

  it('recognises a step id and rejects anything else', () => {
    expect(isMachineSetupStepId('warden')).toBe(true);
    expect(isMachineSetupStepId('done')).toBe(true);
    expect(isMachineSetupStepId('billing')).toBe(false);
  });

  it('names a step by its label', () => {
    expect(onboardingStepLabel('speedups')).toBe('Speed-ups');
  });

  it('begins with pairing already set, on the Start from step, fresh', () => {
    expect(ONBOARDING_START).toEqual({ at: 'start', states: { pair: 'done' }, start: 'fresh' });
  });
});

describe('moving through the rail', () => {
  it('opens any step from the rail without marking it', () => {
    const next = goToOnboardingStep(progress(), 'warden');
    expect(next.at).toBe('warden');
    expect(next.states).toEqual({ pair: 'done' });
  });

  it('marks a step set and opens the next when Continue is pressed', () => {
    const next = continueOnboarding(progress({ at: 'logins' }));
    expect(next.at).toBe('speedups');
    expect(next.states).toEqual({ pair: 'done', logins: 'done' });
  });

  it('turns a skipped step into a set one when Continue is pressed on it', () => {
    const next = continueOnboarding(progress({ at: 'logins', states: { logins: 'skipped' } }));
    expect(next.states.logins).toBe('done');
  });

  it('stays on Done, marking nothing, when Continue is pressed there', () => {
    const start = progress({ at: 'done', states: { pair: 'done' } });
    const next = continueOnboarding(start);
    expect(next.at).toBe('done');
    expect(next.states).toEqual({ pair: 'done' });
  });

  it('marks a step skipped and opens the next when Skip is pressed', () => {
    const next = skipOnboardingStep(progress({ at: 'voice' }));
    expect(next.at).toBe('warden');
    expect(next.states).toEqual({ pair: 'done', voice: 'skipped' });
  });

  it('never unsets a step that is already set when Skip is pressed on it', () => {
    const next = skipOnboardingStep(progress({ at: 'voice', states: { voice: 'done' } }));
    expect(next.at).toBe('warden');
    expect(next.states).toEqual({ voice: 'done' });
  });

  it('stays on Done, marking nothing, when Skip is pressed there', () => {
    const next = skipOnboardingStep(progress({ at: 'done', states: { pair: 'done' } }));
    expect(next.at).toBe('done');
    expect(next.states).toEqual({ pair: 'done' });
  });

  it('goes back one step without marking anything', () => {
    const next = backOnboardingStep(progress({ at: 'logins' }));
    expect(next.at).toBe('start');
    expect(next.states).toEqual({ pair: 'done' });
  });

  it('stays on the first step when Back is pressed there', () => {
    expect(backOnboardingStep(progress({ at: 'pair' })).at).toBe('pair');
  });

  it('marks a step set without moving, when a surface saved on its own', () => {
    const next = markOnboardingStep(progress({ at: 'speedups' }), 'logins');
    expect(next.at).toBe('speedups');
    expect(next.states).toEqual({ pair: 'done', logins: 'done' });
  });

  it('records the chosen start without touching the steps', () => {
    const next = chooseOnboardingStart(progress(), 'clone');
    expect(next).toEqual({ at: 'start', states: { pair: 'done' }, start: 'clone' });
  });

  it('never changes the progress it was given', () => {
    const before = progress({ at: 'logins' });
    continueOnboarding(before);
    skipOnboardingStep(before);
    markOnboardingStep(before, 'voice');
    expect(before).toEqual({ at: 'logins', states: { pair: 'done' }, start: 'fresh' });
  });
});

describe('the rail’s words', () => {
  it('counts the steps that are set out of the eight that can be', () => {
    expect(onboardingSetCount(progress({ states: {} }))).toBe('0 of 8 set');
    expect(onboardingSetCount(progress({ states: { pair: 'done', logins: 'done', voice: 'skipped' } }))).toBe(
      '2 of 8 set',
    );
  });

  it('marks a set step ✓, a skipped step –, and any other step with its number', () => {
    const states = { pair: 'done', logins: 'skipped' } as const;
    const kept = progress({ states });
    expect(onboardingRailMarker(kept, 'pair')).toBe('✓');
    expect(onboardingRailMarker(kept, 'logins')).toBe('–');
    expect(onboardingRailMarker(kept, 'speedups')).toBe('4');
    expect(onboardingRailMarker(kept, 'done')).toBe('9');
  });
});

describe('set up later', () => {
  const href = (id: MachineSetupTaskId) => onboardingLaterHref(studio, 'Work Mac', id);

  it('links each Machine-tab panel to its own panel', () => {
    expect(href('pair')).toBe('/d/studio/settings#machines/Work%20Mac/machine/devices');
    expect(href('start')).toBe('/d/studio/settings#machines/Work%20Mac/machine/clone');
    expect(href('speedups')).toBe('/d/studio/settings#machines/Work%20Mac/machine/speedups');
    expect(href('warden')).toBe('/d/studio/settings#machines/Work%20Mac/machine/warden');
    expect(href('learning')).toBe('/d/studio/settings#machines/Work%20Mac/machine/learning');
  });

  it('links Logins to the machine’s Credentials tab', () => {
    expect(href('logins')).toBe('/d/studio/settings#machines/Work%20Mac/credentials');
  });

  it('links Agent controls to the machine tab itself', () => {
    expect(href('controls')).toBe('/d/studio/settings#machines/Work%20Mac/machine');
  });

  it('links Voice to this device’s Dictation setting, not to the machine', () => {
    expect(href('voice')).toBe('/d/studio/settings#dictation');
  });
});

describe('what Done says', () => {
  const rows = (
    kept: MachineSetupProgress,
    facts: Parameters<typeof onboardingDoneRows>[1] = {},
  ): ReturnType<typeof onboardingDoneRows> => onboardingDoneRows(kept, facts, studio, 'Work Mac');
  const row = (list: ReturnType<typeof onboardingDoneRows>, id: MachineSetupTaskId) => {
    const found = list.find(candidate => candidate.id === id);
    if (found === undefined) throw new Error(`no row for ${id}`);
    return found;
  };

  it('has one row per step but Done, in rail order, labelled', () => {
    const list = rows(progress());
    expect(list.map(item => item.id)).toEqual([...ONBOARDING_TASKS]);
    expect(row(list, 'speedups').label).toBe('Speed-ups');
  });

  it('says set, skipped or not visited, and links only the steps that are not set', () => {
    const list = rows(progress({ states: { pair: 'done', logins: 'done', voice: 'skipped' } }));
    expect(row(list, 'logins').state).toBe('set');
    expect(row(list, 'logins').later).toBeUndefined();
    expect(row(list, 'voice').state).toBe('skipped');
    expect(row(list, 'voice').later).toBe('/d/studio/settings#dictation');
    expect(row(list, 'warden').state).toBe('not visited');
    expect(row(list, 'warden').later).toBe('/d/studio/settings#machines/Work%20Mac/machine/warden');
  });

  it('never offers a later link for pairing, even when it is not set', () => {
    const list = rows(progress({ states: {} }));
    expect(row(list, 'pair').state).toBe('not visited');
    expect(row(list, 'pair').later).toBeUndefined();
  });

  it('adds no detail to a step with nothing to add', () => {
    const list = rows(progress(), { clonedFrom: 'work-mac', keys: { Jev: true }, warden: 'on', passiveDefault: true });
    expect(row(list, 'logins').detail).toBeUndefined();
    expect(row(list, 'voice').detail).toBeUndefined();
    expect(row(list, 'controls').detail).toBeUndefined();
  });

  describe('start', () => {
    it('says nothing until the Start from step is set', () => {
      const list = rows(progress({ states: {}, start: 'clone' }), { clonedFrom: 'work-mac' });
      expect(row(list, 'start').detail).toBeUndefined();
    });

    it('says fresh setup for a fresh start', () => {
      const list = rows(progress({ states: { start: 'done' }, start: 'fresh' }));
      expect(row(list, 'start').detail).toBe('fresh setup');
    });

    it('names the machine a clone came from', () => {
      const list = rows(progress({ states: { start: 'done' }, start: 'clone' }), { clonedFrom: 'work-mac' });
      expect(row(list, 'start').detail).toBe('cloned from work-mac');
    });

    it('still says it was a clone when the source is not known', () => {
      const list = rows(progress({ states: { start: 'done' }, start: 'clone' }));
      expect(row(list, 'start').detail).toBe('clone from another machine');
    });
  });

  describe('speed-ups', () => {
    it('lists every key by provider, marking the ones that are set', () => {
      const list = rows(progress(), { keys: { Jev: true, Groq: false } });
      expect(row(list, 'speedups').detail).toBe('Jev ✓ · Groq not set');
    });

    it('says nothing when the keys are not known', () => {
      expect(row(rows(progress()), 'speedups').detail).toBeUndefined();
    });
  });

  it('repeats the Warden’s own summary', () => {
    expect(row(rows(progress(), { warden: 'Jev guard on' }), 'warden').detail).toBe('Jev guard on');
    expect(row(rows(progress()), 'warden').detail).toBeUndefined();
  });

  describe('learning', () => {
    it('says passive is on for new ferrets when it is', () => {
      expect(row(rows(progress(), { passiveDefault: true }), 'learning').detail).toBe('passive on for new ferrets');
    });

    it('says passive is off when it is', () => {
      expect(row(rows(progress(), { passiveDefault: false }), 'learning').detail).toBe('passive off');
    });

    it('says nothing when the default is not known', () => {
      expect(row(rows(progress()), 'learning').detail).toBeUndefined();
    });
  });
});

describe('the steps still to do', () => {
  it('lists every step that is not set, in rail order, skipped or never visited', () => {
    const kept = progress({ states: { pair: 'done', start: 'done', voice: 'skipped', learning: 'done' } });
    expect(onboardingSkippedSteps(kept)).toEqual(['logins', 'speedups', 'voice', 'warden', 'controls']);
  });

  it('lists nothing once every step is set', () => {
    const states = Object.fromEntries(ONBOARDING_TASKS.map(id => [id, 'done'] as const));
    expect(onboardingSkippedSteps(progress({ states }))).toEqual([]);
  });
});

describe('the Warden step’s starting draft', () => {
  it('preselects Jev when a key is set, the Warden is on and it is on rules only', () => {
    const config = wardenConfig({ enabled: true, triage: 'rules' });
    expect(wardenStartingDraft(config, true)).toEqual({ ...config, triage: 'jev' });
  });

  it('leaves a machine without a Jev key on rules only', () => {
    const config = wardenConfig({ enabled: true, triage: 'rules' });
    expect(wardenStartingDraft(config, false)).toBe(config);
  });

  it('keeps a Warden the owner turned off', () => {
    const config = wardenConfig({ enabled: false, triage: 'rules' });
    expect(wardenStartingDraft(config, true)).toBe(config);
  });

  it('keeps a triage the owner already chose', () => {
    const llm = wardenConfig({ enabled: true, triage: 'llm' });
    expect(wardenStartingDraft(llm, true)).toBe(llm);
    const jev = wardenConfig({ enabled: true, triage: 'jev' });
    expect(wardenStartingDraft(jev, true)).toBe(jev);
  });

  it('does not change the config it was given', () => {
    const config = wardenConfig({ enabled: true, triage: 'rules' });
    wardenStartingDraft(config, true);
    expect(config.triage).toBe('rules');
  });
});
