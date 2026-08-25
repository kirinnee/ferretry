import { describe, expect, it } from 'bun:test';

import {
  accountProblems,
  emptyAccountDraft,
  emptyLayerDraft,
  type FleetAccountDraft,
  type FleetLayerDraft,
  type FleetProfileVariableDraft,
  INSTRUCTIONS_PREFIX,
  instructionsMiddleOf,
  instructionsPathFor,
} from '../../../../src/features/fleet/fleet-change-model.ts';
import {
  ALL_STEP_PROBLEMS,
  assetProblemStep,
  authoredSkill,
  composedProfileEnv,
  customModelProblem,
  DEFAULT_LANE,
  describeEnvShape,
  draftIsComplete,
  everyAccountProfile,
  FLEET_STEP_IDS,
  FLEET_STEPS,
  instructionsChoiceFor,
  instructionsMiddle,
  instructionsNameProblem,
  laneForMode,
  mayAdvance,
  modelOptions,
  newProfileDraft,
  newSkillProblem,
  nextStep,
  openingInstructionsSource,
  otherLanes,
  PICK_OR_ADD_LABEL,
  previousStep,
  profileChoices,
  profilesAlreadyBound,
  profileVariablesFor,
  SKILL_DOCUMENT,
  SKILLS_PREFIX,
  selectedModels,
  selectedModes,
  settingsChoice,
  skillsSelection,
  skillsStoreItems,
  stepCopy,
  stepIndex,
  stepProblems,
  toggleMode,
  toggleModel,
  toggleProfile,
  unverifiedModels,
  withAuthoredSkillText,
  withInstructionsMiddle,
  withLaneVariant,
  withModels,
  withModes,
  withNewProfile,
  withNewSkill,
  withProfileVariable,
  withProfileVariableAdded,
  withProfileVariableRemoved,
  withSettingsChoice,
  withSkillsSelection,
} from '../../../../src/features/fleet/fleet-stepper-model.ts';
import { absentCodex, account, config, discovery, harness, profileCatalog } from './fleet-support.ts';

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
    expect(nextStep('identity')).toBe('credential');
    expect(previousStep('models')).toBe('credential');
    expect(stepIndex('models')).toBe(3);
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
    const auto = withModes(complete(), ['auto'], ['default', 'auto']);
    expect(auto.lanes).toEqual([{ mode: 'auto', variant: 'auto' }]);
    expect(withModes(auto, ['interactive'], ['default', 'auto']).lanes).toEqual([
      { mode: 'interactive', variant: 'default' },
    ]);
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
    expect(collision).toContain(PICK_OR_ADD_LABEL.existing);
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

