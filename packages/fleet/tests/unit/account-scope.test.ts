import { describe, it } from 'bun:test';
import should from 'should';
import { type AccountModel, parseAccountModel } from '../../src/lib/account/schema.ts';
import {
  componentScope,
  describeScopeConflict,
  HARNESS_SCOPE_WORDS,
  layersScope,
  layerWords,
  modelSetScope,
  newlyMisfitRuntimes,
  newlyMixedProfiles,
  profileScope,
  runtimeHarness,
  scopeFits,
} from '../../src/lib/account/scope.ts';

/** A machine with one component of every scope, and profiles built from them. */
const model = (profiles: Record<string, { layers: string[] }>, runtimes: Record<string, unknown> = {}): AccountModel =>
  parseAccountModel({
    version: 2,
    credentials: {
      'claude-you': { harness: 'claude', store: 'host' },
      'codex-you': { harness: 'codex', store: 'host' },
    },
    components: {
      instructions: { main: { file: 'main.md' }, 'claude-notes': { file: 'c.md', harness: 'claude' } },
      mcp: { github: { command: 'gh' }, linear: { url: 'https://x.example/sse', harness: 'codex' } },
      skills: { mine: { items: ['a'] }, 'codex-skills': { items: ['b'], harness: 'codex' } },
      settings: {
        'claude-settings': { harness: 'claude', flags: ['--x'] },
        'codex-settings': { harness: 'codex', flags: ['--y'] },
      },
      hooks: { guard: { harness: 'claude', file: 'h.json' } },
      modelSets: {
        'claude-models': { models: ['claude-opus-5-5', 'opus'], default: 'opus' },
        'codex-models': { models: ['gpt-6'], default: 'gpt-6' },
        both: { models: ['claude-opus-5-5', 'gpt-6'], default: 'gpt-6' },
        unknown: { models: ['llama-9'], default: 'llama-9' },
      },
    },
    profiles,
    runtimes,
  });

describe('component scope', () => {
  it('should be the harness a component names, else generic', () => {
    const { components } = model({});
    should(componentScope('instructions', components.instructions.main)).equal('generic');
    should(componentScope('instructions', components.instructions['claude-notes'])).equal('claude');
    should(componentScope('mcp', components.mcp.linear)).equal('codex');
    should(componentScope('settings', components.settings['claude-settings'])).equal('claude');
    should(componentScope('hooks', components.hooks.guard)).equal('claude');
    should(componentScope('skills', undefined)).equal('generic');
  });

  it("should read a model set's scope from its ids: one harness only, else generic", () => {
    should(modelSetScope({ models: ['claude-opus-5-5', 'sonnet[1m]'] })).equal('claude');
    should(modelSetScope({ models: ['gpt-6', 'o4-mini'] })).equal('codex');
    should(modelSetScope({ models: ['claude-opus-5-5', 'gpt-6'] })).equal('generic');
    should(modelSetScope({ models: ['llama-9'] })).equal('generic');
    should(componentScope('modelSets', { models: ['gpt-6'], default: 'gpt-6' })).equal('codex');
  });

  it('should fit a login when generic or of its harness', () => {
    should(scopeFits('generic', 'claude')).be.true();
    should(scopeFits('claude', 'claude')).be.true();
    should(scopeFits('codex', 'claude')).be.false();
    should(HARNESS_SCOPE_WORDS).deepEqual({ generic: 'Generic', claude: 'Claude only', codex: 'Codex only' });
  });
});

