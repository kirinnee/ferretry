import { describe, expect, it } from 'bun:test';

import {
  accountProblems,
  emptyAccountDraft,
  emptyLayerDraft,
  type FleetAccountDraft,
  type FleetLayerDraft,
  INSTRUCTIONS_PREFIX,
  instructionsMiddleOf,
  instructionsPathFor,
} from '../../../../src/features/fleet/fleet-change-model.ts';
import {
  ALL_STEP_PROBLEMS,
  assetProblemStep,
  customModelProblem,
  DEFAULT_LANE,
  draftIsComplete,
  FLEET_STEP_IDS,
  FLEET_STEPS,
  instructionsChoiceFor,
  instructionsMiddle,
  instructionsNameProblem,
  laneForMode,
  mayAdvance,
  modelOptions,
  nextStep,
  openingInstructionsSource,
  otherLanes,
  previousStep,
  selectedModels,
  settingsChoice,
  skillsSelection,
  skillsStoreItems,
  stepCopy,
  stepIndex,
  stepProblems,
  toggleModel,
  unverifiedModels,
  withInstructionsMiddle,
  withMode,
  withModels,
  withSettingsChoice,
  withSkillsSelection,
} from '../../../../src/features/fleet/fleet-stepper-model.ts';
import { absentCodex, account, config, discovery, harness } from './fleet-support.ts';

/** A draft with nothing outstanding, so a test can put back exactly the one thing it is about. */
const complete = (overrides: Partial<FleetAccountDraft> = {}): FleetAccountDraft => ({
  ...emptyAccountDraft('claude'),
  name: 'atelier',
  modelsText: 'claude-opus-5',
  defaultModel: 'claude-opus-5',
  ...overrides,
});

const layerWith = (overrides: Partial<FleetLayerDraft> = {}): FleetLayerDraft => ({
  ...emptyLayerDraft(),
  ...overrides,
});

describe('the sequence', () => {
  it('names every step once, in order, with a question a person could answer', () => {
    expect(FLEET_STEPS.map(step => step.id)).toEqual([...FLEET_STEP_IDS]);
    // Every step says what it is asking. A step with no question is a screen nobody can act on.
    for (const step of FLEET_STEPS) {
      expect(step.question.length).toBeGreaterThan(0);
      expect(step.title.length).toBeGreaterThan(0);
      expect(stepCopy(step.id)).toEqual(step);
    }
  });

  it('never wraps at either end', () => {
    // The last step is the recap and there is nothing after it; the first is where the sequence opens.
    expect(nextStep('review')).toBe('review');
    expect(previousStep('harness')).toBe('harness');
    expect(nextStep('harness')).toBe('identity');
    expect(previousStep('models')).toBe('identity');
    expect(stepIndex('models')).toBe(2);
  });
});

describe('the lane, derived from how the account runs', () => {
  it('prefers a lane named after the mode, then the default one, then whatever the fleet declared', () => {
    expect(laneForMode('auto', ['default', 'auto'])).toBe('auto');
    expect(laneForMode('interactive', ['default', 'auto'])).toBe(DEFAULT_LANE);
    // A fleet that declares neither has exactly one thing it could mean.
    expect(laneForMode('auto', ['review'])).toBe('review');
    // And an empty list is what the daemon itself defaults to, rather than a second answer.
    expect(laneForMode('auto', [])).toBe(DEFAULT_LANE);
  });

  it('offers no lane control for a fleet whose lanes every answer already derives', () => {
    expect(otherLanes(['default', 'auto', 'interactive'])).toEqual([]);
    expect(otherLanes(['default', 'review', 'triage'])).toEqual(['review', 'triage']);
  });

  it('moves the lane with the answer, so the two can never disagree', () => {
    const auto = withMode(complete(), 'auto', ['default', 'auto']);
    expect(auto).toMatchObject({ mode: 'auto', variant: 'auto' });
    expect(withMode(auto, 'interactive', ['default', 'auto']).variant).toBe('default');
  });
});