describe('the skill this draft is writing', () => {
  /** A store item, so a collision fixture pins the shape the step actually reads. */
  const stored = (path: string) => ({ path, accounts: [] as readonly string[] });

  it('asks for a name before it refuses one', () => {
    // An empty box is the OPENING state of the control, not a mistake somebody made. It asks rather
    // than reporting, which is why it is a separate sentence from every refusal below it.
    expect(newSkillProblem('', [], layerWith())).toBe('name the skill first');
    expect(newSkillProblem('   ', [], layerWith())).toBe('name the skill first');
  });

  it('refuses a name whose edges are whitespace, rather than trimming it into a different name', () => {
    // Quietly trimming would write `skills/review` for somebody who typed `review ` and believed the
    // space was part of it — and the daemon's own grammar refuses a segment with an edge space anyway.
    expect(newSkillProblem('review ', [], layerWith())).toBe('a skill name must not start or end with a space');
    expect(newSkillProblem(' review', [], layerWith())).toBe('a skill name must not start or end with a space');
  });

  it('refuses a name that is secretly a path', () => {
    const expected = 'the name must not contain a path separator or ".."';
    expect(newSkillProblem('a/b', [], layerWith())).toBe(expected);
    expect(newSkillProblem('a\\b', [], layerWith())).toBe(expected);
    expect(newSkillProblem('..', [], layerWith())).toBe(expected);
    // `..` anywhere, not only as a whole segment — the prefix is prepended, so the person never sees
    // the path this would produce until it is already in the change.
    expect(newSkillProblem('re..view', [], layerWith())).toBe(expected);
  });

  it('reports the shared grammar in the shared grammar’s own words, about the path it produced', () => {
    // A control character passes every check above and is still refused by `fleetAssetRefProblem`, which
    // is the ONE description of what a browser may compose. Restating it here is how two descriptions
    // drift; the label says the refusal is about the produced path rather than about what was typed.
    const problem = newSkillProblem('re\u0007view', [], layerWith());
    expect(problem).toBe('that name produces a path that contains control characters');
  });

  it('redirects a name the store already holds to the control that links it', () => {
    // NOT a refusal of the intent. Somebody typing a name the store has almost always means to link it,
    // and the tick-cards above are where that happens — so the sentence names the path and the control.
    expect(newSkillProblem('studio', [stored('skills/studio')], layerWith())).toBe(
      '"skills/studio" is already in the store — tick it above to link it, or choose another name',
    );
    // A different store item is not a collision.
    expect(newSkillProblem('review', [stored('skills/studio')], layerWith())).toBeNull();
  });

  it('refuses the name this draft is already writing, so Add cannot silently replace it', () => {
    expect(newSkillProblem('review', [], layerWith({ skillsDirectory: 'skills/review' }))).toBe(
      '"skills/review" is already listed',
    );
  });

  it('seeds one document inside the new directory, with the path derived rather than asked for', () => {
    const written = withNewSkill(layerWith(), ' review ', 'id-1');
    expect(written.skillsDirectory).toBe(`${SKILLS_PREFIX}review`);
    // The document is INSIDE the directory it declares — `skillsProblems` refuses one that is not, and
    // a person made to keep two boxes agreeing is maintaining an invariant the scheme already knows.
    expect(written.skills).toEqual([{ id: 'id-1', path: `${SKILLS_PREFIX}review/${SKILL_DOCUMENT}`, text: '' }]);
    expect(authoredSkill(written)?.path).toBe(`${SKILLS_PREFIX}review/${SKILL_DOCUMENT}`);
  });

  it('replaces the authored skill rather than accumulating a second one', () => {
    // The step offers ONE "add", and the selection it feeds holds one reference. A second row would be a
    // document the cards never show and the recap would still write.
    const once = withNewSkill(layerWith(), 'review', 'id-1');
    const twice = withNewSkill(once, 'triage', 'id-2');
    expect(twice.skills).toHaveLength(1);
    expect(twice.skillsDirectory).toBe(`${SKILLS_PREFIX}triage`);
  });

  it('edits the authored document’s text, and changes nothing when there is no document to edit', () => {
    const written = withNewSkill(layerWith(), 'review', 'id-1');
    const typed = withAuthoredSkillText(written, '# review\n');
    expect(authoredSkill(typed)?.text).toBe('# review\n');
    // The id survives, because it is the DOM identity of the row being edited.
    expect(authoredSkill(typed)?.id).toBe('id-1');

    // A layer with nothing authored is returned untouched rather than growing a row from a keystroke.
    const nothing = layerWith();
    expect(withAuthoredSkillText(nothing, 'text')).toBe(nothing);
    expect(authoredSkill(nothing)).toBeUndefined();
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
      complete({ lanes: [{ mode: 'auto', variant: '' }] }),
      complete({ lanes: [{ mode: 'auto', variant: 'nope' }] }),
      complete({ lanes: [] }),
      complete({
        lanes: [
          { mode: 'interactive', variant: 'default' },
          { mode: 'auto', variant: 'default' },
        ],
      }),
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
    expect(stepProblems('identity', nameless, declared)[0]).toContain('pick the account this signs in as');
    // A blocker from a read the daemon refused stops the step it belongs to as firmly as a typo does.
    expect(mayAdvance('instructions', complete(), declared, ['could not be read'])).toBe(false);
    // The recap owns nothing of its own: it shows everything, which is what a recap is.
    expect(stepProblems('review', nameless, declared)).toEqual([]);
  });

  it('ticks a mode on and off, deriving a lane for a new one and keeping a chosen one', () => {
    // Arrange — a fleet with a lane no mode would derive, so the escape hatch has something to hold.
    const variants = ['default', 'auto', 'review'];
    const one = withModes(complete(), ['interactive'], variants);

    // Act — move that account into `review`, then tick the second mode.
    const moved = withLaneVariant(one, 'interactive', 'review');
    const both = toggleMode(moved, 'auto', variants);

    // Assert — the chosen lane survives; the newly ticked mode derives its own.
    expect(both.lanes).toEqual([
      { mode: 'interactive', variant: 'review' },
      { mode: 'auto', variant: 'auto' },
    ]);
    expect(selectedModes(both)).toEqual(['interactive', 'auto']);
    // Order is annotated, not selection order: the same two accounts always read as the same change.
    expect(toggleMode(withModes(complete(), ['auto'], variants), 'interactive', variants).lanes).toEqual([
      { mode: 'interactive', variant: 'default' },
      { mode: 'auto', variant: 'auto' },
    ]);
    // Untick, and only that lane goes.
    expect(toggleMode(both, 'auto', variants).lanes).toEqual([{ mode: 'interactive', variant: 'review' }]);
    expect(toggleMode(toggleMode(both, 'auto', variants), 'interactive', variants).lanes).toEqual([]);
  });

  it('blocks the identity step, and only that step, when no mode is ticked', () => {
    // The one blocker the multi-select made reachable. It belongs where the boxes are.
    const declared = config();
    const nothing = complete({ lanes: [] });
    expect(stepProblems('identity', nothing, declared)).toContain(
      'pick at least one way this account runs; each one creates its own account',
    );
    expect(mayAdvance('identity', nothing, declared)).toBe(false);
    expect(mayAdvance('models', nothing, declared)).toBe(true);
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

/** A draft that has chosen a profile rather than a sign-in, which is what the profile rules read. */
const profiled = (overrides: Partial<FleetAccountDraft> = {}): FleetAccountDraft =>
  complete({ credential: 'profile', ...overrides });

const profileRow = (
  overrides: Partial<FleetProfileVariableDraft> = {},
): FleetProfileVariableDraft & Record<string, unknown> => ({
  id: 'row-one',
  from: 'secret',
  variable: 'ANTHROPIC_API_KEY',
  detail: 'WORK_KEY',
  ...overrides,
});

describe('profileChoices and everyAccountProfile', () => {
  it('should offer every profile except the one every account already composes', () => {
    // Arrange — `base` is not a choice. A tick box that could not be unticked is a control that lies
    // about what it does, so it is reported separately and shown in the ORDER rather than offered.
    const catalog = profileCatalog();

    // Act & Assert
    expect(profileChoices(catalog).map(profile => profile.name)).toEqual(['gateway', 'work']);
    expect(everyAccountProfile(catalog)?.name).toBe('base');
  });

  it('should offer nothing at all before this browser has read the catalog', () => {
    expect(profileChoices(null)).toEqual([]);
    expect(everyAccountProfile(null)).toBeUndefined();
  });
});

describe('profileVariablesFor', () => {
  it('should keep a flat variable and the overlay for THIS harness, in the order they apply', () => {
    // Arrange — within one slot the overlay beats the flat field, and the catalog puts overlay entries
    // after flat ones. So "later wins" reproduces the rule without this module restating it.
    const profile = {
      name: 'work',
      appliesToEveryAccount: false,
      accounts: [],
      authenticates: [] as const,
      variables: [
        { variable: 'ANTHROPIC_API_KEY', shape: { shape: 'secret' as const, secrets: ['SHARED'] } },
        {
          variable: 'ANTHROPIC_API_KEY',
          shape: { shape: 'secret' as const, secrets: ['CLAUDE'] },
          harness: 'claude' as const,
        },
        {
          variable: 'OPENAI_API_KEY',
          shape: { shape: 'secret' as const, secrets: ['CODEX'] },
          harness: 'codex' as const,
        },
      ],
    };

    // Act & Assert — the other harness's overlay is absent rather than last, so it cannot win here.
    expect(profileVariablesFor(profile, 'claude').map(entry => entry.shape)).toEqual([
      { shape: 'secret', secrets: ['SHARED'] },
      { shape: 'secret', secrets: ['CLAUDE'] },
    ]);
    expect(profileVariablesFor(profile, 'codex').map(entry => entry.variable)).toEqual([
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
    ]);
  });
});

describe('describeEnvShape', () => {
  it('should name the secrets a variable takes its value from, so somebody knows what to set', () => {
    expect(describeEnvShape({ shape: 'secret', secrets: ['WORK_KEY'] })).toContain('secret WORK_KEY');
    expect(describeEnvShape({ shape: 'secret', secrets: ['SCHEME', 'WORK_KEY'] })).toContain(
      'secrets SCHEME, WORK_KEY',
    );
  });

  it('should name the variable an environment reference is read from', () => {
    expect(describeEnvShape({ shape: 'environment-reference', variable: 'OUTER_PROXY' })).toContain('$OUTER_PROXY');
  });

  it('should say a literal is set and stop, because there is no rule for which literals are safe', () => {
    // Most literals are harmless, some are not, and no rule deciding which stays right — so the wire
    // carries no text for one and this sentence has none to say.
    const copy = describeEnvShape({ shape: 'literal' });

    expect(copy).toBe('a plain value this profile sets');
  });
});

describe('composedProfileEnv', () => {
  it('should say which slot supplied each value and which slots it beat, in the daemon’s own words', () => {
    // Arrange — `base` sets a URL, `work` sets the key and the same URL, and the account sets the URL
    // again. So one variable is contested by all three and the account is last.
    const catalog = profileCatalog({
      profiles: [
        {
          name: 'base',
          appliesToEveryAccount: true,
          variables: [{ variable: 'ANTHROPIC_BASE_URL', shape: { shape: 'literal' } }],
          accounts: [],
          authenticates: [],
        },
        {
          name: 'work',
          appliesToEveryAccount: false,
          variables: [
            { variable: 'ANTHROPIC_API_KEY', shape: { shape: 'secret', secrets: ['WORK_KEY'] } },
            { variable: 'ANTHROPIC_BASE_URL', shape: { shape: 'literal' } },
          ],
          accounts: [],
          authenticates: ['claude'],
        },
      ],
    });
    const draft = profiled({
      profiles: ['work'],
      layer: layerWith({ env: [{ id: 'one', name: 'ANTHROPIC_BASE_URL', value: 'https://mine.invalid' }] }),
    });

    // Act
    const actual = composedProfileEnv(catalog, draft);

    // Assert — sorted by variable, and `overrode` is in the order the slots applied.
    expect(actual).toEqual([
      {
        variable: 'ANTHROPIC_API_KEY',
        shape: { shape: 'secret', secrets: ['WORK_KEY'] },
        from: 'the profile “work”',
        overrode: [],
      },
      {
        variable: 'ANTHROPIC_BASE_URL',
        shape: { shape: 'literal' },
        from: 'this account',
        overrode: ['the base profile', 'the profile “work”'],
      },
    ]);
  });

  it('should apply ticked profiles in the order they were ticked, because the order is the precedence', () => {
    // Arrange — both set the same variable, and only the order decides which value a launch uses.
    const catalog = profileCatalog({
      profiles: [
        {
          name: 'first',
          appliesToEveryAccount: false,
          variables: [{ variable: 'ANTHROPIC_API_KEY', shape: { shape: 'secret', secrets: ['FIRST'] } }],
          accounts: [],
          authenticates: ['claude'],
        },
        {
          name: 'second',
          appliesToEveryAccount: false,
          variables: [{ variable: 'ANTHROPIC_API_KEY', shape: { shape: 'secret', secrets: ['SECOND'] } }],
          accounts: [],
          authenticates: ['claude'],
        },
      ],
    });

    // Act
    const forward = composedProfileEnv(catalog, profiled({ profiles: ['first', 'second'] }));
    const reversed = composedProfileEnv(catalog, profiled({ profiles: ['second', 'first'] }));

    // Assert
    expect(forward[0]).toMatchObject({ shape: { shape: 'secret', secrets: ['SECOND'] }, from: 'the profile “second”' });
    expect(reversed[0]).toMatchObject({ shape: { shape: 'secret', secrets: ['FIRST'] }, from: 'the profile “first”' });
  });

  it('should read the rows of the profile being WRITTEN from the draft, because no catalog knows them', () => {
    // Arrange — a name with no profile behind it is the one this change is declaring, and it comes last
    // in the order: it is the one somebody is composing right now.
    const draft = profiled({
      newProfile: {
        name: 'mine',
        variables: [
          profileRow({ id: 'a', from: 'secret', variable: 'ANTHROPIC_API_KEY', detail: 'NEW_KEY' }),
          profileRow({ id: 'b', from: 'environment', variable: 'HTTPS_PROXY', detail: 'OUTER_PROXY' }),
          profileRow({ id: 'c', from: 'value', variable: 'ANTHROPIC_BASE_URL', detail: 'https://gateway.invalid' }),
          // A row nobody has named yet contributes nothing rather than an empty variable.
          profileRow({ id: 'd', from: 'value', variable: '   ', detail: 'stray' }),
        ],
      },
    });

    // Act
    const actual = composedProfileEnv(profileCatalog({ profiles: [] }), draft);

    // Assert
    expect(actual).toEqual([
      {
        variable: 'ANTHROPIC_API_KEY',
        shape: { shape: 'secret', secrets: ['NEW_KEY'] },
        from: 'the profile “mine”',
        overrode: [],
      },
      {
        variable: 'ANTHROPIC_BASE_URL',
        shape: { shape: 'literal' },
        from: 'the profile “mine”',
        overrode: [],
      },
      {
        variable: 'HTTPS_PROXY',
        shape: { shape: 'environment-reference', variable: 'OUTER_PROXY' },
        from: 'the profile “mine”',
        overrode: [],
      },
    ]);
  });

  it('should contribute nothing for a name that is neither declared nor the one being written', () => {
    // Arrange — the ticked name belongs to no catalog entry and the authored profile is called
    // something else, so there are no rows to read and inventing one would be a value nobody set.
    const draft = profiled({
      profiles: ['ghost'],
      newProfile: { name: 'mine', variables: [profileRow({ variable: 'ANTHROPIC_API_KEY', detail: 'NEW_KEY' })] },
    });

    // Act
    const actual = composedProfileEnv(profileCatalog({ profiles: [] }), draft);

    // Assert — only the authored profile's own row, under its own name.
    expect(actual.map(row => `${row.variable} ${row.from}`)).toEqual(['ANTHROPIC_API_KEY the profile “mine”']);
  });

  it('should still show the base profile for a draft that signs in, and none of its ticks', () => {
    // Arrange — `base` is composed by every account whether it signs in or not, so hiding it would be
    // showing a composition with its first slot missing. The ticks are a different matter: `profiles`
    // holds what somebody chose before switching back to signing in, and `draftProfiles` answers
    // empty for a login — so the profile they had ticked composes nothing.
    const draft = complete({ profiles: ['work'] });

    // Act
    const actual = composedProfileEnv(profileCatalog(), draft);

    // Assert
    expect(actual).toEqual([
      { variable: 'ANTHROPIC_BASE_URL', shape: { shape: 'literal' }, from: 'the base profile', overrode: [] },
    ]);
  });

  it('should show the base profile even before a browser has read anything else', () => {
    // Arrange — an unread catalog cannot name a slot, so the account's own environment is all there is.
    const draft = profiled({ layer: layerWith({ env: [{ id: 'one', name: 'A_KEY', value: 'x' }] }) });

    // Act & Assert
    expect(composedProfileEnv(null, draft)).toEqual([
      { variable: 'A_KEY', shape: { shape: 'literal' }, from: 'this account', overrode: [] },
    ]);
  });
});

describe('profilesAlreadyBound', () => {
  it('should name the profiles the picked login already composes, so a tick’s reach is known first', () => {
    // Arrange — profiles belong to a provider LOGIN, so what somebody ticks here applies to every
    // account on it. `claude-studio` is the wrapper the fixture's login publishes.
    const draft = profiled({ name: 'studio' });

    // Act
    const actual = profilesAlreadyBound(profileCatalog(), draft, config());

    // Assert — `base` is absent: it is composed by every account and is not something a tick reaches.
    expect(actual).toEqual(['work']);
  });

  it('should name nothing for a login this fleet does not have yet', () => {
    expect(profilesAlreadyBound(profileCatalog(), profiled({ name: 'brand-new' }), config())).toEqual([]);
  });

  it('should name nothing when the configuration could not be read', () => {
    expect(profilesAlreadyBound(profileCatalog(), profiled({ name: 'studio' }), null)).toEqual([]);
  });
});

describe('toggleProfile', () => {
  it('should append a newly ticked profile, because a person ticking one wants it to win', () => {
    // Arrange & Act
    const actual = toggleProfile(profiled({ profiles: ['first'] }), 'second');

    // Assert — appended rather than inserted: the order IS the precedence.
    expect(actual.profiles).toEqual(['first', 'second']);
  });

  it('should remove a ticked profile and leave every other tick exactly where it was', () => {
    // Act
    const actual = toggleProfile(profiled({ profiles: ['first', 'second', 'third'] }), 'second');

    // Assert
    expect(actual.profiles).toEqual(['first', 'third']);
  });
});

describe('newProfileDraft', () => {
  it('should seed the row with the HOST’s credential variable for this harness', () => {
    // Arrange — the seed is `credentialVariables` travelling from the daemon. A browser hard-coding
    // ANTHROPIC_API_KEY would be a second copy of that table, and a second copy seeds a form whose
    // result the host does not consider a credential at all.
    const catalog = profileCatalog();

    // Act
    const claude = newProfileDraft(profiled(), catalog, 'row-id');
    const codex = newProfileDraft(profiled({ harness: 'codex' }), catalog, 'row-id');

    // Assert
    expect(claude.variables).toEqual([{ id: 'row-id', from: 'secret', variable: 'ANTHROPIC_API_KEY', detail: '' }]);
    expect(codex.variables[0]?.variable).toBe('OPENAI_API_KEY');
    expect(claude.name).toBe('');
  });

  it('should leave the variable box empty rather than guess one before the catalog is read', () => {
    expect(newProfileDraft(profiled(), null, 'row-id').variables[0]?.variable).toBe('');
  });
});

describe('the profile being written', () => {
  it('should carry it on the draft, and abandon it when there is none', () => {
    // Arrange
    const profile = { name: 'mine', variables: [profileRow()] };

    // Act & Assert — `undefined` is how the writing is abandoned, which is a different answer from a
    // profile with no rows: that one is a blocker somebody can still fix.
    expect(withNewProfile(profiled(), profile).newProfile).toEqual(profile);
    expect(withNewProfile(profiled({ newProfile: profile }), undefined).newProfile).toBeUndefined();
  });

  it('should replace one row in place and leave the others untouched', () => {
    // Arrange
    const profile = { name: 'mine', variables: [profileRow({ id: 'a' }), profileRow({ id: 'b', detail: 'B_KEY' })] };

    // Act
    const actual = withProfileVariable(profile, 'b', { from: 'value', detail: 'https://gateway.invalid' });

    // Assert — the id is a DOM identity and is never rewritten, or the row would lose its focus.
    expect(actual.variables).toEqual([
      { id: 'a', from: 'secret', variable: 'ANTHROPIC_API_KEY', detail: 'WORK_KEY' },
      { id: 'b', from: 'value', variable: 'ANTHROPIC_API_KEY', detail: 'https://gateway.invalid' },
    ]);
  });

  it('should add an empty row as a plain value, and remove the row it is asked for', () => {
    // Arrange — a new row is `value` rather than `secret`: the seeded first row is the credential, and
    // a second row is usually the base URL beside it.
    const profile = { name: 'mine', variables: [profileRow({ id: 'a' })] };

    // Act
    const added = withProfileVariableAdded(profile, 'b');
    const removed = withProfileVariableRemoved(added, 'a');

    // Assert
    expect(added.variables[1]).toEqual({ id: 'b', from: 'value', variable: '', detail: '' });
    expect(removed.variables.map(row => row.id)).toEqual(['b']);
  });
});