describe('profile scope', () => {
  it('should be generic when every layer is', () => {
    const catalogue = model({
      base: { layers: ['instructions/main', 'mcp/github', 'modelSets/both', 'modelSets/unknown'] },
    });
    should(profileScope(catalogue, 'base')).deepEqual({ kind: 'scoped', scope: 'generic' });
  });

  it('should be Claude only when generic and Claude-only layers meet', () => {
    const catalogue = model({ work: { layers: ['instructions/main', 'settings/claude-settings'] } });
    should(profileScope(catalogue, 'work')).deepEqual({ kind: 'scoped', scope: 'claude' });
  });

  it('should be Codex only through a Codex-only skill', () => {
    const catalogue = model({ work: { layers: ['skills/mine', 'skills/codex-skills'] } });
    should(profileScope(catalogue, 'work')).deepEqual({ kind: 'scoped', scope: 'codex' });
  });

  it('should inherit the scope of a base profile it imports', () => {
    const catalogue = model({
      claude: { layers: ['hooks/guard'] },
      agent: { layers: ['profile/claude', 'instructions/main'] },
    });
    should(profileScope(catalogue, 'agent')).deepEqual({ kind: 'scoped', scope: 'claude' });
  });

  it('should be mixed when Claude-only and Codex-only layers meet, naming the first of each', () => {
    const catalogue = model({
      mixed: { layers: ['instructions/main', 'settings/claude-settings', 'mcp/linear', 'settings/codex-settings'] },
    });
    should(profileScope(catalogue, 'mixed')).deepEqual({
      kind: 'mixed',
      claude: 'settings/claude-settings',
      codex: 'mcp/linear',
    });
  });

  it('should be mixed when a base is, naming that base on both sides', () => {
    const catalogue = model({
      legacy: { layers: ['settings/claude-settings', 'settings/codex-settings'] },
      top: { layers: ['profile/legacy', 'instructions/main'] },
    });
    should(profileScope(catalogue, 'top')).deepEqual({
      kind: 'mixed',
      claude: 'profile/legacy',
      codex: 'profile/legacy',
    });
  });

  it('should read an unknown layer, an unknown base and a loop as generic rather than throwing', () => {
    const catalogue = model({ a: { layers: ['instructions/main'] } });
    const looping = {
      ...catalogue,
      profiles: { a: { layers: ['profile/b'] }, b: { layers: ['profile/a'] } },
    } as AccountModel;
    should(layersScope(catalogue, ['nonsense', 'mcp/missing', 'profile/missing'])).deepEqual({
      kind: 'scoped',
      scope: 'generic',
    });
    should(profileScope(looping, 'a')).deepEqual({ kind: 'scoped', scope: 'generic' });
    should(profileScope(catalogue, 'nobody')).deepEqual({ kind: 'scoped', scope: 'generic' });
  });
});

describe('describeScopeConflict', () => {
  it('should name the profile and both layers in one sentence', () => {
    should(
      describeScopeConflict(
        { kind: 'mixed', claude: 'settings/claude-settings', codex: 'modelSets/codex-models' },
        'work',
      ),
    ).equal(
      "Profile work can't be both Claude only and Codex only: settings claude-settings is Claude only and model set codex-models is Codex only.",
    );
  });

  it('should say "A profile" for a draft and name a mixed base once', () => {
    should(describeScopeConflict({ kind: 'mixed', claude: 'profile/legacy', codex: 'profile/legacy' })).equal(
      "A profile can't be both Claude only and Codex only: profile legacy already mixes Claude only and Codex only layers.",
    );
  });

  it('should say a layer it cannot read as it was written', () => {
    should(layerWords('nonsense')).equal('nonsense');
    should(layerWords('profile/base')).equal('profile base');
  });
});

describe('newlyMixedProfiles', () => {
  it('should report a profile a change made mixed, and leave one that already was', () => {
    const before = model({
      legacy: { layers: ['settings/claude-settings', 'settings/codex-settings'] },
      work: { layers: ['settings/claude-settings', 'mcp/github'] },
    });
    const after = {
      ...before,
      components: {
        ...before.components,
        mcp: { ...before.components.mcp, github: { command: 'gh', harness: 'codex' } },
      },
      profiles: { ...before.profiles, fresh: { layers: ['hooks/guard', 'mcp/linear'] } },
    } as AccountModel;
    should(newlyMixedProfiles(before, after)).deepEqual(['fresh', 'work']);
  });
});