describe('the models on offer', () => {
  it('offers what the host read, marked as read, and nothing it invented', () => {
    const options = modelOptions('claude', discovery(), []);
    expect(options.map(option => option.id)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(options[0]?.verified).toBe(true);
    expect(options[0]?.detail).toContain('/home/pilot/.claude/settings.json');
  });

  it('says a fallback is a fallback rather than dressing it as a detection', () => {
    const options = modelOptions('codex', discovery(), []);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ id: 'gpt-5.6', verified: false });
    expect(options[0]?.detail).toContain('starter model');
  });

  it('adds what this fleet already serves for the same harness, with the name that fleet gave it', () => {
    const options = modelOptions('claude', null, [
      account({
        models: [
          { id: 'claude-opus-5', displayName: 'Opus 5', available: true },
          { id: 'retired', available: false, unavailableReason: 'the provider withdrew it' },
        ],
      }),
      // Another harness's models are not this harness's models.
      account({
        id: account().id,
        kind: 'codex',
        wrapper: 'codex-other',
        models: [{ id: 'gpt-5.6', available: true }],
      }),
    ]);
    expect(options.map(option => option.id)).toEqual(['claude-opus-5']);
    expect(options[0]).toMatchObject({ displayName: 'Opus 5', verified: true });
    expect(options[0]?.detail).toContain('claude-studio');
  });

  it('lets the host own an identifier a sibling account also names', () => {
    // The host's reading describes THIS harness's configuration; a sibling describes somebody's choice
    // for a different account. One entry, and the stronger evidence keeps it.
    const options = modelOptions('claude', discovery(), [account()]);
    expect(options.filter(option => option.id === 'claude-opus-5')).toHaveLength(1);
    expect(options[0]?.detail).toContain('settings.json');
  });

  it('offers nothing at all rather than a plausible-looking guess', () => {
    expect(modelOptions('claude', null, [])).toEqual([]);
  });
});

describe('choosing models', () => {
  it('makes the first one the default, and keeps the default true when one is removed', () => {
    const empty = complete({ modelsText: '', defaultModel: '' });
    const one = toggleModel(empty, 'claude-opus-5');
    expect(one).toMatchObject({ modelsText: 'claude-opus-5', defaultModel: 'claude-opus-5' });

    const two = toggleModel(one, 'claude-sonnet-5');
    // Adding a second does not steal the default.
    expect(two.defaultModel).toBe('claude-opus-5');

    // Removing the default leaves the account naming one it no longer lists, so it moves.
    const dropped = toggleModel(two, 'claude-opus-5');
    expect(selectedModels(dropped)).toEqual(['claude-sonnet-5']);
    expect(dropped.defaultModel).toBe('claude-sonnet-5');

    // And removing the last one leaves no default rather than a stale name.
    expect(withModels(dropped, []).defaultModel).toBe('');
  });

  it('marks a selection nothing on this host names', () => {
    const options = modelOptions('claude', discovery(), []);
    const drafted = withModels(complete(), ['claude-opus-5', 'my-local-llm']);
    expect(unverifiedModels(drafted, options)).toEqual(['my-local-llm']);
  });

  it('refuses only what it can honestly refuse about a provider identifier', () => {
    const drafted = complete({ modelsText: 'claude-opus-5' });
    expect(customModelProblem('', drafted)).toBe('type the model identifier first');
    expect(customModelProblem(' spaced ', drafted)).toContain('must not start or end with a space');
    expect(customModelProblem('claude-opus-5', drafted)).toContain('already listed');
    // Anything else is a string a provider either recognises or does not, and this browser cannot tell.
    expect(customModelProblem('some-model-nobody-here-knows', drafted)).toBeNull();
  });
});

