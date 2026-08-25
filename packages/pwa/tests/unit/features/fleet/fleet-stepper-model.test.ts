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
  authoredSkill,
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
  newSkillProblem,
  nextStep,
  openingInstructionsSource,
  PICK_OR_ADD_LABEL,
  otherLanes,
  previousStep,
  selectedModels,
  authoredSettings,
  inlineSettings,
  newSettingsProblem,
  settingsFormatNote,
  settingsOrigins,
  settingsPathFor,
  settingsPaths,
  settingsStoreItems,
  unreadSettings,
  SKILL_DOCUMENT,
  skillsSelection,
  SKILLS_PREFIX,
  skillsStoreItems,
  stepCopy,
  stepIndex,
  stepProblems,
  toggleModel,
  unverifiedModels,
  withAuthoredSkillText,
  withInstructionsMiddle,
  withNewSkill,
  selectedModes,
  toggleMode,
  withLaneVariant,
  withModes,
  withModels,
  withInlineSettings,
  withNewSettings,
  withoutSettings,
  withSettingsMoved,
  withSettingsText,
  withStoreSettings,
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

describe('the settings this fleet has', () => {
  it('offers the registry AND what accounts already apply, canonicalising the ./ spelling', () => {
    const items = settingsStoreItems({
      variants: {},
      // The `./` spelling `fy fleet init` scaffolds. One name is registered and never applied; one
      // document is applied by an account and never registered; one is both.
      shared: { settings: { claude: './templates/claude/settings.json', spare: './templates/claude/spare.json' } },
      agents: [
        {
          name: 'studio',
          kind: 'claude',
          routes: {
            default: {
              id: 'a',
              wrapper: 'claude-studio',
              layer: { settings: ['./templates/claude/settings.json', 'templates/claude/strict.json'] },
            },
            auto: { id: 'b', wrapper: 'claude-auto-studio', layer: { settings: 'templates/claude/strict.json' } },
          },
        },
      ],
    });
    expect(items).toEqual([
      {
        path: 'templates/claude/settings.json',
        name: 'claude',
        accounts: ['claude-studio'],
      },
      { path: 'templates/claude/spare.json', name: 'spare', accounts: [] },
      { path: 'templates/claude/strict.json', accounts: ['claude-studio', 'claude-auto-studio'] },
    ]);
  });

  it('offers a declared document a browser could never send as refused, rather than dropping it', () => {
    const items = settingsStoreItems({
      variants: {},
      shared: { settings: { odd: '~/settings.json' } },
      agents: [],
    });
    // Listed, disabled, and the reason is on it. Dropping it would tell somebody their fleet names no
    // settings documents while its configuration names one.
    expect(items).toHaveLength(1);
    expect(items[0]?.refusal).toContain('must be relative to the asset directory');
  });

  it('reads no store at all from a fleet whose configuration could not be read', () => {
    expect(settingsStoreItems(null)).toHaveLength(0);
    expect(settingsStoreItems({ variants: {}, agents: [] })).toHaveLength(0);
  });

  it('puts the name and the parser side by side when they disagree, and says nothing when they agree', () => {
    // The trap is the DEFAULT one: `fy fleet init` registers one document per harness and this step
    // offers both, so a Claude account is offered a `config.toml` that would be parsed as JSON.
    expect(settingsFormatNote('templates/codex/config.toml', 'claude')).toBe(
      'Named .toml, and a claude account reads its settings as JSON.',
    );
    expect(settingsFormatNote('templates/claude/settings.json', 'codex')).toBe(
      'Named .json, and a codex account reads its settings as TOML.',
    );
    expect(settingsFormatNote('templates/claude/settings.json', 'claude')).toBeNull();
    expect(settingsFormatNote('templates/codex/config.toml', 'codex')).toBeNull();
    // A path with no extension has no name to quote, and a dot in a DIRECTORY is not an extension.
    expect(settingsFormatNote('templates/claude/settings', 'claude')).toBe(
      'Named with no extension, and a claude account reads its settings as JSON.',
    );
    expect(settingsFormatNote('templates/v1.2/settings', 'claude')).toBe(
      'Named with no extension, and a claude account reads its settings as JSON.',
    );
  });
});

