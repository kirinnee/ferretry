import { describe, expect, it } from 'bun:test';
import {
  answerOnboardingHarness,
  backOnboardingStep,
  chooseOnboardingStart,
  completeOnboardingStep,
  continueOnboarding,
  goToOnboardingStep,
  isMachineSetupStepId,
  type MachineSetupProgress,
  type MachineSetupStepId,
  type MachineSetupTaskId,
  markOnboardingStep,
  ONBOARDING_START,
  ONBOARDING_STEPS,
  ONBOARDING_TASKS,
  onboardingDefaultsSentence,
  onboardingDoneRows,
  onboardingLaterHref,
  onboardingNeedsRuntime,
  onboardingRailMarker,
  onboardingSetCount,
  onboardingStepAt,
  onboardingStepLabel,
  onboardingSteps,
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

const WITH_SOURCES = onboardingSteps(true);
const ALONE = onboardingSteps(false);

describe('onboarding steps', () => {
  it('lists the six pages in rail order, ending on Done', () => {
    expect(ONBOARDING_STEPS.map(step => step.id)).toEqual(['start', 'claude', 'codex', 'speedups', 'defaults', 'done']);
  });

  it('shows Start from only when another machine can be copied', () => {
    expect(WITH_SOURCES).toEqual(['start', 'claude', 'codex', 'speedups', 'defaults', 'done']);
    expect(ALONE).toEqual(['claude', 'codex', 'speedups', 'defaults', 'done']);
  });

  it('moves a place on a page that is not shown to the first one that is', () => {
    expect(onboardingStepAt('start', ALONE)).toBe('claude');
    expect(onboardingStepAt('start', WITH_SOURCES)).toBe('start');
    expect(onboardingStepAt('defaults', ALONE)).toBe('defaults');
  });

  it('keeps Done out of the steps that can be set or skipped', () => {
    expect(ONBOARDING_TASKS).toHaveLength(5);
    expect(ONBOARDING_TASKS).not.toContain('done' as MachineSetupTaskId);
  });

  it('recognises a step id and rejects anything else, including the ids of the old rail', () => {
    expect(isMachineSetupStepId('defaults')).toBe(true);
    expect(isMachineSetupStepId('done')).toBe(true);
    expect(isMachineSetupStepId('warden')).toBe(false);
    expect(isMachineSetupStepId('voice')).toBe(false);
    expect(isMachineSetupStepId('pair')).toBe(false);
  });

  it('names a step by its label', () => {
    expect(onboardingStepLabel('speedups')).toBe('Speed-ups');
    expect(onboardingStepLabel('defaults')).toBe('Defaults');
  });

  it('begins on the Start from step, fresh, with nothing set', () => {
    expect(ONBOARDING_START).toEqual({ at: 'start', states: {}, start: 'fresh' });
  });
});

describe('moving through the rail', () => {
  it('moves off a stored Start that is not on the rail, marking nothing for it', () => {
    const start = progress({ at: 'start' });
    const skipped = skipOnboardingStep(start, ALONE);
    expect(skipped.at).toBe('codex');
    expect(skipped.states).toEqual({ claude: 'skipped' });
    expect(continueOnboarding(start, ALONE).at).toBe('codex');
    expect(backOnboardingStep(start, ALONE).at).toBe('claude');
  });

  it('opens any step from the rail without marking it', () => {
    const next = goToOnboardingStep(progress(), 'defaults');
    expect(next.at).toBe('defaults');
    expect(next.states).toEqual({});
  });

  it('marks a step set and opens the next when Continue is pressed', () => {
    const next = continueOnboarding(progress({ at: 'speedups' }), ALONE);
    expect(next.at).toBe('defaults');
    expect(next.states).toEqual({ speedups: 'done' });
  });

  it('opens Done after Defaults', () => {
    const next = continueOnboarding(progress({ at: 'defaults' }), ALONE);
    expect(next.at).toBe('done');
    expect(next.states).toEqual({ defaults: 'done' });
  });

  it('turns a skipped step into a set one when Continue is pressed on it', () => {
    const next = continueOnboarding(progress({ at: 'defaults', states: { defaults: 'skipped' } }), ALONE);
    expect(next.states.defaults).toBe('done');
  });

  it.each(['claude', 'codex'] as const)(
    'counts Continue on a %s step that was not imported as skipped, not set',
    harness => {
      const next = continueOnboarding(progress({ at: harness }), ALONE);
      expect(next.at).toBe(harness === 'claude' ? 'codex' : 'speedups');
      expect(next.states).toEqual({ [harness]: 'skipped' });
    },
  );

  it.each(['claude', 'codex'] as const)('keeps a %s step set when Continue is pressed after its import', harness => {
    const next = continueOnboarding(progress({ at: harness, states: { [harness]: 'done' } }), ALONE);
    expect(next.states).toEqual({ [harness]: 'done' });
  });

  it('stays on Done, marking nothing, when Continue is pressed there', () => {
    const next = continueOnboarding(progress({ at: 'done' }), ALONE);
    expect(next.at).toBe('done');
    expect(next.states).toEqual({});
  });

  it('marks a step skipped and opens the next when Skip is pressed', () => {
    const next = skipOnboardingStep(progress({ at: 'speedups' }), ALONE);
    expect(next.at).toBe('defaults');
    expect(next.states).toEqual({ speedups: 'skipped' });
  });

  it('never unsets a step that is already set when Skip is pressed on it', () => {
    const next = skipOnboardingStep(progress({ at: 'defaults', states: { defaults: 'done' } }), ALONE);
    expect(next.at).toBe('done');
    expect(next.states).toEqual({ defaults: 'done' });
  });

  it('stays on Done, marking nothing, when Skip is pressed there', () => {
    const next = skipOnboardingStep(progress({ at: 'done' }), ALONE);
    expect(next.at).toBe('done');
    expect(next.states).toEqual({});
  });

  it('goes back one listed step without marking anything', () => {
    expect(backOnboardingStep(progress({ at: 'claude' }), WITH_SOURCES).at).toBe('start');
    expect(backOnboardingStep(progress({ at: 'defaults' }), ALONE).at).toBe('speedups');
  });

  it('stays on the first listed step when Back is pressed there', () => {
    expect(backOnboardingStep(progress({ at: 'claude' }), ALONE).at).toBe('claude');
    expect(backOnboardingStep(progress({ at: 'start' }), WITH_SOURCES).at).toBe('start');
  });

  it('never opens Start from by Continue or Back when there is nothing to copy', () => {
    const steps: readonly MachineSetupStepId[] = ALONE;
    expect(steps).not.toContain('start');
    expect(continueOnboarding(progress({ at: 'done' }), steps).at).toBe('done');
  });

  it('marks a step set without moving, when a surface saved on its own', () => {
    const next = markOnboardingStep(progress({ at: 'speedups' }), 'claude');
    expect(next.at).toBe('speedups');
    expect(next.states).toEqual({ claude: 'done' });
  });

  it('records the chosen start without touching the steps', () => {
    const next = chooseOnboardingStart(progress(), 'clone');
    expect(next).toEqual({ at: 'start', states: {}, start: 'clone' });
  });

  it('keeps what was answered on each CLI’s step, apart from the other CLI’s', () => {
    const withClaude = answerOnboardingHarness(progress({ at: 'claude' }), 'claude', { name: 'claude-mine' });
    const both = answerOnboardingHarness(withClaude, 'codex', { addAnother: true, accepted: ['skills'] });
    expect(both.at).toBe('claude');
    expect(both.answers).toEqual({
      claude: { name: 'claude-mine' },
      codex: { addAnother: true, accepted: ['skills'] },
    });
    expect(answerOnboardingHarness(both, 'claude', { name: 'claude-2' }).answers?.claude).toEqual({ name: 'claude-2' });
  });

  it('never changes the progress it was given', () => {
    const before = progress({ at: 'claude' });
    continueOnboarding(before, ALONE);
    skipOnboardingStep(before, ALONE);
    markOnboardingStep(before, 'defaults');
    answerOnboardingHarness(before, 'claude', { name: 'x' });
    expect(before).toEqual({ at: 'claude', states: {}, start: 'fresh' });
  });
});

describe('the rail’s words', () => {
  it('counts the steps that are set out of the ones this setup lists', () => {
    expect(onboardingSetCount(progress(), ALONE)).toBe('0 of 4 set');
    expect(onboardingSetCount(progress({ states: { claude: 'done', defaults: 'skipped' } }), ALONE)).toBe('1 of 4 set');
    expect(onboardingSetCount(progress({ states: { start: 'done' } }), WITH_SOURCES)).toBe('1 of 5 set');
    expect(onboardingSetCount(progress({ states: { start: 'done' } }), ALONE)).toBe('0 of 4 set');
  });

  it('marks a set step ✓, a skipped step –, and any other step with its place in the list', () => {
    const kept = progress({ states: { start: 'done', claude: 'skipped' } });
    expect(onboardingRailMarker(kept, 'start', WITH_SOURCES)).toBe('✓');
    expect(onboardingRailMarker(kept, 'claude', WITH_SOURCES)).toBe('–');
    expect(onboardingRailMarker(kept, 'speedups', WITH_SOURCES)).toBe('4');
    expect(onboardingRailMarker(kept, 'done', WITH_SOURCES)).toBe('6');
    expect(onboardingRailMarker(kept, 'speedups', ALONE)).toBe('3');
    expect(onboardingRailMarker(kept, 'done', ALONE)).toBe('5');
  });
});

describe('set up later', () => {
  const href = (id: MachineSetupTaskId) => onboardingLaterHref(studio, 'Work Mac', id);

  it('links each Machine-tab panel to its own panel', () => {
    expect(href('start')).toBe('/d/studio/settings#machines/Work%20Mac/machine/clone');
    expect(href('speedups')).toBe('/d/studio/settings#machines/Work%20Mac/machine/speedups');
  });

  it('links Claude Code and Codex to the machine’s Runtimes tab', () => {
    expect(href('claude')).toBe('/d/studio/settings#machines/Work%20Mac/runtimes');
    expect(href('codex')).toBe('/d/studio/settings#machines/Work%20Mac/runtimes');
  });

  it('links Defaults to the Agents tab, where the controls and the learning default are', () => {
    expect(href('defaults')).toBe('/d/studio/settings#machines/Work%20Mac/agents');
  });
});

describe('what Done says', () => {
  const rows = (
    kept: MachineSetupProgress,
    facts: Parameters<typeof onboardingDoneRows>[1] = {},
  ): ReturnType<typeof onboardingDoneRows> => onboardingDoneRows(kept, facts, studio, 'Work Mac');
  const row = (list: ReturnType<typeof onboardingDoneRows>, id: string) => {
    const found = list.find(candidate => candidate.id === id);
    if (found === undefined) throw new Error(`no row for ${id}`);
    return found;
  };

  it('names each CLI’s runtimes with a ✓ line, from the machine', () => {
    const list = rows(progress(), { runtimes: { claude: ['claude-default', 'claude-glm'], codex: ['codex-default'] } });
    expect(row(list, 'claude')).toEqual({ id: 'claude', set: true, text: 'Claude Code — claude-default, claude-glm' });
    expect(row(list, 'codex')).toEqual({ id: 'codex', set: true, text: 'Codex — codex-default' });
    expect(list.map(item => item.id)).toEqual(['claude', 'codex', 'speedups']);
  });

  it('says only the CLI that made a runtime', () => {
    const list = rows(progress(), { runtimes: { claude: [], codex: ['codex-default'] } });
    expect(list.map(item => item.id)).toEqual(['codex', 'speedups']);
  });

  it('says one "No runtime yet" line, linked to Runtimes, when neither CLI has one', () => {
    for (const facts of [{ runtimes: { claude: [], codex: [] } }, {}]) {
      const list = rows(progress({ states: { claude: 'skipped' } }), facts);
      expect(row(list, 'runtimes')).toEqual({
        id: 'runtimes',
        set: false,
        text: 'No runtime yet',
        later: '/d/studio/settings#machines/Work%20Mac/runtimes',
      });
      expect(list.some(item => item.id === 'claude' || item.id === 'codex')).toBe(false);
    }
  });

  describe('speed-ups', () => {
    it('lists the keys that are held, with a ✓ line', () => {
      const list = rows(progress(), { keys: { Jev: true, Groq: false } });
      expect(row(list, 'speedups')).toEqual({ id: 'speedups', set: true, text: 'Speed-ups — Jev' });
    });

    it('says saved when the step was set but the keys are not known', () => {
      const list = rows(progress({ states: { speedups: 'done' } }));
      expect(row(list, 'speedups')).toEqual({ id: 'speedups', set: true, text: 'Speed-ups saved' });
    });

    it('says skipped, linked to Speed-ups, when no key is held and the step was not set', () => {
      const list = rows(progress({ states: { speedups: 'skipped' } }), { keys: { Jev: false, Groq: false } });
      expect(row(list, 'speedups')).toEqual({
        id: 'speedups',
        set: false,
        text: 'Speed-ups skipped',
        later: '/d/studio/settings#machines/Work%20Mac/machine/speedups',
      });
    });
  });
});

describe('the defaults sentence', () => {
  const allOn = { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false };

  it('says the voice, learning and what agents may use, as the machine has them', () => {
    expect(onboardingDefaultsSentence({ voice: 'browser', passiveDefault: true, agentControl: allOn })).toBe(
      'Defaults: browser voice, learning on, agents may use terminals, browsers and files.',
    );
  });

  it('names Parakeet, no voice, learning off and no agent use', () => {
    expect(
      onboardingDefaultsSentence({
        voice: 'parakeet',
        passiveDefault: false,
        agentControl: { ...allOn, terminals: false, browsers: false, files: false },
      }),
    ).toBe('Defaults: Parakeet voice, learning off, agents may use nothing.');
    expect(onboardingDefaultsSentence({ voice: 'off' })).toBe('Defaults: no default voice.');
  });

  it('claims nothing it did not read', () => {
    expect(onboardingDefaultsSentence({})).toBe('Defaults are set.');
  });
});

describe('the Warden step’s starting draft', () => {
  it('preselects Jev alone when a key is set, the Warden is on and it is on rules only', () => {
    const config = wardenConfig({ enabled: true, layers: { jev: false, llm: false } });
    expect(wardenStartingDraft(config, true)).toEqual({ ...config, layers: { jev: true, llm: false } });
  });

  it('leaves a machine without a Jev key on rules only', () => {
    const config = wardenConfig({ enabled: true, layers: { jev: false, llm: false } });
    expect(wardenStartingDraft(config, false)).toBe(config);
  });

  it('keeps a Warden the owner turned off', () => {
    const config = wardenConfig({ enabled: false, layers: { jev: false, llm: false } });
    expect(wardenStartingDraft(config, true)).toBe(config);
  });

  it('keeps a layer the owner already chose', () => {
    const llm = wardenConfig({ enabled: true, layers: { jev: false, llm: true } });
    expect(wardenStartingDraft(llm, true)).toBe(llm);
    const jev = wardenConfig({ enabled: true, layers: { jev: true, llm: true } });
    expect(wardenStartingDraft(jev, true)).toBe(jev);
  });

  it('does not change the config it was given', () => {
    const config = wardenConfig({ enabled: true, layers: { jev: false, llm: false } });
    wardenStartingDraft(config, true);
    expect(config.layers).toEqual({ jev: false, llm: false });
  });
});

describe('onboardingNeedsRuntime', () => {
  it('says nothing while the machine has not answered', () => {
    expect(onboardingNeedsRuntime({})).toBe(false);
  });

  it('needs a runtime when neither CLI has one', () => {
    expect(onboardingNeedsRuntime({ runtimes: { claude: [], codex: [] } })).toBe(true);
    expect(onboardingNeedsRuntime({ runtimes: {} })).toBe(true);
  });

  it('is satisfied by a runtime on either CLI', () => {
    expect(onboardingNeedsRuntime({ runtimes: { claude: [], codex: ['codex-default'] } })).toBe(false);
  });
});

describe('completing a step that asked to move on', () => {
  it('marks it set and opens the next when the person is still on it', () => {
    const next = completeOnboardingStep(progress({ at: 'claude' }), 'claude', true, ALONE);
    expect(next.at).toBe('codex');
    expect(next.states).toEqual({ claude: 'done' });
  });

  it('marks it set but stays where the person is when they are on another page', () => {
    const next = completeOnboardingStep(progress({ at: 'codex' }), 'claude', true, ALONE);
    expect(next.at).toBe('codex');
    expect(next.states).toEqual({ claude: 'done' });
  });

  it('marks it set but never moves a person who left the visit that asked, even back on the same step', () => {
    const next = completeOnboardingStep(progress({ at: 'claude' }), 'claude', false, ALONE);
    expect(next.at).toBe('claude');
    expect(next.states).toEqual({ claude: 'done' });
  });
});