describe('naming a document in the store', () => {
  it('fixes the prefix per harness and lets the person own the middle', () => {
    expect(INSTRUCTIONS_PREFIX).toEqual({ claude: 'CLAUDE-', codex: 'AGENTS-' });
    expect(instructionsPathFor('claude', 'auto')).toBe('instructions/CLAUDE-auto.md');
    expect(instructionsPathFor('codex', ' review ')).toBe('instructions/AGENTS-review.md');
    // An empty middle names nothing, rather than a bare prefix.
    expect(instructionsPathFor('claude', '  ')).toBe('');
  });

  it('recovers the middle only from a path this scheme produced', () => {
    expect(instructionsMiddleOf('claude', 'instructions/CLAUDE-auto.md')).toBe('auto');
    // Somebody else's document is not a middle with a prefix missing, and offering to rename it would
    // silently repoint the account.
    expect(instructionsMiddleOf('claude', 'instructions/house-rules.md')).toBeUndefined();
    expect(instructionsMiddleOf('claude', 'instructions/CLAUDE-auto.txt')).toBeUndefined();
    expect(instructionsMiddleOf('claude', 'instructions/CLAUDE-.md')).toBeUndefined();
    expect(instructionsMiddle(complete())).toBe('');
  });

  it('rewrites only the middle, and stops the derived name overwriting a chosen one', () => {
    const named = withInstructionsMiddle(complete(), 'house');
    expect(named.layer.instructions.path).toBe('instructions/CLAUDE-house.md');
    expect(named.prefilled.instructionsPath).toBeUndefined();

    // Clearing the box is a request for the derived default back, so the claim survives an empty middle.
    const claimed = { ...complete(), prefilled: { instructionsPath: 'Derived — …' } };
    expect(withInstructionsMiddle(claimed, '').prefilled.instructionsPath).toBe('Derived — …');
  });

  it('refuses a name that would write over a document the store already has, and says which', () => {
    const store = ['instructions/CLAUDE-shared.md'];
    expect(instructionsNameProblem('', 'claude', store)).toBe('name this document');
    expect(instructionsNameProblem(' auto ', 'claude', store)).toContain('must not start or end with a space');
    expect(instructionsNameProblem('a/b', 'claude', store)).toContain('path separator');
    expect(instructionsNameProblem('../escape', 'claude', store)).toContain('path separator');
    const collision = instructionsNameProblem('shared', 'claude', store);
    expect(collision).toContain('instructions/CLAUDE-shared.md');
    expect(collision).toContain('Use an existing one');
    expect(instructionsNameProblem('atelier', 'claude', store)).toBeNull();
  });

  it('refuses a name the daemon own asset grammar would refuse', () => {
    // Not a second copy of the grammar: the shared helper decides, and this only proves it is asked.
    expect(instructionsNameProblem('x'.repeat(300), 'claude', [])).toContain('that name produces a path that');
  });
});

describe('where the instructions come from', () => {
  it('opens on the host own document when there is one, and on a new one when there is not', () => {
    expect(openingInstructionsSource({ ...complete(), prefilled: { instructionsText: 'Imported — …' } })).toBe(
      'import',
    );
    expect(openingInstructionsSource(complete())).toBe('new');
  });

  it('turns each answer into the one value the document picker takes', () => {
    expect(instructionsChoiceFor('import', 'instructions/a.md')).toBe('new-imported');
    expect(instructionsChoiceFor('new', 'instructions/a.md')).toBe('new-blank');
    expect(instructionsChoiceFor('existing', 'instructions/a.md')).toBe('asset:instructions/a.md');
    // Asking for the store when the store is empty lands on a new document rather than a dead radio.
    expect(instructionsChoiceFor('existing', undefined)).toBe('new-blank');
  });
});

