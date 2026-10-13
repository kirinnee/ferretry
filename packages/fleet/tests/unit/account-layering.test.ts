import { describe, it } from 'bun:test';
import should from 'should';
import {
  type Conflict,
  describeConflict,
  type FlatLayer,
  flattenProfile,
  modelHarness,
  pathsOverlap,
  type ResolvedProfile,
  type ResolveInput,
  resolveProfile,
  sameSettingsValue,
  settingsKey,
  settingsLeaves,
} from '../../src/lib/account/layering.ts';
import { type AccountModel, parseAccountModel } from '../../src/lib/account/schema.ts';

/** A parsed model with exactly the components and profiles a test is about. */
const modelWith = (components: Record<string, unknown>, profiles: Record<string, unknown>): AccountModel =>
  parseAccountModel({ version: 2, components, profiles });

/** A catalogue the schema would refuse, for the total-function cases it cannot reach. */
const rawCatalogue = (components: Record<string, unknown>, profiles: Record<string, unknown>) =>
  ({
    components: { instructions: {}, mcp: {}, skills: {}, settings: {}, hooks: {}, modelSets: {}, ...components },
    profiles,
  }) as unknown as Pick<AccountModel, 'components' | 'profiles'>;

const resolved = (input: ResolveInput): ResolvedProfile => {
  const result = resolveProfile(input);
  if (!result.ok) throw new Error(`expected a resolution, got ${JSON.stringify(result.failure)}`);
  return result.resolved;
};

const refs = (layers: readonly FlatLayer[]) => layers.map(layer => layer.reference);

const instructions = (...names: string[]) =>
  Object.fromEntries(names.map(name => [name, { file: `components/instructions/${name}.md` }]));

describe('modelHarness', () => {
  it.each([
    ['claude-opus-5-5', 'claude'],
    ['claude-opus-5-5[1m]', 'claude'],
    ['Claude-Sonnet-5', 'claude'],
    ['opus', 'claude'],
    ['sonnet[1m]', 'claude'],
    ['haiku', 'claude'],
    ['fable', 'claude'],
    ['opusplan', 'claude'],
    ['gpt-6', 'codex'],
    ['gpt-5.6-codex', 'codex'],
    ['codex-mini-latest', 'codex'],
    ['o3', 'codex'],
    ['o4-mini', 'codex'],
  ])('should say %p belongs to %p', (id, harness) => {
    // Assert
    should(modelHarness(id)).equal(harness);
  });

  it.each(['llama-4', 'gemini-3', 'claudeish', 'gpt', 'oxford', ''])('should say %p belongs to no harness', id => {
    // Assert
    should(modelHarness(id)).be.undefined();
  });
});