describe('newlyMisfitRuntimes', () => {
  it("should report a runtime whose profile a change made the other harness's only", () => {
    const before = model(
      { tools: { layers: ['mcp/github'] }, codexy: { layers: ['mcp/linear'] } },
      {
        'claude-tools': { credential: 'claude-you', profile: 'tools' },
        'claude-odd': { credential: 'claude-you', profile: 'codexy' },
        'codex-tools': { credential: 'codex-you', profile: 'tools' },
      },
    );
    const after = {
      ...before,
      components: {
        ...before.components,
        mcp: { ...before.components.mcp, github: { command: 'gh', harness: 'codex' } },
      },
    } as AccountModel;
    should(newlyMisfitRuntimes(before, after)).deepEqual([
      { runtime: 'claude-tools', profile: 'tools', harness: 'claude', scope: 'codex' },
    ]);
  });

  it('should skip a runtime whose login or profile is missing, and one on a mixed profile', () => {
    const base = model(
      { legacy: { layers: ['settings/claude-settings', 'settings/codex-settings'] } },
      { 'claude-legacy': { credential: 'claude-you', profile: 'legacy' } },
    );
    const broken = {
      ...base,
      runtimes: { ...base.runtimes, ghost: { credential: 'nobody', profile: 'legacy', agent: false } },
    } as AccountModel;
    should(newlyMisfitRuntimes(base, broken)).deepEqual([]);
  });

  it('should leave a runtime on a dual login fitting either way, since it always fits one of them', () => {
    // Arrange — "glm" drives both CLIs; narrowing its profile to Codex only still fits (D)
    const parsed = model(
      { tools: { layers: ['mcp/github'] } },
      { 'claude-tools': { credential: 'claude-you', profile: 'tools' } },
    );
    const before = {
      ...parsed,
      credentials: {
        ...parsed.credentials,
        glm: {
          harness: 'claude',
          store: 'environment',
          claude: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:S}' } },
          codex: { env: { OPENROUTER_API_KEY: '${secret:S}' } },
        },
      },
      runtimes: { glm: { credential: 'glm', profile: 'tools', agent: false } },
    } as AccountModel;
    const after = {
      ...before,
      components: {
        ...before.components,
        mcp: { ...before.components.mcp, github: { command: 'gh', harness: 'codex' } },
      },
    } as AccountModel;
    should(newlyMisfitRuntimes(before, after)).deepEqual([]);
  });
});

describe('runtimeHarness', () => {
  const dual = model(
    { claudeScoped: { layers: ['settings/claude-settings'] }, codexScoped: { layers: ['settings/codex-settings'] } },
    {},
  );
  const withCredentials = (credentials: AccountModel['credentials']): AccountModel => ({ ...dual, credentials });

  it("should be a runtime's own harness when it names one", () => {
    const withGlm = withCredentials({
      ...dual.credentials,
      glm: {
        harness: 'claude',
        store: 'environment',
        claude: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:S}' } },
        codex: { env: { OPENROUTER_API_KEY: '${secret:S}' } },
      },
    });
    should(runtimeHarness(withGlm, { credential: 'glm', profile: 'claudeScoped', harness: 'codex' })).equal('codex');
  });

  it("should follow a dual login's profile scope when the runtime names none", () => {
    const withGlm = withCredentials({
      ...dual.credentials,
      glm: {
        harness: 'claude',
        store: 'environment',
        claude: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:S}' } },
        codex: { env: { OPENROUTER_API_KEY: '${secret:S}' } },
      },
    });
    should(runtimeHarness(withGlm, { credential: 'glm', profile: 'codexScoped' })).equal('codex');
    should(runtimeHarness(withGlm, { credential: 'glm', profile: 'claudeScoped' })).equal('claude');
  });

  it("should fall back to the login's own harness when a dual login's profile is generic", () => {
    const withGlm = withCredentials({
      ...dual.credentials,
      glm: {
        harness: 'claude',
        store: 'environment',
        claude: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:S}' } },
        codex: { env: { OPENROUTER_API_KEY: '${secret:S}' } },
      },
    });
    should(runtimeHarness(withGlm, { credential: 'glm', profile: 'default' })).equal('claude');
  });

  it("should be a one-CLI login's own harness regardless of profile", () => {
    should(runtimeHarness(dual, { credential: 'claude-you', profile: 'codexScoped' })).equal('claude');
  });

  it('should be undefined for a runtime whose login does not exist', () => {
    should(runtimeHarness(dual, { credential: 'nobody', profile: 'default' })).be.undefined();
  });
});