describe('the settings a person composes', () => {
  it('appends what is ticked, so selection order IS the order that applies', () => {
    const one = withStoreSettings(layerWith(), 'templates/claude/a.json', '1');
    const two = withStoreSettings(one, 'templates/claude/b.json', '2');
    expect(settingsPaths(two)).toEqual(['templates/claude/a.json', 'templates/claude/b.json']);
    // Unticking removes that one and leaves every other entry where it was.
    expect(settingsPaths(withStoreSettings(two, 'templates/claude/a.json', '3'))).toEqual(['templates/claude/b.json']);
  });

  it('derives a new document path from the harness, because the extension decides the parser', () => {
    expect(settingsPathFor('claude', 'strict')).toBe('templates/claude/strict.json');
    expect(settingsPathFor('codex', 'strict')).toBe('templates/codex/strict.toml');
    expect(settingsPathFor('claude', '  ')).toBe('');
    const added = withNewSettings(layerWith(), 'claude', 'strict', '1');
    expect(added.settings).toEqual([{ id: '1', source: 'new', path: 'templates/claude/strict.json', text: '{}\n' }]);
    // A Codex document is TOML, so it is NOT seeded with an empty JSON object.
    expect(withNewSettings(layerWith(), 'codex', 'strict', '1').settings[0]?.text).toBe('');
  });

  it('takes exactly one block of settings typed here', () => {
    const one = withInlineSettings(layerWith(), '1');
    expect(one.settings).toEqual([{ id: '1', source: 'inline', path: '', text: '{}' }]);
    // A second is refused by returning the same layer: two anonymous entries are indistinguishable in
    // the list a person reorders, and whatever the second would say goes in the first.
    expect(withInlineSettings(one, '2')).toBe(one);
    expect(inlineSettings(one)?.id).toBe('1');
    expect(inlineSettings(layerWith())).toBeUndefined();
  });

  it('moves one entry a place at a time and stops at either end', () => {
    const stack = layerWith({
      settings: [
        { id: 'a', source: 'store', path: 'templates/claude/a.json', text: '' },
        { id: 'b', source: 'store', path: 'templates/claude/b.json', text: '' },
        { id: 'c', source: 'inline', path: '', text: '{}' },
      ],
    });
    expect(withSettingsMoved(stack, 'c', -1).settings.map(entry => entry.id)).toEqual(['a', 'c', 'b']);
    expect(withSettingsMoved(stack, 'a', -1)).toBe(stack);
    expect(withSettingsMoved(stack, 'c', 1)).toBe(stack);
    expect(withSettingsMoved(stack, 'nope', 1)).toBe(stack);
    expect(withoutSettings(stack, 'b').settings.map(entry => entry.id)).toEqual(['a', 'c']);
    expect(withSettingsText(stack, 'c', '{"model":"opus"}').settings[2]?.text).toBe('{"model":"opus"}');
    expect(withSettingsText(stack, 'nope', 'x').settings).toEqual(stack.settings);
    expect(authoredSettings(stack)).toHaveLength(0);
  });

  it('refuses a new name that collides, and redirects the one that is already in the store', () => {
    const store = settingsStoreItems({
      variants: {},
      shared: { settings: { claude: 'templates/claude/settings.json' } },
      agents: [],
    });
    const held = withNewSettings(layerWith(), 'claude', 'strict', '1');
    expect(newSettingsProblem('', 'claude', store, held)).toBe('name this document');
    expect(newSettingsProblem(' strict ', 'claude', store, held)).toContain('must not start or end with a space');
    expect(newSettingsProblem('a/b', 'claude', store, held)).toContain('path separator');
    expect(newSettingsProblem('settings', 'claude', store, held)).toContain('tick it above to apply it');
    expect(newSettingsProblem('strict', 'claude', store, held)).toBe(
      '"templates/claude/strict.json" is already listed',
    );
    expect(
      newSettingsProblem('own', 'claude', store, {
        ...layerWith(),
        instructions: { path: 'templates/claude/own.json', text: '# hi' },
      }),
    ).toContain('is already written by this change');
    expect(newSettingsProblem('strict', 'claude', store, layerWith())).toBeNull();
  });
});