describe('flattenProfile', () => {
  it('should list a profile of components oldest first, each from itself', () => {
    // Arrange
    const model = modelWith(
      { instructions: instructions('a', 'b') },
      { p: { layers: ['instructions/a', 'instructions/b'] } },
    );

    // Act
    const actual = flattenProfile(model, 'p');

    // Assert
    should(actual).deepEqual({
      ok: true,
      layers: [
        { reference: 'instructions/a', componentKind: 'instructions', name: 'a', origin: 'instructions/a', via: [] },
        { reference: 'instructions/b', componentKind: 'instructions', name: 'b', origin: 'instructions/b', via: [] },
      ],
    });
  });

  it('should expand a base where it stands and name the base it came through', () => {
    // Arrange — §5.2: agent-work = default, then agent on top
    const model = modelWith(
      { instructions: instructions('main', 'agent', 'top') },
      {
        default: { layers: ['instructions/main'] },
        agent: { layers: ['instructions/agent'] },
        inner: { layers: ['profile/agent'] },
        'agent-work': { layers: ['profile/default', 'profile/inner', 'instructions/top'] },
      },
    );

    // Act
    const actual = flattenProfile(model, 'agent-work');

    // Assert
    should(actual.ok).be.true();
    const layers = actual.ok ? actual.layers : [];
    should(refs(layers)).deepEqual(['instructions/main', 'instructions/agent', 'instructions/top']);
    should(layers.map(layer => [layer.origin, layer.via])).deepEqual([
      ['profile/default', ['default']],
      ['profile/inner', ['inner', 'agent']],
      ['instructions/top', []],
    ]);
  });

  it('should keep a component reached twice once, at its newest position', () => {
    // Arrange — P2
    const model = modelWith(
      { instructions: instructions('a', 'b') },
      { base: { layers: ['instructions/a', 'instructions/b'] }, p: { layers: ['profile/base', 'instructions/a'] } },
    );

    // Act
    const actual = flattenProfile(model, 'p');

    // Assert
    should(actual.ok && refs(actual.layers)).deepEqual(['instructions/b', 'instructions/a']);
    should(actual.ok && actual.layers[1]?.origin).equal('instructions/a');
  });

  it('should keep a base reached twice once, at its newest position', () => {
    // Arrange
    const model = modelWith(
      { instructions: instructions('a', 'b') },
      { base: { layers: ['instructions/a'] }, p: { layers: ['profile/base', 'instructions/b', 'profile/base'] } },
    );

    // Act
    const actual = flattenProfile(model, 'p');

    // Assert
    should(actual.ok && refs(actual.layers)).deepEqual(['instructions/b', 'instructions/a']);
  });

  it('should flatten an empty profile to nothing', () => {
    // Act
    const actual = flattenProfile(modelWith({}, { empty: {} }), 'empty');

    // Assert
    should(actual).deepEqual({ ok: true, layers: [] });
  });

  it('should refuse a profile that includes itself directly', () => {
    // Arrange — P3, E19
    const catalogue = rawCatalogue({}, { a: { layers: ['profile/a'] } });

    // Act
    const actual = flattenProfile(catalogue, 'a');

    // Assert
    should(actual).deepEqual({ ok: false, failure: { kind: 'loop', cycle: ['a', 'a'] } });
  });

  it('should refuse a profile that includes itself through a base, naming the cycle', () => {
    // Arrange
    const catalogue = rawCatalogue(
      {},
      { top: { layers: ['profile/a'] }, a: { layers: ['profile/b'] }, b: { layers: ['profile/a'] } },
    );

    // Act
    const actual = flattenProfile(catalogue, 'top');

    // Assert
    should(actual).deepEqual({ ok: false, failure: { kind: 'loop', cycle: ['a', 'b', 'a'] } });
  });

  it('should refuse an unknown profile', () => {
    // Act
    const actual = flattenProfile(rawCatalogue({}, {}), 'ghost');

    // Assert
    should(actual).deepEqual({ ok: false, failure: { kind: 'unknown-profile', profile: 'ghost', via: [] } });
  });

  it('should refuse an unknown base, naming the bases it was reached through', () => {
    // Arrange
    const catalogue = rawCatalogue({}, { p: { layers: ['profile/mid'] }, mid: { layers: ['profile/ghost'] } });

    // Act
    const actual = flattenProfile(catalogue, 'p');

    // Assert
    should(actual).deepEqual({ ok: false, failure: { kind: 'unknown-profile', profile: 'ghost', via: ['mid'] } });
  });

  it('should refuse an unknown component', () => {
    // Arrange
    const catalogue = rawCatalogue({}, { p: { layers: ['profile/mid'] }, mid: { layers: ['skills/ghost'] } });

    // Act
    const actual = flattenProfile(catalogue, 'p');

    // Assert
    should(actual).deepEqual({
      ok: false,
      failure: { kind: 'unknown-component', reference: 'skills/ghost', via: ['mid'] },
    });
  });

  it('should refuse text that is not a layer', () => {
    // Act
    const actual = flattenProfile(rawCatalogue({}, { p: { layers: ['nonsense'] } }), 'p');

    // Assert
    should(actual).deepEqual({ ok: false, failure: { kind: 'invalid-layer', text: 'nonsense', via: [] } });
  });
});