describe('the skills store', () => {
  it('lists what the configuration declares, with the wrappers that already link it', () => {
    const declared = config({
      default: { id: account().id, wrapper: 'claude-studio', layer: { skills: 'skills/studio' } },
      auto: { id: account().id, wrapper: 'claude-auto-studio', layer: { skills: 'skills/studio' } },
      bare: { id: account().id, wrapper: 'claude-bare' },
    });
    expect(skillsStoreItems(declared, [])).toEqual([
      { path: 'skills/studio', accounts: ['claude-studio', 'claude-auto-studio'] },
    ]);
  });

  it('adds a directory the tree holds under a declared root, so a store item nothing links is offerable', () => {
    const declared = config({
      default: { id: account().id, wrapper: 'claude-studio', layer: { skills: 'skills/studio' } },
    });
    const items = skillsStoreItems(declared, [
      'skills/studio/review.md',
      'skills/research/read.md',
      // A document directly in the root is not a store item; nor is anything outside a declared root.
      'skills/loose.md',
      'instructions/CLAUDE-atelier.md',
    ]);
    expect(items).toEqual([
      { path: 'skills/studio', accounts: ['claude-studio'] },
      { path: 'skills/research', accounts: [] },
    ]);
  });

  it('infers nothing from a name when the configuration declares no skills at all', () => {
    // A tree with a `skills/` directory nobody declared is not evidence: the configuration is the only
    // thing that says which directories hold skills.
    expect(skillsStoreItems(config(), ['skills/studio/review.md'])).toEqual([]);
    expect(skillsStoreItems(null, ['skills/studio/review.md'])).toEqual([]);
  });

  it('selects and clears one store directory, taking any authored documents with it', () => {
    const empty = layerWith();
    expect(skillsSelection(empty).selected).toEqual([]);
    const chosen = withSkillsSelection({ ...empty, skills: [{ id: 'a', path: 'skills/studio/a.md', text: '' }] }, [
      'skills/studio',
    ]);
    expect(skillsSelection(chosen).selected).toEqual(['skills/studio']);
    expect(chosen.skills).toHaveLength(1);

    // Deselecting must not leave documents naming a directory the draft no longer declares, which
    // `layerProblems` would then report as a problem the person did not cause.
    const cleared = withSkillsSelection(chosen, []);
    expect(cleared).toMatchObject({ skillsDirectory: '', skills: [] });
  });
});

describe('the settings answer', () => {
  it('reads an empty box as leaving the fleet settings alone', () => {
    expect(settingsChoice(layerWith())).toBe('fleet');
    expect(settingsChoice(layerWith({ settingsText: '{"model":"opus"}' }))).toBe('own');
  });

  it('seeds something that parses when a person asks to set some, and clears it on the way back', () => {
    const own = withSettingsChoice(layerWith(), 'own');
    expect(own.settingsText).toBe('{}');
    // Choosing "own" again must not throw away what they typed.
    expect(withSettingsChoice(own, 'own').settingsText).toBe('{}');
    const typed = layerWith({ settingsText: '{"model":"opus"}' });
    expect(withSettingsChoice(typed, 'own')).toBe(typed);
    expect(withSettingsChoice(typed, 'fleet').settingsText).toBe('');
  });
});

