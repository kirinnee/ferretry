/**
 * The built-in profiles `ferretry-claude` and `ferretry-codex` (runtimes plan U2): what a profile resolves to, that an
 * owner's own file wins, that an imported setup layers over them, and that they hold no permission.
 */
import { describe, expect, it } from 'bun:test';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { TEST_STARTERS } from '../../support/starters.ts';
import type { ProfileFile } from '../../../contract/index.ts';
import {
  AUTONOMOUS_INSTRUCTIONS,
  BUILTIN_COMPONENTS,
  COMFORT_SETTINGS,
  isBuiltinInstructions,
} from '../../../daemon/lib/account/builtin-autonomous.ts';
import { mergeImport, planImport } from '../../../daemon/lib/account/import-plan.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import {
  assembleRuntimesModel,
  NO_COMPONENTS,
  type RuntimesFiles,
} from '../../../daemon/lib/account/runtimes-model.ts';

const files = (overrides: Partial<RuntimesFiles> = {}): RuntimesFiles => ({
  runtimes: new Map(),
  profiles: new Map(),
  modelSets: new Map(),
  settings: undefined,
  logins: [sampleLogin('atomi', { store: 'ferretry' })],
  templates: new Map(),
  components: NO_COMPONENTS,
  starters: TEST_STARTERS,
  ...overrides,
});

describe('the built-in autonomous profiles', () => {
  it('should resolve Claude’s to its model set, the instructions and the comfort settings, with no permission', () => {
    const { model } = assembleRuntimesModel(files());

    const resolved = resolveProfile({
      model,
      profile: 'ferretry-claude',
      harness: 'claude',
      settingsBodies: { 'ferretry-claude-comfort': COMFORT_SETTINGS.document },
    });

    if (!resolved.ok) throw new Error('the built-in profile does not resolve');
    const { resolved: profile } = resolved;
    expect(profile.applied.map(layer => `${layer.componentKind}/${layer.name}`)).toEqual([
      'modelSets/ferretry-claude',
      'instructions/ferretry-work-alone',
      'settings/ferretry-claude-comfort',
    ]);
    expect(profile.instructions.map(each => each.component.text)).toEqual([AUTONOMOUS_INSTRUCTIONS]);
    expect(profile.settings.value).toEqual({ cleanupPeriodDays: 90 });
    expect(profile.env.BASH_DEFAULT_TIMEOUT_MS).toBeDefined();
    expect(profile.mcp).toEqual([]);
    expect(profile.skills).toEqual([]);
  });

  it('should resolve Codex’s to its model set and the instructions only', () => {
    const { model } = assembleRuntimesModel(files());

    const resolved = resolveProfile({ model, profile: 'ferretry-codex', harness: 'codex' });

    if (!resolved.ok) throw new Error('the built-in profile does not resolve');
    const { resolved: profile } = resolved;
    expect(profile.applied.map(layer => `${layer.componentKind}/${layer.name}`)).toEqual([
      'modelSets/ferretry-codex',
      'instructions/ferretry-work-alone',
    ]);
    expect(profile.settings.value).toEqual({});
  });

  it('should hold no permission, approval or sandbox key, in the instructions or in any setting', () => {
    const words = /permission|approval|sandbox|bypass|dangerously|skip/iu;

    expect(JSON.stringify(COMFORT_SETTINGS)).not.toMatch(words);
    expect(Object.keys(BUILTIN_COMPONENTS.settings)).toEqual(['ferretry-claude-comfort']);
    expect(AUTONOMOUS_INSTRUCTIONS).not.toMatch(/bypass|dangerously|--sandbox/iu);
  });

  it('should give way to an owner’s own file of the same name, for the profile and for each component', () => {
    const mine = { contents: ['modelSets/ferretry-claude'] } as ProfileFile;
    const { model } = assembleRuntimesModel(
      files({
        profiles: new Map([['ferretry-claude', mine]]),
        components: {
          ...NO_COMPONENTS,
          instructions: { state: 'read', components: new Map([['ferretry-work-alone', { text: 'Mine.\n' }]]) },
        },
      }),
    );

    expect(model.profiles['ferretry-claude']?.layers).toEqual(['modelSets/ferretry-claude']);
    expect(model.components.instructions['ferretry-work-alone']).toEqual({ text: 'Mine.\n' });
    // The other harness's built-in profile is still the built-in one, and now reads the owner's instructions.
    expect(model.profiles['ferretry-codex']?.layers).toContain('instructions/ferretry-work-alone');
  });

  it('should not call a built-in component unread when its owner could not be read', () => {
    const { model, notices } = assembleRuntimesModel(
      files({
        components: { ...NO_COMPONENTS, settings: { state: 'unread', reason: 'Claude Code is not running' } },
      }),
    );

    expect(model.components.settings['ferretry-claude-comfort']?.document).toEqual({ cleanupPeriodDays: 90 });
    expect(notices.join(' ')).not.toContain('ferretry-claude-comfort');
  });

  it('should sit UNDER an imported setup, so the owner’s own words come last and win', () => {
    // Arrange — a machine with no files and nothing found: the Starter names the built-in profile as its oldest layer.
    const plan = planImport([], { kits: undefined, digest: text => text, starters: TEST_STARTERS });

    // Act — an empty plan has nothing to merge; a Claude host with nothing in it makes the Starter.
    expect(plan.profiles).toEqual({});
    const merged = mergeImport(undefined, {
      ...plan,
      profiles: { 'claude-starter': { layers: ['profile/ferretry-claude', 'modelSets/claude-models'] } },
      components: [
        {
          kind: 'modelSets',
          name: 'claude-models',
          value: { models: [TEST_STARTERS.claude], default: TEST_STARTERS.claude },
        },
      ],
      runtimes: {},
    } as unknown as typeof plan);

    // Assert — the merged model is valid with no files at all (the built-in profile was there to name), and the
    // built-in is the oldest layer.
    expect(merged.profiles['claude-starter']?.layers[0]).toBe('profile/ferretry-claude');
    const resolved = resolveProfile({ model: merged, profile: 'claude-starter', harness: 'claude' });
    if (!resolved.ok) throw new Error('the starter does not resolve');
    const { resolved: profile } = resolved;
    expect(profile.applied.at(-1)?.name).toBe('claude-models');
    expect(profile.instructions.map(each => each.component.text)).toEqual([AUTONOMOUS_INSTRUCTIONS]);
  });
});

describe('what counts as the built-in text', () => {
  it('should be the built-in name with its own words only, never an owner’s component of the same name', () => {
    expect(isBuiltinInstructions('ferretry-work-alone', AUTONOMOUS_INSTRUCTIONS)).toBe(true);
    expect(isBuiltinInstructions('ferretry-work-alone', 'Mine.\n')).toBe(false);
    expect(isBuiltinInstructions('main', AUTONOMOUS_INSTRUCTIONS)).toBe(false);
    expect(isBuiltinInstructions('ferretry-work-alone', undefined)).toBe(false);
  });

  it('should read the same in an autonomous and an interactive launch', () => {
    // The wrapper exports one home for both modes, so the file may not say nobody is watching, nor repeat the launch parts' routing.
    expect(AUTONOMOUS_INSTRUCTIONS).not.toMatch(/unattended|nobody|no one|agenda|sub-ferret|lead\b/iu);
  });
});