describe('resolveProfile — failures and applicability', () => {
  it('should pass a flattening failure through', () => {
    // Act
    const actual = resolveProfile({ model: rawCatalogue({}, {}), profile: 'ghost', harness: 'claude' });

    // Assert
    should(actual).deepEqual({ ok: false, failure: { kind: 'unknown-profile', profile: 'ghost', via: [] } });
  });

  it('should call an empty profile unavailable', () => {
    // Act
    const actual = resolved({ model: modelWith({}, { empty: {} }), profile: 'empty', harness: 'codex' });

    // Assert
    should(actual.availability).deepEqual({ available: false, reason: 'empty' });
    should(actual.modelSet).deepEqual({ source: 'harness-default' });
  });

  it('should skip the other harness and call a profile with nothing left unavailable', () => {
    // Arrange — E14: "Only Claude settings. Nothing here applies on Codex."
    const model = modelWith(
      {
        settings: { cs: { harness: 'claude', flags: ['--verbose'] } },
        hooks: { fmt: { harness: 'claude', file: 'hooks.json' } },
      },
      { only: { layers: ['settings/cs', 'hooks/fmt'] } },
    );

    // Act
    const actual = resolved({ model, profile: 'only', harness: 'codex' });

    // Assert
    should(actual.availability).deepEqual({ available: false, reason: 'nothing-applies' });
    should(actual.applied).deepEqual([]);
    should(actual.skipped.map(skip => [skip.layer.reference, skip.reason, skip.harness])).deepEqual([
      ['settings/cs', 'other-harness', 'claude'],
      ['hooks/fmt', 'other-harness', 'claude'],
    ]);
    should(actual.flags).deepEqual([]);
    should(actual.hooks).deepEqual([]);
  });

  it('should keep generic layers and the matching harness, and skip the rest, on a mixed profile', () => {
    // Arrange — E14 mixed: "Claude settings will be skipped on Codex"
    const model = modelWith(
      {
        instructions: {
          main: { file: 'm.md' },
          cx: { file: 'c.md', harness: 'codex' },
          cl: { file: 'l.md', harness: 'claude' },
        },
        mcp: { github: { command: 'npx' }, local: { command: 'uvx', harness: 'claude' } },
        skills: { mine: { items: ['a'] }, theirs: { items: ['b'], harness: 'claude' } },
      },
      {
        mixed: {
          layers: [
            'instructions/main',
            'instructions/cx',
            'instructions/cl',
            'mcp/github',
            'mcp/local',
            'skills/mine',
            'skills/theirs',
          ],
        },
      },
    );

    // Act
    const actual = resolved({ model, profile: 'mixed', harness: 'codex' });

    // Assert
    should(actual.availability).deepEqual({ available: true });
    should(refs(actual.applied)).deepEqual(['instructions/main', 'instructions/cx', 'mcp/github', 'skills/mine']);
    should(actual.skipped.map(skip => skip.layer.reference)).deepEqual([
      'instructions/cl',
      'mcp/local',
      'skills/theirs',
    ]);
    should(actual.instructions.map(entry => entry.component.file)).deepEqual(['m.md', 'c.md']);
  });

  it('should carry partial support only for applied layers of this harness', () => {
    // Arrange — E22
    const model = modelWith(
      { skills: { notes: { items: ['release-notes'] }, other: { items: ['x'], harness: 'claude' } } },
      { p: { layers: ['skills/notes', 'skills/other'] } },
    );
    const reason = 'release-notes limits which tools it may use';

    // Act
    const actual = resolved({
      model,
      profile: 'p',
      harness: 'codex',
      partialSupport: [
        { reference: 'skills/notes', harness: 'codex', reason },
        { reference: 'skills/notes', harness: 'claude', reason: 'not this harness' },
        { reference: 'skills/other', harness: 'codex', reason: 'skipped layer' },
      ],
    });

    // Assert
    should(actual.partial).deepEqual([{ reference: 'skills/notes', harness: 'codex', reason }]);
  });

  it('should carry no partial support when none is declared', () => {
    // Act
    const actual = resolved({
      model: modelWith({ instructions: instructions('a') }, { p: { layers: ['instructions/a'] } }),
      profile: 'p',
      harness: 'claude',
    });

    // Assert
    should(actual.partial).deepEqual([]);
  });
});