describe('which step owns which blocker', () => {
  it('claims every sentence exactly once, so nobody is refused at the end for a reason no step showed', () => {
    // THE PARTITION PROOF. Six per-step lists that happened to look right today would drift, and the way
    // they drift is that the recap refuses a change for a rule no earlier step would ever display.
    const drafts: readonly FleetAccountDraft[] = [
      emptyAccountDraft('claude'),
      complete(),
      complete({ name: ' spaced ' }),
      complete({ name: 'a/b' }),
      complete({ name: 'x'.repeat(65) }),
      complete({ name: 'a..b' }),
      complete({ modelsText: '', defaultModel: '' }),
      complete({ defaultModel: '' }),
      complete({ defaultModel: 'not-listed' }),
      complete({ variant: '' }),
      complete({ variant: 'nope' }),
      complete({ layer: layerWith({ settingsText: '{ not json' }) }),
      complete({ layer: layerWith({ settingsText: '[1]' }) }),
      complete({ layer: layerWith({ env: [{ id: '1', name: '', value: 'x' }] }) }),
      complete({ layer: layerWith({ env: [{ id: '1', name: '1bad', value: 'x' }] }) }),
      complete({
        layer: layerWith({
          env: [
            { id: '1', name: 'A', value: 'x' },
            { id: '2', name: 'A', value: 'y' },
          ],
        }),
      }),
      complete({ layer: layerWith({ instructions: { path: '/absolute.md', text: '' } }) }),
      complete({ layer: layerWith({ instructions: { path: '', text: '# text with no path' } }) }),
      complete({ layer: layerWith({ skillsDirectory: '/absolute', skills: [] }) }),
      complete({ layer: layerWith({ skillsDirectory: '', skills: [{ id: '1', path: 'a.md', text: '' }] }) }),
      complete({ layer: layerWith({ skillsDirectory: 'skills', skills: [{ id: '1', path: '', text: '' }] }) }),
      complete({
        layer: layerWith({ skillsDirectory: 'skills', skills: [{ id: '1', path: 'other/a.md', text: '' }] }),
      }),
      complete({ layer: layerWith({ skillsDirectory: 'skills', skills: [{ id: '1', path: '/a.md', text: '' }] }) }),
      complete({
        layer: layerWith({
          instructions: { path: 'shared.md', text: 'a' },
          skillsDirectory: '',
          skills: [{ id: '1', path: 'shared.md', text: 'b' }],
        }),
      }),
    ];
    const declared = config();
    for (const draft of drafts) {
      const whole = [...new Set(accountProblems(draft, declared))].sort();
      const partitioned = [...new Set(ALL_STEP_PROBLEMS(draft, declared))].sort();
      expect(partitioned).toEqual(whole);
    }
  });

  it('lets a step advance on its own answers alone', () => {
    const declared = config();
    const nameless = emptyAccountDraft('claude');
    // The harness step has a preselected answer and nothing that can be wrong, so it always advances —
    // even though the draft as a whole is nowhere near complete.
    expect(mayAdvance('harness', nameless, declared)).toBe(true);
    expect(stepProblems('harness', nameless, declared)).toEqual([]);
    expect(mayAdvance('identity', nameless, declared)).toBe(false);
    expect(stepProblems('identity', nameless, declared)[0]).toContain('name the provider account');
    // A blocker from a read the daemon refused stops the step it belongs to as firmly as a typo does.
    expect(mayAdvance('instructions', complete(), declared, ['could not be read'])).toBe(false);
    // The recap owns nothing of its own: it shows everything, which is what a recap is.
    expect(stepProblems('review', nameless, declared)).toEqual([]);
  });

  it('says whether the whole draft is composable', () => {
    expect(draftIsComplete(complete(), config())).toBe(true);
    expect(draftIsComplete(emptyAccountDraft('claude'), config())).toBe(false);
  });

  it('routes an unreadable asset to the step whose field names it', () => {
    const layer = layerWith({
      instructions: { path: 'instructions/CLAUDE-atelier.md', text: '' },
      skillsDirectory: 'skills/studio',
    });
    expect(assetProblemStep({ scope: 'file', path: 'instructions/CLAUDE-atelier.md', reason: 'x' }, layer)).toBe(
      'instructions',
    );
    expect(assetProblemStep({ scope: 'file', path: 'skills/studio/a.md', reason: 'x' }, layer)).toBe('skills');
    // A truncated walk is not a file anybody can stop naming, so it belongs to the recap, where it
    // stops the change without pretending an earlier step could clear it.
    expect(assetProblemStep({ scope: 'tree', path: 'fleet/assets', reason: 'x' }, layer)).toBe('review');
  });
});

describe('the harness that answers nothing', () => {
  it('still produces a model list from the fleet when the host said nothing about that kind', () => {
    // A report that names only Claude says nothing about Codex, and a form told nothing must not fill
    // itself in from an absence of evidence.
    const claudeOnly = discovery([harness()]);
    expect(modelOptions('codex', claudeOnly, [])).toEqual([]);
    expect(modelOptions('codex', discovery([harness(), absentCodex()]), []).map(option => option.id)).toEqual([
      'gpt-5.6',
    ]);
  });
});