describe('which entry decided each key', () => {
  const stacked = (...entries: readonly { source: 'store' | 'new' | 'inline'; path: string; text: string }[]) =>
    layerWith({ settings: entries.map((entry, index) => ({ id: String(index), ...entry })) });

  it('folds the known entries by the rule the daemon merges them by, and a later one wins', () => {
    const layer = stacked(
      { source: 'new', path: 'templates/claude/base.json', text: '{"model":"sonnet","permissions":{"allow":["a"]}}' },
      { source: 'inline', path: '', text: '{"model":"opus","permissions":{"deny":["b"]}}' },
    );
    expect(settingsOrigins(layer, 'claude')).toEqual([
      { key: 'model', from: 'typed here' },
      // A nested object MERGES key by key, so both survive and each names the entry that set it.
      { key: 'permissions.allow', from: 'templates/claude/base.json' },
      { key: 'permissions.deny', from: 'typed here' },
    ]);
  });

  it('lets a scalar replace a whole subtree, because that is what the merge does', () => {
    const layer = stacked(
      { source: 'inline', path: '', text: '{"permissions":{"allow":["a"]}}' },
      { source: 'new', path: 'templates/claude/late.json', text: '{"permissions":"off"}' },
    );
    expect(settingsOrigins(layer, 'claude')).toEqual([{ key: 'permissions', from: 'templates/claude/late.json' }]);
  });

  it('lets an object replace a scalar the other way round', () => {
    const layer = stacked(
      { source: 'inline', path: '', text: '{"permissions":"off"}' },
      { source: 'new', path: 'templates/claude/late.json', text: '{"permissions":{"allow":["a"]}}' },
    );
    expect(settingsOrigins(layer, 'claude')).toEqual([
      { key: 'permissions.allow', from: 'templates/claude/late.json' },
    ]);
  });

  it('says which entries it has not read rather than passing a short key list off as the answer', () => {
    const layer = stacked(
      { source: 'store', path: 'templates/claude/shared.json', text: '' },
      { source: 'inline', path: '', text: '{"model":"opus"}' },
      { source: 'new', path: 'templates/codex/late.toml', text: 'model = "gpt-5.6"' },
    );
    // For CODEX the authored document is TOML, which this browser has no parser for.
    expect(settingsOrigins(layer, 'codex').map(origin => origin.key)).toEqual(['model']);
    expect(unreadSettings(layer, 'codex')).toEqual(['templates/claude/shared.json', 'templates/codex/late.toml']);
    // Told no harness at all, an authored document is unread for the same reason — there is no parser
    // to name. The entry TYPED HERE still reads, because an inline entry is JSON whichever harness
    // ends up reading it: the daemon serialises it into that harness's own format.
    expect(unreadSettings(layer, null)).toEqual(['templates/claude/shared.json', 'templates/codex/late.toml']);
    expect(settingsOrigins(layer, null).map(origin => origin.key)).toEqual(['model']);
    // An entry a person is still typing into contributes nothing and is not an error.
    expect(settingsOrigins(stacked({ source: 'inline', path: '', text: '{ not json' }), 'claude')).toHaveLength(0);
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
      complete({ layer: layerWith({ settings: [{ id: '1', source: 'inline', path: '', text: '{ not json' }] }) }),
      complete({ layer: layerWith({ settings: [{ id: '1', source: 'inline', path: '', text: '[1]' }] }) }),
      complete({ layer: layerWith({ settings: [{ id: '1', source: 'inline', path: '', text: '  ' }] }) }),
      complete({ layer: layerWith({ settings: [{ id: '1', source: 'store', path: '/etc/x.json', text: '' }] }) }),
      complete({ layer: layerWith({ settings: [{ id: '1', source: 'store', path: '', text: '' }] }) }),
      complete({
        layer: layerWith({
          settings: [
            { id: '1', source: 'store', path: 'templates/claude/a.json', text: '' },
            { id: '2', source: 'store', path: 'templates/claude/a.json', text: '' },
          ],
        }),
      }),
      // A settings document this change WRITES over the instructions file. The sentence is claimed by
      // the instructions step, which is the one whose field a person most likely mistyped.
      complete({
        layer: layerWith({
          instructions: { path: 'instructions/CLAUDE-x.md', text: '# hi' },
          settings: [{ id: '1', source: 'new', path: 'instructions/CLAUDE-x.md', text: '{}' }],
        }),
      }),
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