describe('resolveProfile — merging each kind (§3.4)', () => {
  it('should apply every instruction oldest to newest, through bases', () => {
    // Arrange
    const model = modelWith(
      { instructions: instructions('main', 'auto') },
      { default: { layers: ['instructions/main'] }, p: { layers: ['profile/default', 'instructions/auto'] } },
    );

    // Act
    const actual = resolved({ model, profile: 'p', harness: 'claude' });

    // Assert
    should(actual.instructions.map(entry => [entry.layer.name, entry.component.file])).deepEqual([
      ['main', 'components/instructions/main.md'],
      ['auto', 'components/instructions/auto.md'],
    ]);
    should(actual.conflicts).deepEqual([]);
  });

  it('should apply every hook in layer order', () => {
    // Arrange
    const model = modelWith(
      { hooks: { a: { harness: 'claude', file: 'a.json' }, b: { harness: 'claude', directory: 'b' } } },
      { p: { layers: ['hooks/b', 'hooks/a'] } },
    );

    // Act
    const actual = resolved({ model, profile: 'p', harness: 'claude' });

    // Assert
    should(actual.hooks.map(entry => entry.layer.name)).deepEqual(['b', 'a']);
  });

  it('should union MCP servers by name', () => {
    // Arrange
    const model = modelWith(
      { mcp: { github: { command: 'npx', args: ['-y', 'gh'] }, linear: { url: 'https://mcp.linear.app/sse' } } },
      { base: { layers: ['mcp/github'] }, p: { layers: ['profile/base', 'mcp/linear', 'mcp/github'] } },
    );

    // Act
    const actual = resolved({ model, profile: 'p', harness: 'claude' });

    // Assert
    should(actual.mcp.map(entry => [entry.layer.name, entry.layer.origin])).deepEqual([
      ['linear', 'mcp/linear'],
      ['github', 'mcp/github'],
    ]);
  });

  it('should union skill items by name, the newer layer supplying a shared item', () => {
    // Arrange
    const model = modelWith(
      { skills: { mine: { items: ['a', 'b'] }, more: { items: ['b', 'c'] } } },
      { p: { layers: ['skills/mine', 'skills/more'] } },
    );

    // Act
    const actual = resolved({ model, profile: 'p', harness: 'codex' });

    // Assert
    should(actual.skills.map(skill => [skill.item, skill.layer.name])).deepEqual([
      ['a', 'mine'],
      ['b', 'more'],
      ['c', 'more'],
    ]);
    should(actual.conflicts).deepEqual([]);
  });

  it('should deep-merge settings files, the later key winning, and report each conflict', () => {
    // Arrange — E18
    const model = modelWith(
      {
        settings: {
          base: { harness: 'claude', file: 'base.json' },
          agent: { harness: 'claude', file: 'agent.json' },
        },
      },
      {
        default: { layers: ['settings/base'] },
        agent: { layers: ['settings/agent'] },
        p: { layers: ['profile/default', 'profile/agent'] },
      },
    );

    // Act
    const actual = resolved({
      model,
      profile: 'p',
      harness: 'claude',
      settingsBodies: {
        base: { permissions: { defaultMode: 'plan', allow: ['Bash(ls)'] }, theme: 'dark', model: 'x' },
        agent: { permissions: { defaultMode: 'acceptEdits' }, theme: 'dark' },
      },
    });

    // Assert
    should(actual.settings.value).deepEqual({
      permissions: { defaultMode: 'acceptEdits', allow: ['Bash(ls)'] },
      theme: 'dark',
      model: 'x',
    });
    should(actual.settings.unread).deepEqual([]);
    should(actual.settings.leaves.map(leaf => [leaf.key, leaf.layer.name])).deepEqual([
      ['permissions.allow', 'base'],
      ['model', 'base'],
      ['permissions.defaultMode', 'agent'],
      ['theme', 'agent'],
    ]);
    should(actual.conflicts).have.length(1);
    const conflict = actual.conflicts[0] as Conflict;
    should(conflict).containDeep({
      harness: 'claude',
      field: 'settings',
      key: 'permissions.defaultMode',
      path: ['permissions', 'defaultMode'],
      winner: { value: 'acceptEdits' },
    });
    should(conflict.overridden.map(setter => [setter.value, setter.layer.name])).deepEqual([['plan', 'base']]);
    should(describeConflict(conflict)).equal(
      '`permissions.defaultMode` · Claude Code: acceptEdits (from agent) overrides plan (from default)',
    );
  });

  it('should report a scalar replaced by a table, and a table replaced by a scalar', () => {
    // Arrange
    const model = modelWith(
      {
        settings: {
          one: { harness: 'codex', file: 'one.toml' },
          two: { harness: 'codex', file: 'two.toml' },
        },
      },
      { p: { layers: ['settings/one', 'settings/two'] } },
    );

    // Act
    const actual = resolved({
      model,
      profile: 'p',
      harness: 'codex',
      settingsBodies: { one: { a: 5, b: { c: 1, d: 2 } }, two: { a: { x: 1 }, b: 'flat' } },
    });

    // Assert
    should(actual.settings.value).deepEqual({ a: { x: 1 }, b: 'flat' });
    should(actual.conflicts.map(conflict => [conflict.key, conflict.overridden.map(setter => setter.value)])).deepEqual(
      [
        ['a.x', [5]],
        ['b', [1, 2]],
      ],
    );
    should(describeConflict(actual.conflicts[1] as Conflict)).equal(
      '`b` · Codex: flat (from two) overrides 1 (from one), 2 (from one)',
    );
  });

  it('should treat an empty table as merging, not overriding', () => {
    // Arrange
    const model = modelWith(
      {
        settings: {
          one: { harness: 'claude', file: 'one.json' },
          two: { harness: 'claude', file: 'two.json' },
          three: { harness: 'claude', file: 'three.json' },
        },
      },
      { p: { layers: ['settings/one', 'settings/two', 'settings/three'] } },
    );

    // Act
    const actual = resolved({
      model,
      profile: 'p',
      harness: 'claude',
      settingsBodies: { one: { a: { b: 1 }, e: {} }, two: { a: {}, e: { f: 1 } }, three: { e: {} } },
    });

    // Assert
    should(actual.settings.value).deepEqual({ a: { b: 1 }, e: { f: 1 } });
    should(actual.conflicts).deepEqual([]);
    should(actual.settings.leaves.map(leaf => [leaf.key, leaf.layer.name])).deepEqual([
      ['a.b', 'one'],
      ['e.f', 'two'],
    ]);
  });

  it('should move an equal value to the newer layer without calling it a conflict', () => {
    // Arrange
    const model = modelWith(
      { settings: { one: { harness: 'claude', file: 'one.json' }, two: { harness: 'claude', file: 'two.json' } } },
      { p: { layers: ['settings/one', 'settings/two'] } },
    );

    // Act
    const actual = resolved({
      model,
      profile: 'p',
      harness: 'claude',
      settingsBodies: { one: { list: [1, { a: 2 }], e: {} }, two: { list: [1, { a: 2 }], e: {} } },
    });

    // Assert
    should(actual.conflicts).deepEqual([]);
    should(actual.settings.leaves.map(leaf => [leaf.key, leaf.layer.name])).deepEqual([
      ['list', 'two'],
      ['e', 'two'],
    ]);
  });

  it('should name a settings component whose file body was not supplied, and merge it as empty', () => {
    // Arrange
    const model = modelWith(
      { settings: { cs: { harness: 'claude', file: 'cs.json', flags: ['--verbose'] } } },
      { p: { layers: ['settings/cs'] } },
    );

    // Act
    const actual = resolved({ model, profile: 'p', harness: 'claude' });

    // Assert
    should(actual.settings).deepEqual({ value: {}, leaves: [], unread: ['cs'] });
    should(actual.flags.map(entry => entry.flag)).deepEqual(['--verbose']);
  });

  it('should append flags oldest first and merge env by variable, the later winning', () => {
    // Arrange — K4
    const model = modelWith(
      {
        settings: {
          base: { harness: 'claude', flags: ['--verbose', '--add-dir', '/a'], env: { LOG_LEVEL: 'info', KEEP: 'x' } },
          over: {
            harness: 'claude',
            flags: ['--add-dir', '/b'],
            env: { LOG_LEVEL: 'debug', KEEP: 'x', NEW: '${secret:K}' },
          },
          other: { harness: 'codex', flags: ['--search'], env: { LOG_LEVEL: 'trace' } },
        },
      },
      { p: { layers: ['settings/base', 'settings/other', 'settings/over'] } },
    );

    // Act
    const actual = resolved({ model, profile: 'p', harness: 'claude' });

    // Assert
    should(actual.flags.map(entry => [entry.flag, entry.layer.name])).deepEqual([
      ['--verbose', 'base'],
      ['--add-dir', 'base'],
      ['/a', 'base'],
      ['--add-dir', 'over'],
      ['/b', 'over'],
    ]);
    should(
      Object.fromEntries(Object.entries(actual.env).map(([name, entry]) => [name, [entry.value, entry.layer.name]])),
    ).deepEqual({
      LOG_LEVEL: ['debug', 'over'],
      KEEP: ['x', 'over'],
      NEW: ['${secret:K}', 'over'],
    });
    should(actual.conflicts).have.length(1);
    should(actual.conflicts[0]).containDeep({
      field: 'env',
      key: 'env.LOG_LEVEL',
      path: ['env', 'LOG_LEVEL'],
      winner: { value: 'debug' },
    });
    should(describeConflict(actual.conflicts[0] as Conflict)).equal(
      '`env.LOG_LEVEL` · Claude Code: debug (from over) overrides info (from base)',
    );
  });
});

describe('resolveProfile — model sets (§3.4, K8, E23)', () => {
  // §5.2's Default profile: a Claude set, then a Codex set, in one stack.
  const imported = modelWith(
    {
      modelSets: {
        'claude-models': {
          models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
          default: 'claude-opus-5-5',
        },
        'codex-models': { models: ['gpt-6'], default: 'gpt-6' },
        mixed: { models: ['gpt-6', 'claude-haiku-5-5', 'claude-sonnet-5-5'], default: 'gpt-6' },
        heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' },
        light: { models: ['claude-haiku-5-5', 'claude-opus-5-5'], default: 'claude-haiku-5-5' },
        alien: { models: ['llama-4'], default: 'llama-4' },
      },
    },
    {
      default: { layers: ['modelSets/claude-models', 'modelSets/codex-models'] },
      mixed: { layers: ['modelSets/mixed'] },
      stacked: { layers: ['modelSets/heavy', 'modelSets/claude-models', 'modelSets/light'] },
      alien: { layers: ['modelSets/alien'] },
    },
  );

  it('should give each harness its own set from a stack holding both', () => {
    // Act
    const claude = resolved({ model: imported, profile: 'default', harness: 'claude' });
    const codex = resolved({ model: imported, profile: 'default', harness: 'codex' });

    // Assert
    should(claude.modelSet).containDeep({
      source: 'model-set',
      layer: { name: 'claude-models' },
      default: 'claude-opus-5-5',
    });
    should(claude.skipped.map(skip => [skip.layer.name, skip.reason])).deepEqual([
      ['codex-models', 'no-model-for-harness'],
    ]);
    should(codex.modelSet).containDeep({ source: 'model-set', layer: { name: 'codex-models' }, default: 'gpt-6' });
    should(codex.skipped.map(skip => skip.layer.name)).deepEqual(['claude-models']);
    should(claude.conflicts).deepEqual([]);
  });

  it('should filter a mixed set to the harness, standing in the first of its models for a foreign default', () => {
    // Act
    const claude = resolved({ model: imported, profile: 'mixed', harness: 'claude' });
    const codex = resolved({ model: imported, profile: 'mixed', harness: 'codex' });

    // Assert
    should(claude.modelSet).deepEqual({
      source: 'model-set',
      layer: claude.applied[0],
      models: [
        { id: 'claude-haiku-5-5', available: true },
        { id: 'claude-sonnet-5-5', available: true },
      ],
      declaredDefault: 'claude-haiku-5-5',
      default: 'claude-haiku-5-5',
      fellBack: false,
      noneAvailable: false,
    });
    should(codex.modelSet).containDeep({ models: [{ id: 'gpt-6', available: true }], default: 'gpt-6' });
  });

  it('should let the newest applicable set win and report the default it overrides', () => {
    // Act
    const actual = resolved({ model: imported, profile: 'stacked', harness: 'claude' });

    // Assert
    should(actual.modelSet).containDeep({ layer: { name: 'light' }, declaredDefault: 'claude-haiku-5-5' });
    should(actual.conflicts).have.length(1);
    const conflict = actual.conflicts[0] as Conflict;
    should(conflict).containDeep({ field: 'model', key: 'model', winner: { value: 'claude-haiku-5-5' } });
    should(conflict.overridden.map(setter => [setter.value, setter.layer.name])).deepEqual([
      ['claude-opus-5-5', 'heavy'],
      ['claude-opus-5-5', 'claude-models'],
    ]);
    should(describeConflict(conflict)).equal(
      '`model` · Claude Code: claude-haiku-5-5 (from light) overrides claude-opus-5-5 (from heavy), claude-opus-5-5 (from claude-models)',
    );
  });

  it('should not report a model conflict when the defaults agree', () => {
    // Arrange
    const model = modelWith(
      {
        modelSets: {
          one: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' },
          two: { models: ['claude-opus-5-5', 'claude-haiku-5-5'], default: 'claude-opus-5-5' },
        },
      },
      { p: { layers: ['modelSets/one', 'modelSets/two'] } },
    );

    // Act
    const actual = resolved({ model, profile: 'p', harness: 'claude' });

    // Assert
    should(actual.conflicts).deepEqual([]);
    should(actual.modelSet).containDeep({ layer: { name: 'two' } });
  });

  it('should skip a set none of whose ids belong to any harness', () => {
    // Act
    const actual = resolved({ model: imported, profile: 'alien', harness: 'claude' });

    // Assert
    should(actual.availability).deepEqual({ available: false, reason: 'nothing-applies' });
    should(actual.modelSet).deepEqual({ source: 'harness-default' });
  });

  it('should strike through what the login cannot use and fall back to the first it can', () => {
    // Act — E23
    const actual = resolved({
      model: imported,
      profile: 'default',
      harness: 'claude',
      availableModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
    });

    // Assert
    should(actual.modelSet).containDeep({
      models: [
        { id: 'claude-opus-5-5', available: false },
        { id: 'claude-sonnet-5-5', available: true },
        { id: 'claude-haiku-5-5', available: true },
      ],
      declaredDefault: 'claude-opus-5-5',
      default: 'claude-sonnet-5-5',
      fellBack: true,
      noneAvailable: false,
    });
  });

  it('should keep the declared default when the login can use it', () => {
    // Act
    const actual = resolved({
      model: imported,
      profile: 'default',
      harness: 'claude',
      availableModels: ['claude-opus-5-5'],
    });

    // Assert
    should(actual.modelSet).containDeep({ default: 'claude-opus-5-5', fellBack: false, noneAvailable: false });
  });

  it('should never let availability decide which set wins', () => {
    // Act — the newest applicable set wins even when the login can use none of it
    const actual = resolved({
      model: imported,
      profile: 'default',
      harness: 'codex',
      availableModels: ['claude-opus-5-5'],
    });

    // Assert
    should(actual.modelSet).containDeep({
      layer: { name: 'codex-models' },
      models: [{ id: 'gpt-6', available: false }],
      default: undefined,
      fellBack: false,
      noneAvailable: true,
    });
  });
});

describe('settings helpers', () => {
  it('should quote a key segment a dotted key would make ambiguous', () => {
    // Assert
    should(settingsKey(['projects', '/home/me/x.y', 'trust_level'])).equal('projects."/home/me/x.y".trust_level');
    should(settingsKey(['permissions', 'defaultMode'])).equal('permissions.defaultMode');
  });

  it('should list a document as its leaves, arrays and empty tables included', () => {
    // Assert
    should(settingsLeaves({ a: { b: [1], c: {} }, d: null })).deepEqual([
      [['a', 'b'], [1]],
      [['a', 'c'], {}],
      [['d'], null],
    ]);
  });

  it('should say which paths replace each other', () => {
    // Assert
    should(pathsOverlap(['a'], ['a', 'b'])).be.true();
    should(pathsOverlap(['a', 'b'], ['a'])).be.true();
    should(pathsOverlap(['a', 'b'], ['a', 'c'])).be.false();
  });

  it.each([
    [1, 1, true],
    [1, '1', false],
    [Number.NaN, Number.NaN, true],
    [[1, 2], [1, 2], true],
    [[1, 2], [1], false],
    [[1], { 0: 1 }, false],
    [{ a: 1 }, { a: 1 }, true],
    [{ a: 1 }, { b: 1 }, false],
    [{ a: 1 }, { a: 1, b: 2 }, false],
    [new Date(0), new Date(0), true],
    [new Date(0), new Date(1), false],
    [new Date(0), {}, false],
  ])('should compare %p and %p as %p', (a, b, expected) => {
    // Assert
    should(sameSettingsValue(a, b)).equal(expected);
  });
});
