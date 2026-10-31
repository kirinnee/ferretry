/**
 * The account model's "used by" helpers and the four catalogue projections
 * (docs/design/account-model.md §4: K1, K5–K7, P3–P6, R4, F1–F3, E14, E18, E20–E24).
 *
 * The claims: one reading of "used by" feeds the lists and the refusals, so they never count
 * differently; each projection says what the layering module decided in the product's exact
 * sentences; no environment value that looks like a credential is shown; and every projection is
 * accepted by the protocol schema the route will answer with.
 */
import { describe, it } from 'bun:test';
import {
  type AccountModel,
  builtInModelCatalogs,
  builtInPresets,
  type HarnessKind,
  parseAccountModel,
  type SettingsObject,
} from '@ferretry/fleet';
import {
  FleetComponentCatalogSchema,
  FleetLayeredProfileCatalogSchema,
  type FleetMachineAuthority,
  FleetMachineViewSchema,
  FleetProfileDraftViewSchema,
  FleetRuntimeCatalogSchema,
} from '@ferretry/protocol';
import should from 'should';
import {
  type CatalogFacts,
  componentCatalog,
  componentUsage,
  counted,
  editConsequence,
  flattenSettings,
  layersRefusal,
  layerWords,
  listed,
  machineView,
  profileCatalog,
  profileDraftView,
  profileUsage,
  redactText,
  runtimeCatalog,
  runtimesUsingCredential,
  runtimesUsingProfile,
  settingsValueText,
} from '../../../src/lib/fleet/catalog.ts';

const TOOLS: Readonly<Record<HarnessKind, string | undefined>> = {
  claude: '/usr/local/bin/claude',
  codex: '/usr/local/bin/codex',
};

const factsOf = (overrides: Partial<CatalogFacts> = {}): CatalogFacts => ({
  format: 'version-2',
  machineName: 'workstation',
  tools: TOOLS,
  runningSessions: 0,
  acceptsAutoPermissionMode: true,
  userHome: '/home/me',
  ...overrides,
});

/** What a caller who may apply a change can do. */
const OPEN: FleetMachineAuthority = { mayApply: true, applyRefusal: 'granted' };

const SETTINGS_BODIES: Readonly<Record<string, SettingsObject>> = {
  'claude-a': { permissions: { defaultMode: 'plan' }, theme: 'dark', skipDangerousModePermissionPrompt: false },
  'claude-b': { permissions: { defaultMode: 'acceptEdits' } },
  'codex-a': { approval_policy: 'never' },
};

const SECRET_REFERENCE = ['$', '{secret:WORK_KEY}'].join('');

const COMPONENTS = {
  instructions: {
    main: { file: 'instructions/main.md' },
    'claude-notes': { file: 'instructions/claude-notes.md', harness: 'claude' },
    imports: { file: 'instructions/imports.md' },
  },
  mcp: {
    uvx: {
      command: 'uvx',
      args: ['mcp-server', '--stdio'],
      env: { API_TOKEN: 'sk-abcdefghijkl', REGION: 'eu-west-1', WORK_KEY: SECRET_REFERENCE },
    },
    local: { command: './bin/local' },
    sse: { url: 'https://mcp.example.com/sse' },
    remote: { url: 'https://mcp.example.com/mcp', harness: 'codex' },
  },
  skills: {
    tools: { items: ['alpha', 'beta'] },
    'claude-skills': { items: ['gamma'], harness: 'claude' },
  },
  settings: {
    'claude-a': {
      harness: 'claude',
      file: 'settings/a.json',
      flags: ['--verbose'],
      env: { EDITOR: 'vim', MODE: 'one' },
    },
    'claude-b': { harness: 'claude', file: 'settings/b.json', env: { MODE: 'two' } },
    'codex-a': { harness: 'codex', file: 'settings/codex.toml' },
    'flags-only': { harness: 'claude', flags: ['--permission-mode', 'plan'] },
  },
  hooks: {
    'claude-hooks': { harness: 'claude', file: 'hooks/hooks.json' },
    'claude-hook-scripts': { harness: 'claude', directory: 'hooks/scripts' },
  },
  modelSets: {
    fast: { models: ['claude-sonnet-5', 'claude-haiku-4-5'], default: 'claude-sonnet-5' },
    careful: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' },
    gpt: { models: ['gpt-6', 'gpt-5.6-codex'], default: 'gpt-6' },
    mixed: { models: ['gpt-6', 'claude-sonnet-5'], default: 'gpt-6' },
    junk: { models: ['llama-4'], default: 'llama-4' },
  },
};

const CREDENTIALS = {
  'claude-main': { harness: 'claude', store: 'ferretry', label: 'Work' },
  'claude-host': { harness: 'claude', store: 'host' },
  'codex-main': { harness: 'codex', store: 'ferretry' },
  'claude-env': { harness: 'claude', store: 'environment', env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } },
};

const FULL_LAYERS = [
  'profile/base',
  'instructions/claude-notes',
  'instructions/imports',
  'mcp/uvx',
  'mcp/local',
  'mcp/sse',
  'mcp/remote',
  'skills/tools',
  'settings/claude-a',
  'settings/claude-b',
  'settings/codex-a',
  'settings/flags-only',
  'hooks/claude-hooks',
  'modelSets/fast',
  'modelSets/careful',
];

const PROFILES = {
  base: { layers: ['instructions/main'] },
  full: { layers: FULL_LAYERS },
  empty: { layers: [] },
  'claude-only': { layers: ['settings/claude-a'] },
  junk: { layers: ['modelSets/junk'] },
  'models-mixed': { layers: ['modelSets/mixed'] },
};

const RUNTIMES = {
  'agent-claude': { credential: 'claude-main', profile: 'full', agent: true },
  'agent-claude-twin': { credential: 'claude-main', profile: 'full' },
  'agent-codex': { credential: 'codex-main', profile: 'full', agent: true },
  'empty-rt': { credential: 'claude-env', profile: 'empty' },
  helper: { credential: 'claude-host', profile: 'base' },
  'models-rt': { credential: 'claude-host', profile: 'models-mixed' },
};

interface ModelPatch {
  readonly machine?: Record<string, unknown>;
  readonly profiles?: Record<string, unknown>;
  readonly runtimes?: Record<string, unknown>;
}

const modelOf = (patch: ModelPatch = {}): AccountModel =>
  parseAccountModel({
    version: 2,
    machine: patch.machine ?? {},
    credentials: CREDENTIALS,
    components: COMPONENTS,
    profiles: patch.profiles ?? PROFILES,
    runtimes: patch.runtimes ?? RUNTIMES,
  });

/** A model the schema would refuse, for the total-function cases a hand-edited catalogue could reach. */
const unvalidated = (model: AccountModel, patch: Record<string, unknown>): AccountModel =>
  ({ ...model, ...patch }) as unknown as AccountModel;

const withReadFacts = (overrides: Partial<CatalogFacts> = {}): CatalogFacts =>
  factsOf({
    settingsBodies: SETTINGS_BODIES,
    instructionBodies: { imports: 'Read this.\n@docs/other.md\n', main: 'No imports here.' },
    skillFrontmatter: { alpha: ['allowed-tools', 'name'], beta: ['model'] },
    missingCommands: new Set(['uvx']),
    ...overrides,
  });

const usageModel = (): AccountModel =>
  parseAccountModel({
    version: 2,
    credentials: { work: { harness: 'claude' }, play: { harness: 'claude' } },
    components: { instructions: { main: { file: 'main.md' }, other: { file: 'other.md' } } },
    profiles: {
      base: { layers: ['instructions/main'] },
      mid: { layers: ['profile/base'] },
      top: { layers: ['profile/mid'] },
      side: { layers: ['instructions/other'] },
    },
    runtimes: {
      'on-top': { credential: 'work', profile: 'top' },
      'on-base': { credential: 'play', profile: 'base' },
      'on-side': { credential: 'work', profile: 'side' },
    },
  });

const componentNamed = (catalog: ReturnType<typeof componentCatalog>, reference: string) => {
  for (const group of catalog.kinds) {
    for (const component of group.components) if (component.reference === reference) return component;
  }
  throw new Error(`no component ${reference}`);
};

const profileNamed = (catalog: ReturnType<typeof profileCatalog>, name: string) => {
  const found = catalog.profiles.find(profile => profile.name === name);
  if (found === undefined) throw new Error(`no profile ${name}`);
  return found;
};

const runtimeNamed = (catalog: ReturnType<typeof runtimeCatalog>, name: string) => {
  const found = catalog.runtimes.find(runtime => runtime.name === name);
  if (found === undefined) throw new Error(`no runtime ${name}`);
  return found;
};

const stackOf = (view: { readonly harnesses: readonly { readonly harness: string }[] }, harness: HarnessKind) => {
  const found = view.harnesses.find(stack => stack.harness === harness) as
    | ReturnType<typeof profileCatalog>['profiles'][number]['harnesses'][number]
    | undefined;
  if (found === undefined) throw new Error(`no ${harness} stack`);
  return found;
};

describe('counted', () => {
  it('should use the singular for exactly one', () => {
    // Act
    const actual = counted(1, 'profile');

    // Assert
    should(actual).equal('1 profile');
  });

  it.each([0, 3])('should use the default plural for %p', count => {
    // Act
    const actual = counted(count, 'runtime');

    // Assert
    should(actual).equal(`${count} runtimes`);
  });

  it('should use a plural word when one is given', () => {
    // Act
    const actual = counted(2, 'batch', 'batches');

    // Assert
    should(actual).equal('2 batches');
  });
});

describe('listed', () => {
  it.each([
    [[], ''],
    [['a'], 'a'],
    [['a', 'b'], 'a and b'],
    [['a', 'b', 'c'], 'a, b and c'],
  ])('should say %p as %p', (names, expected) => {
    // Act
    const actual = listed(names);

    // Assert
    should(actual).equal(expected);
  });
});

describe('editConsequence', () => {
  it('should say nothing when nobody else uses the thing', () => {
    // Act
    const actual = editConsequence({ direct: [], profiles: [], runtimes: [] });

    // Assert
    should(actual).be.undefined();
  });

  it('should say where an edit lands when profiles and runtimes use it', () => {
    // Act
    const actual = editConsequence({ direct: ['a'], profiles: ['a'], runtimes: ['r1', 'r2'] });

    // Assert
    should(actual).equal(
      'Used by 1 profile and 2 runtimes. Saving changes it everywhere. Running sessions keep the old version until restarted.',
    );
  });

  it('should say it when only runtimes use it', () => {
    // Act
    const actual = editConsequence({ direct: [], profiles: [], runtimes: ['r1'] });

    // Assert
    should(actual).equal(
      'Used by 0 profiles and 1 runtime. Saving changes it everywhere. Running sessions keep the old version until restarted.',
    );
  });
});

describe('componentUsage', () => {
  it('should separate the profiles that name a component from the ones that reach it, and the runtimes behind them', () => {
    // Arrange
    const model = usageModel();

    // Act
    const actual = componentUsage(model, 'instructions/main');

    // Assert
    should(actual).deepEqual({
      direct: ['base'],
      profiles: ['base', 'mid', 'top'],
      runtimes: ['on-base', 'on-top'],
    });
  });

  it('should report nobody for a component no profile reaches', () => {
    // Act
    const actual = componentUsage(usageModel(), 'instructions/ghost');

    // Assert
    should(actual).deepEqual({ direct: [], profiles: [], runtimes: [] });
  });

  it('should not count a profile it cannot flatten as reaching anything', () => {
    // Arrange — a profile naming a component that does not exist is not a stack
    const model = unvalidated(usageModel(), {
      profiles: { broken: { layers: ['instructions/ghost', 'instructions/main'] } },
      runtimes: {},
    });

    // Act
    const actual = componentUsage(model, 'instructions/main');

    // Assert
    should(actual).deepEqual({ direct: ['broken'], profiles: [], runtimes: [] });
  });
});

describe('profileUsage', () => {
  it('should name the profiles that use a profile as a base, those that reach it, and the runtimes on any of them', () => {
    // Arrange
    const model = usageModel();

    // Act
    const actual = profileUsage(model, 'base');

    // Assert
    should(actual).deepEqual({
      direct: ['mid'],
      profiles: ['mid', 'top'],
      runtimes: ['on-base', 'on-top'],
    });
  });

  it('should report only the runtimes on a profile nobody builds on', () => {
    // Act
    const actual = profileUsage(usageModel(), 'side');

    // Assert
    should(actual).deepEqual({ direct: [], profiles: [], runtimes: ['on-side'] });
  });
});

describe('runtimesUsingProfile', () => {
  it('should name the runtimes that name the profile themselves, and not those on a profile built on it', () => {
    // Act
    const actual = runtimesUsingProfile(usageModel(), 'base');

    // Assert
    should(actual).deepEqual(['on-base']);
  });
});

describe('runtimesUsingCredential', () => {
  it('should name every runtime on one credential, sorted', () => {
    // Act
    const actual = runtimesUsingCredential(usageModel(), 'work');

    // Assert
    should(actual).deepEqual(['on-side', 'on-top']);
  });

  it('should name nobody for a credential no runtime uses', () => {
    // Act
    const actual = runtimesUsingCredential(usageModel(), 'unused');

    // Assert
    should(actual).deepEqual([]);
  });
});

describe('machineView', () => {
  it('should say a machine with runtimes is set up and name each tool it found', () => {
    // Arrange
    const model = modelOf({ machine: { agentPermissions: 'skip' } });

    // Act
    const actual = machineView(model, factsOf({ runningSessions: 2 }), OPEN);

    // Assert
    should(actual).deepEqual({
      name: 'workstation',
      format: 'version-2',
      setUp: true,
      agentPermissions: 'skip',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
      browserMode: 'headless',
      browserPorts: 'random',
      browserProxy: null,
      autoResume: true,
      agendaMode: true,
      lastAutoResume: null,
      tools: [
        { harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
        { harness: 'codex', label: 'Codex', installed: true, command: '/usr/local/bin/codex' },
      ],
      runtimeCount: 6,
      runningSessions: 2,
      authority: OPEN,
    });
    FleetMachineViewSchema.parse(actual);
  });

  it('should carry the machine browser ports setting, random unless the machine says otherwise', () => {
    // Act
    const random = machineView(modelOf({}), factsOf({}), OPEN);
    const perUser = machineView(modelOf({ machine: { browserPorts: 'per-user' } }), factsOf({}), OPEN);

    // Assert
    should(random.browserPorts).equal('random');
    should(perUser.browserPorts).equal('per-user');
    FleetMachineViewSchema.parse(perUser);
  });

  it('should carry the machine default for agenda mode, on unless turned off', () => {
    // Act
    const on = machineView(modelOf({}), factsOf({}), OPEN);
    const off = machineView(modelOf({ machine: { agendaMode: false } }), factsOf({}), OPEN);

    // Assert
    should(on.agendaMode).equal(true);
    should(off.agendaMode).equal(false);
    FleetMachineViewSchema.parse(off);
  });

  it('should carry auto-resume and what the last pass did', () => {
    // Arrange
    const model = modelOf({ machine: { autoResume: false } });
    const lastAutoResume = {
      at: '2026-10-21T08:00:00.000Z',
      resumed: 2,
      skipped: [{ sessionId: 's1', reason: 'its runtime is signed out' }],
    };

    // Act
    const actual = machineView(model, factsOf({ lastAutoResume }), OPEN);

    // Assert
    should(actual.autoResume).equal(false);
    should(actual.lastAutoResume).deepEqual(lastAutoResume);
    FleetMachineViewSchema.parse(actual);
  });

  it('should say a machine with no runtimes is not set up, a missing tool is not installed, and what a caller without a step-up may not do', () => {
    // Arrange
    const model = modelOf({ profiles: {}, runtimes: {} });
    const facts = factsOf({
      format: 'none',
      tools: { claude: undefined, codex: '/opt/codex' },
    });

    const authority: FleetMachineAuthority = { mayApply: false, applyRefusal: 'step-up-required' };

    // Act
    const actual = machineView(model, facts, authority);

    // Assert
    should(actual.setUp).be.false();
    should(actual.agentPermissions).equal('auto');
    should(actual.runtimeCount).equal(0);
    should(actual.tools).deepEqual([
      { harness: 'claude', label: 'Claude Code', installed: false },
      { harness: 'codex', label: 'Codex', installed: true, command: '/opt/codex' },
    ]);
    should(actual.tools[0]).not.have.property('command');
    should(actual.authority).deepEqual(authority);
    FleetMachineViewSchema.parse(actual);
  });
});

describe('componentCatalog', () => {
  it('should list the six kinds in the Components tab order with their descriptions', () => {
    // Act
    const actual = componentCatalog(modelOf(), factsOf());

    // Assert
    should(actual.format).equal('version-2');
    should(actual.kinds.map(group => [group.kind, group.label, group.description])).deepEqual([
      ['instructions', 'Instructions', 'Guidance every session reads first.'],
      ['mcp', 'MCP servers', 'Tools a session can call.'],
      ['skills', 'Skills', 'Named abilities a session can use.'],
      ['settings', 'Settings', 'Flags, environment and options for one tool.'],
      ['hooks', 'Hooks', 'Commands that run at points in a session, for one tool.'],
      ['modelSets', 'Model sets', 'The models a runtime offers, and its default.'],
    ]);
    FleetComponentCatalogSchema.parse(actual);
  });

  it('should list each kind sorted by name', () => {
    // Act
    const actual = componentCatalog(modelOf(), factsOf());

    // Assert
    should(actual.kinds[1]?.components.map(component => component.name)).deepEqual(['local', 'remote', 'sse', 'uvx']);
    should(actual.kinds[5]?.components.map(component => component.reference)).deepEqual([
      'modelSets/careful',
      'modelSets/fast',
      'modelSets/gpt',
      'modelSets/junk',
      'modelSets/mixed',
    ]);
  });

  it('should show a harness-only component with its harness and a generic one without', () => {
    // Act
    const actual = componentCatalog(modelOf(), factsOf());

    // Assert
    should(componentNamed(actual, 'instructions/claude-notes').harness).equal('claude');
    should(componentNamed(actual, 'instructions/main')).not.have.property('harness');
    should(componentNamed(actual, 'settings/codex-a').harness).equal('codex');
    should(componentNamed(actual, 'modelSets/fast')).not.have.property('harness');
  });

  it('should show what each kind holds', () => {
    // Act
    const actual = componentCatalog(modelOf(), factsOf());

    // Assert
    should(componentNamed(actual, 'instructions/main').detail).deepEqual({
      kind: 'instructions',
      file: 'instructions/main.md',
    });
    should(componentNamed(actual, 'mcp/local').detail).deepEqual({ kind: 'mcp', command: './bin/local', env: [] });
    should(componentNamed(actual, 'mcp/sse').detail).deepEqual({
      kind: 'mcp',
      url: 'https://mcp.example.com/sse',
      env: [],
    });
    should(componentNamed(actual, 'skills/tools').detail).deepEqual({ kind: 'skills', items: ['alpha', 'beta'] });
    should(componentNamed(actual, 'settings/claude-a').detail).deepEqual({
      kind: 'settings',
      file: 'settings/a.json',
      flags: ['--verbose'],
      env: [
        { name: 'EDITOR', value: 'vim' },
        { name: 'MODE', value: 'one' },
      ],
    });
    should(componentNamed(actual, 'settings/flags-only').detail).deepEqual({
      kind: 'settings',
      flags: ['--permission-mode', 'plan'],
      env: [],
    });
    should(componentNamed(actual, 'hooks/claude-hooks').detail).deepEqual({
      kind: 'hooks',
      file: 'hooks/hooks.json',
    });
    should(componentNamed(actual, 'hooks/claude-hook-scripts').detail).deepEqual({
      kind: 'hooks',
      directory: 'hooks/scripts',
    });
    should(componentNamed(actual, 'modelSets/fast').detail).deepEqual({
      kind: 'modelSets',
      models: ['claude-sonnet-5', 'claude-haiku-4-5'],
      default: 'claude-sonnet-5',
    });
  });

  it('should hide an environment value that looks like a credential and show the rest, sorted by name', () => {
    // Act
    const actual = componentCatalog(modelOf(), factsOf());

    // Assert
    const detail = componentNamed(actual, 'mcp/uvx').detail;
    should(detail).deepEqual({
      kind: 'mcp',
      command: 'uvx',
      args: ['mcp-server', '--stdio'],
      env: [
        { name: 'API_TOKEN', hidden: true },
        { name: 'REGION', value: 'eu-west-1' },
        { name: 'WORK_KEY', value: SECRET_REFERENCE },
      ],
    });
    should(JSON.stringify(actual)).not.containEql('sk-abcdefghijkl');
  });

  it('should warn about an MCP command this machine does not have, and only that one', () => {
    // Act
    const actual = componentCatalog(modelOf(), withReadFacts({ missingCommands: new Set(['uvx']) }));

    // Assert
    should(componentNamed(actual, 'mcp/uvx').warnings).deepEqual(['Command not found: uvx']);
    should(componentNamed(actual, 'mcp/local').warnings).deepEqual([]);
    should(componentNamed(actual, 'mcp/sse').warnings).deepEqual([]);
    should(componentNamed(actual, 'instructions/main').warnings).deepEqual([]);
  });

  it('should not warn when the machine reports no missing commands', () => {
    // Act
    const actual = componentCatalog(modelOf(), factsOf());

    // Assert
    should(componentNamed(actual, 'mcp/uvx').warnings).deepEqual([]);
  });

  it('should say a component is partly supported on Codex, in the product words', () => {
    // Act
    const actual = componentCatalog(modelOf(), withReadFacts());

    // Assert
    should(componentNamed(actual, 'instructions/imports').partial).deepEqual([
      {
        harness: 'codex',
        reason:
          'Partly supported on Codex: imports pulls in other files with @path lines. Codex reads those lines as plain text and does not open the files.',
      },
    ]);
    should(componentNamed(actual, 'mcp/sse').partial).deepEqual([
      {
        harness: 'codex',
        reason:
          'Partly supported on Codex: sse is reached over SSE. Codex connects to servers over streamable HTTP, so it may not reach this one.',
      },
    ]);
    should(componentNamed(actual, 'skills/tools').partial.map(entry => entry.reason)).deepEqual([
      'Partly supported on Codex: alpha limits which tools it may use. Codex ignores that limit and loads the rest.',
      "Partly supported on Codex: beta picks its own model. Codex ignores that and uses the runtime's model.",
    ]);
    should(componentNamed(actual, 'instructions/main').partial).deepEqual([]);
  });

  it('should say nothing is partial when no body was read', () => {
    // Act
    const actual = componentCatalog(modelOf(), factsOf());

    // Assert
    should(componentNamed(actual, 'instructions/imports').partial).deepEqual([]);
    should(componentNamed(actual, 'skills/tools').partial).deepEqual([]);
  });

  it('should name who uses a component and where an edit lands', () => {
    // Act
    const actual = componentCatalog(modelOf(), factsOf());

    // Assert
    const main = componentNamed(actual, 'instructions/main');
    should(main.usedBy).deepEqual({
      profiles: ['base', 'full'],
      runtimes: ['agent-claude', 'agent-claude-twin', 'agent-codex', 'helper'],
    });
    should(main.editNote).equal(
      'Used by 2 profiles and 4 runtimes. Saving changes it everywhere. Running sessions keep the old version until restarted.',
    );
    const uvx = componentNamed(actual, 'mcp/uvx');
    should(uvx.editNote).equal(
      'Used by 1 profile and 3 runtimes. Saving changes it everywhere. Running sessions keep the old version until restarted.',
    );
  });

  it('should say nothing uses a component nobody builds on, and let it be removed', () => {
    // Act
    const actual = componentCatalog(modelOf(), factsOf());

    // Assert
    const unused = componentNamed(actual, 'modelSets/gpt');
    should(unused.usedBy).deepEqual({ profiles: [], runtimes: [] });
    should(unused.editNote).equal('Nothing uses it yet.');
    should(unused.remove).deepEqual({ available: true });
  });

  it('should refuse a removal while one profile has the component as a layer', () => {
    // Act
    const actual = componentCatalog(modelOf(), factsOf());

    // Assert
    should(componentNamed(actual, 'mcp/uvx').remove).deepEqual({
      available: false,
      reason: 'It is a layer in full. Remove it from that profile first.',
    });
  });

  it('should refuse a removal naming every profile that has the component as a layer', () => {
    // Arrange
    const model = modelOf({ profiles: { ...PROFILES, 'claude-only': { layers: ['mcp/local'] } } });

    // Act
    const actual = componentCatalog(model, factsOf());

    // Assert
    should(componentNamed(actual, 'mcp/local').remove).deepEqual({
      available: false,
      reason: 'It is a layer in claude-only and full. Remove it from those profiles first.',
    });
  });

  it('should list a component through a base as used by the profile that builds on it but not as a direct layer', () => {
    // Act
    const actual = componentCatalog(modelOf(), factsOf());

    // Assert
    const main = componentNamed(actual, 'instructions/main');
    should(main.remove).deepEqual({
      available: false,
      reason: 'It is a layer in base. Remove it from that profile first.',
    });
    should(main.usedBy.profiles).containEql('full');
  });
});

describe('profileCatalog', () => {
  it('should list profiles sorted by name with their layers as written', () => {
    // Act
    const actual = profileCatalog(modelOf(), withReadFacts());

    // Assert
    should(actual.format).equal('version-2');
    should(actual.profiles.map(profile => profile.name)).deepEqual([
      'base',
      'claude-only',
      'empty',
      'full',
      'junk',
      'models-mixed',
    ]);
    should(profileNamed(actual, 'full').layers).deepEqual(FULL_LAYERS);
    should(actual.profiles[0]?.harnesses.map(stack => stack.harness)).deepEqual(['claude', 'codex']);
    FleetLayeredProfileCatalogSchema.parse(actual);
  });

  it('should name the runtimes on a profile, the profiles built on it and the ones that would include it', () => {
    // Act
    const actual = profileCatalog(modelOf(), withReadFacts());

    // Assert
    const base = profileNamed(actual, 'base');
    should(base.usedBy).deepEqual(['helper']);
    should(base.baseFor).deepEqual(['full']);
    should(base.wouldIncludeItself).deepEqual(['base', 'full']);
    const full = profileNamed(actual, 'full');
    should(full.usedBy).deepEqual(['agent-claude', 'agent-claude-twin', 'agent-codex']);
    should(full.baseFor).deepEqual([]);
    should(full.wouldIncludeItself).deepEqual(['full']);
  });

  it('should refuse a removal while a profile is built on it, and allow it when none is', () => {
    // Act
    const actual = profileCatalog(modelOf(), withReadFacts());

    // Assert
    should(profileNamed(actual, 'base').remove).deepEqual({
      available: false,
      reason: 'It is a base for full. Remove it from that profile first.',
    });
    should(profileNamed(actual, 'full').remove).deepEqual({ available: true });
  });

  it('should refuse a removal naming every profile built on it', () => {
    // Arrange
    const model = modelOf({
      profiles: { ...PROFILES, second: { layers: ['profile/base'] } },
    });

    // Act
    const actual = profileCatalog(model, withReadFacts());

    // Assert
    should(profileNamed(actual, 'base').remove).deepEqual({
      available: false,
      reason: 'It is a base for full and second. Remove it from those profiles first.',
    });
  });

  it('should say a profile with no layers is not available on either tool', () => {
    // Act
    const actual = profileCatalog(modelOf(), withReadFacts());

    // Assert
    const empty = profileNamed(actual, 'empty');
    for (const harness of ['claude', 'codex'] as const) {
      const stack = stackOf(empty, harness);
      should(stack.available).deepEqual({ available: false, reason: 'This profile has no layers yet.' });
      should(stack.applied).deepEqual([]);
      should(stack.skipped).deepEqual([]);
    }
  });

  it('should say a profile of one tool settings applies nowhere on the other', () => {
    // Arrange
    const model = modelOf({ profiles: { ...PROFILES, 'codex-only': { layers: ['settings/codex-a'] } } });

    // Act
    const actual = profileCatalog(model, withReadFacts());

    // Assert
    const claudeOnly = profileNamed(actual, 'claude-only');
    should(stackOf(claudeOnly, 'claude').available).deepEqual({ available: true });
    should(stackOf(claudeOnly, 'codex').available).deepEqual({
      available: false,
      reason: 'Only Claude Code settings. Nothing here applies on Codex.',
    });
    should(stackOf(claudeOnly, 'codex').skipped).deepEqual([
      {
        reference: 'settings/claude-a',
        sentence: 'Settings claude-a is for Claude Code only, so it is skipped on Codex.',
      },
    ]);
    should(stackOf(profileNamed(actual, 'codex-only'), 'claude').available).deepEqual({
      available: false,
      reason: 'Only Codex settings. Nothing here applies on Claude Code.',
    });
  });

  it('should say nothing applies, without naming a tool, when the only layers are model sets for no tool', () => {
    // Act
    const actual = profileCatalog(modelOf(), withReadFacts());

    // Assert
    const junk = profileNamed(actual, 'junk');
    should(stackOf(junk, 'claude').available).deepEqual({
      available: false,
      reason: 'Nothing here applies on Claude Code.',
    });
    should(stackOf(junk, 'codex').available).deepEqual({
      available: false,
      reason: 'Nothing here applies on Codex.',
    });
    should(stackOf(junk, 'claude').skipped).deepEqual([
      {
        reference: 'modelSets/junk',
        sentence: 'Model set junk has no Claude Code model, so it is skipped on Claude Code.',
      },
    ]);
  });

  it('should list what applies and what is skipped for the tool the stack is read on', () => {
    // Act
    const actual = profileCatalog(modelOf(), withReadFacts());

    // Assert
    const full = profileNamed(actual, 'full');
    const claude = stackOf(full, 'claude');
    should(claude.available).deepEqual({ available: true });
    should(claude.applied).deepEqual([
      'instructions/main',
      'instructions/claude-notes',
      'instructions/imports',
      'mcp/uvx',
      'mcp/local',
      'mcp/sse',
      'skills/tools',
      'settings/claude-a',
      'settings/claude-b',
      'settings/flags-only',
      'hooks/claude-hooks',
      'modelSets/fast',
      'modelSets/careful',
    ]);
    should(claude.skipped).deepEqual([
      { reference: 'mcp/remote', sentence: 'MCP server remote is for Codex only, so it is skipped on Claude Code.' },
      {
        reference: 'settings/codex-a',
        sentence: 'Settings codex-a is for Codex only, so it is skipped on Claude Code.',
      },
    ]);
    const codex = stackOf(full, 'codex');
    should(codex.applied).deepEqual([
      'instructions/main',
      'instructions/imports',
      'mcp/uvx',
      'mcp/local',
      'mcp/sse',
      'mcp/remote',
      'skills/tools',
      'settings/codex-a',
    ]);
    should(codex.skipped.map(skip => skip.sentence)).deepEqual([
      'Instructions claude-notes is for Claude Code only, so it is skipped on Codex.',
      'Settings claude-a is for Claude Code only, so it is skipped on Codex.',
      'Settings claude-b is for Claude Code only, so it is skipped on Codex.',
      'Settings flags-only is for Claude Code only, so it is skipped on Codex.',
      'Hooks claude-hooks is for Claude Code only, so it is skipped on Codex.',
      'Model set fast has no Codex model, so it is skipped on Codex.',
      'Model set careful has no Codex model, so it is skipped on Codex.',
    ]);
  });

  it('should say where two layers set one key differently, naming the winner and what it beat', () => {
    // Act
    const actual = profileCatalog(modelOf(), withReadFacts());

    // Assert
    const claude = stackOf(profileNamed(actual, 'full'), 'claude');
    should(claude.conflicts).deepEqual([
      {
        harness: 'claude',
        field: 'settings',
        key: 'permissions.defaultMode',
        sentence: '`permissions.defaultMode` · Claude Code: acceptEdits (from claude-b) overrides plan (from claude-a)',
        winner: 'claude-b',
        overridden: ['claude-a'],
      },
      {
        harness: 'claude',
        field: 'env',
        key: 'env.MODE',
        sentence: '`env.MODE` · Claude Code: two (from claude-b) overrides one (from claude-a)',
        winner: 'claude-b',
        overridden: ['claude-a'],
      },
      {
        harness: 'claude',
        field: 'model',
        key: 'model',
        sentence: '`model` · Claude Code: claude-opus-5-5 (from careful) overrides claude-sonnet-5 (from fast)',
        winner: 'careful',
        overridden: ['fast'],
      },
    ]);
    should(stackOf(profileNamed(actual, 'full'), 'codex').conflicts).deepEqual([]);
  });

  it('should find no settings conflict when the settings files were not read', () => {
    // Act
    const actual = profileCatalog(modelOf(), factsOf());

    // Assert
    const claude = stackOf(profileNamed(actual, 'full'), 'claude');
    should(claude.conflicts.map(conflict => conflict.field)).deepEqual(['env', 'model']);
  });

  it('should carry the partial-support reasons of what applies on a tool', () => {
    // Act
    const actual = profileCatalog(modelOf(), withReadFacts());

    // Assert
    const full = profileNamed(actual, 'full');
    should(stackOf(full, 'claude').partial).deepEqual([]);
    should(stackOf(full, 'codex').partial.map(entry => entry.reference)).deepEqual([
      'instructions/imports',
      'mcp/sse',
      'skills/tools',
      'skills/tools',
    ]);
    should(stackOf(full, 'codex').partial[0]?.reason).equal(
      'Partly supported on Codex: imports pulls in other files with @path lines. Codex reads those lines as plain text and does not open the files.',
    );
  });

  it('should say a profile cannot be read when its stack cannot be flattened', () => {
    // Arrange
    const model = unvalidated(modelOf(), {
      profiles: { ...PROFILES, dangling: { layers: ['instructions/ghost'] } },
    });

    // Act
    const actual = profileCatalog(model, withReadFacts());

    // Assert
    const dangling = profileNamed(actual, 'dangling');
    for (const harness of ['claude', 'codex'] as const) {
      should(stackOf(dangling, harness)).deepEqual({
        harness,
        available: { available: false, reason: 'This profile cannot be read.' },
        applied: [],
        skipped: [],
        conflicts: [],
        partial: [],
      });
    }
  });
});

describe('runtimeCatalog', () => {
  it('should list runtimes sorted by name, each on the harness of its credential', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts());

    // Assert
    should(actual.format).equal('version-2');
    should(actual.runtimes.map(runtime => [runtime.name, runtime.harness, runtime.profile, runtime.agent])).deepEqual([
      ['agent-claude', 'claude', 'full', true],
      ['agent-claude-twin', 'claude', 'full', false],
      ['agent-codex', 'codex', 'full', true],
      ['empty-rt', 'claude', 'empty', false],
      ['helper', 'claude', 'base', false],
      ['models-rt', 'claude', 'models-mixed', false],
    ]);
    FleetRuntimeCatalogSchema.parse(actual);
  });

  it('should run each runtime on a two-CLI login on its own CLI: the one it names, else its profile scope', () => {
    // Arrange
    const model = parseAccountModel({
      version: 2,
      credentials: {
        dual: {
          harness: 'claude',
          store: 'environment',
          claude: { env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } },
          codex: { codexProvider: { id: 'ollama' } },
        },
      },
      components: COMPONENTS,
      profiles: PROFILES,
      runtimes: {
        'on-claude': { credential: 'dual', profile: 'base' },
        'on-codex': { credential: 'dual', profile: 'base', harness: 'codex' },
        'scoped-claude': { credential: 'dual', profile: 'claude-only' },
      },
    });

    // Act
    const actual = runtimeCatalog(model, withReadFacts());

    // Assert
    should(actual.runtimes.map(runtime => [runtime.name, runtime.harness])).deepEqual([
      ['on-claude', 'claude'],
      ['on-codex', 'codex'],
      ['scoped-claude', 'claude'],
    ]);
  });

  it('should list catalog models only for a login that reads a catalog', () => {
    // Arrange — the same two-CLI environment login, made by hand: it names no preset, so no catalog
    const model = parseAccountModel({
      version: 2,
      credentials: {
        dual: {
          harness: 'claude',
          store: 'environment',
          claude: { env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } },
          codex: { codexProvider: { id: 'ollama' } },
        },
        glm: {
          harness: 'claude',
          store: 'environment',
          preset: 'zai-glm',
          env: { ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}' },
        },
      },
      components: COMPONENTS,
      profiles: PROFILES,
      runtimes: {
        'by-hand': { credential: 'dual', profile: 'base' },
        'on-glm': { credential: 'glm', profile: 'base' },
      },
    });

    // Act
    const actual = runtimeCatalog(
      model,
      withReadFacts({ modelCatalogs: { catalogs: builtInModelCatalogs(), presets: builtInPresets() } }),
    );

    // Assert
    should(actual.runtimes.find(runtime => runtime.name === 'by-hand')?.models).be.undefined();
    should(actual.runtimes.find(runtime => runtime.name === 'on-glm')?.models).match({
      catalog: { id: 'zai', customIds: false },
      default: 'glm-5.3',
    });
    FleetRuntimeCatalogSchema.parse(actual);
  });

  it('should list the models Ollama has installed for a login on the Ollama catalog, marked local', () => {
    // Arrange
    const model = parseAccountModel({
      version: 2,
      credentials: {
        local: {
          harness: 'codex',
          store: 'environment',
          preset: 'ollama-codex',
          codex: { codexProvider: { id: 'ollama', model: 'gpt-oss:20b' } },
        },
      },
      components: COMPONENTS,
      profiles: PROFILES,
      runtimes: { 'on-ollama': { credential: 'local', profile: 'base' } },
    });
    const local = {
      provider: 'ollama' as const,
      baseUrl: 'http://127.0.0.1:11434',
      state: 'found' as const,
      models: [{ id: 'llama3.2:latest', label: 'llama3.2:latest' }],
      checkedAt: '2026-10-19T00:00:00.000Z',
      message: 'Ollama has 1 model installed on this machine.',
      pullCommand: 'ollama pull gpt-oss:20b',
    };

    // Act
    const actual = runtimeCatalog(
      model,
      withReadFacts({
        modelCatalogs: { catalogs: builtInModelCatalogs(), presets: builtInPresets(), local: { ollama: local } },
      }),
    );
    const unread = runtimeCatalog(
      model,
      withReadFacts({ modelCatalogs: { catalogs: builtInModelCatalogs(), presets: builtInPresets() } }),
    );

    // Assert
    const models = actual.runtimes.find(runtime => runtime.name === 'on-ollama')?.models;
    should(models?.choices.map(choice => [choice.id, choice.local])).eql([['llama3.2:latest', true]]);
    should(models?.default).equal('llama3.2:latest');
    should(models?.local).eql(local);
    should(unread.runtimes.find(runtime => runtime.name === 'on-ollama')?.models?.local).be.undefined();
    FleetRuntimeCatalogSchema.parse(actual);
  });

  it('should name each runtime by its ids.json id, falling back to its name, with a wrapper of the same name', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts({ runtimeIds: { 'agent-claude': 'rt_0001' } }));

    // Assert — a runtime whose apply never landed has no id yet, so its name stands in.
    should(runtimeNamed(actual, 'agent-claude')).containDeep({
      id: 'rt_0001',
      name: 'agent-claude',
      wrapper: 'agent-claude',
    });
    should(runtimeNamed(actual, 'helper')).containDeep({ id: 'helper', name: 'helper', wrapper: 'helper' });
    FleetRuntimeCatalogSchema.parse(actual);
  });

  it('should show the credential with its store, its label when it has one, and its status when it is known', () => {
    // Act
    const actual = runtimeCatalog(
      modelOf(),
      withReadFacts({ credentialStatus: { 'claude-main': 'refresh_due', 'codex-main': 'ready' } }),
    );

    // Assert
    should(runtimeNamed(actual, 'agent-claude').credential).deepEqual({
      id: 'claude-main',
      store: 'ferretry',
      label: 'Work',
      status: 'refresh_due',
    });
    should(runtimeNamed(actual, 'agent-codex').credential).deepEqual({
      id: 'codex-main',
      store: 'ferretry',
      status: 'ready',
    });
    should(runtimeNamed(actual, 'helper').credential).deepEqual({ id: 'claude-host', store: 'host' });
    should(runtimeNamed(actual, 'empty-rt').credential).deepEqual({ id: 'claude-env', store: 'environment' });
  });

  it('should name the runtimes that share a login and a profile, and nobody else', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts());

    // Assert
    should(runtimeNamed(actual, 'agent-claude').sameAs).deepEqual(['agent-claude-twin']);
    should(runtimeNamed(actual, 'agent-claude-twin').sameAs).deepEqual(['agent-claude']);
    should(runtimeNamed(actual, 'agent-codex').sameAs).deepEqual([]);
    should(runtimeNamed(actual, 'helper').sameAs).deepEqual([]);
  });

  it('should show the resolved stack of the runtime on its own tool', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts());

    // Assert
    const claude = runtimeNamed(actual, 'agent-claude').stack;
    should(claude.harness).equal('claude');
    should(claude.available).deepEqual({ available: true });
    should(claude.applied).containEql('mcp/uvx');
    should(claude.skipped.map(skip => skip.reference)).deepEqual(['mcp/remote', 'settings/codex-a']);
    should(claude.conflicts.map(conflict => conflict.key)).deepEqual(['permissions.defaultMode', 'env.MODE', 'model']);
    const codex = runtimeNamed(actual, 'agent-codex').stack;
    should(codex.harness).equal('codex');
    should(codex.partial.map(entry => entry.reference)).deepEqual([
      'instructions/imports',
      'mcp/sse',
      'skills/tools',
      'skills/tools',
    ]);
  });

  it('should say the tool picks its own model when the stack holds no model set', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts());

    // Assert
    should(runtimeNamed(actual, 'helper').modelSet).deepEqual({ source: 'harness-default' });
    should(runtimeNamed(actual, 'agent-codex').modelSet).deepEqual({ source: 'harness-default' });
  });

  it('should show the winning model set with each model and its default', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts());

    // Assert
    should(runtimeNamed(actual, 'agent-claude').modelSet).deepEqual({
      source: 'model-set',
      name: 'careful',
      models: [{ id: 'claude-opus-5-5', available: true }],
      declaredDefault: 'claude-opus-5-5',
      default: 'claude-opus-5-5',
    });
  });

  it("should keep only this tool's models of a mixed set and move the declared default to the first of them", () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts());

    // Assert
    should(runtimeNamed(actual, 'models-rt').modelSet).deepEqual({
      source: 'model-set',
      name: 'mixed',
      models: [{ id: 'claude-sonnet-5', available: true }],
      declaredDefault: 'claude-sonnet-5',
      default: 'claude-sonnet-5',
    });
  });

  it('should give an agent runtime the fixed layer for Claude Code, in words', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts());

    // Assert
    const fixed = runtimeNamed(actual, 'agent-claude').fixedLayer;
    should(fixed?.agentPermissions).equal('auto');
    should(fixed?.entries).deepEqual([
      { key: 'permissions.defaultMode', value: 'auto' },
      { key: 'trust prompt', value: 'off' },
      { key: 'onboarding screens', value: 'off' },
      { key: 'Remote Control at startup', value: 'off' },
      { key: 'one-time prompts (nudges, upsells, notices)', value: 'off' },
      { key: 'skipAutoPermissionPrompt', value: 'true' },
      { key: '--disallowed-tools=AskUserQuestion', value: 'true' },
      { key: 'Ferretry tools (terminals and browsers)', value: 'on' },
      { key: 'Ferretry tools instruction', value: 'on' },
    ]);
  });

  it('should give an agent runtime on Codex the fixed layer for Codex, in words', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts());

    // Assert
    const fixed = runtimeNamed(actual, 'agent-codex').fixedLayer;
    should(fixed?.agentPermissions).equal('auto');
    should(fixed?.entries).deepEqual([
      { key: 'approval_policy', value: 'on-request' },
      { key: 'sandbox_mode', value: 'workspace-write' },
      { key: 'trust prompt', value: 'off' },
      { key: '--no-alt-screen', value: 'true' },
      { key: 'one-time prompts (nudges, upsells, notices)', value: 'off' },
      { key: 'Ferretry tools (terminals and browsers)', value: 'on' },
      { key: 'Ferretry tools instruction', value: 'on' },
    ]);
  });

  it('should show Skip all permission checks as the Claude Code permission mode and a prompt it also switches off', () => {
    // Arrange
    const model = modelOf({ machine: { agentPermissions: 'skip' } });

    // Act
    const actual = runtimeCatalog(model, withReadFacts({ acceptsAutoPermissionMode: false }));

    // Assert
    const fixed = runtimeNamed(actual, 'agent-claude').fixedLayer;
    should(fixed?.agentPermissions).equal('skip');
    should(fixed?.entries).deepEqual([
      { key: 'permissions.defaultMode', value: 'bypassPermissions' },
      { key: 'skipDangerousModePermissionPrompt', value: 'true' },
      { key: 'trust prompt', value: 'off' },
      { key: 'onboarding screens', value: 'off' },
      { key: 'Remote Control at startup', value: 'off' },
      { key: 'one-time prompts (nudges, upsells, notices)', value: 'off' },
      { key: '--disallowed-tools=AskUserQuestion', value: 'true' },
      { key: 'Ferretry tools (terminals and browsers)', value: 'on' },
      { key: 'Ferretry tools instruction', value: 'on' },
    ]);
    should(runtimeNamed(actual, 'agent-claude').launch).deepEqual({ available: true });
  });

  it('should leave the fixed layer off a runtime that is not an agent', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts());

    // Assert
    should(runtimeNamed(actual, 'agent-claude-twin')).not.have.property('fixedLayer');
    should(runtimeNamed(actual, 'helper')).not.have.property('fixedLayer');
  });

  it('should say which of the profile settings and flags the fixed layer overrides, struck through', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts());

    // Assert
    should(runtimeNamed(actual, 'agent-claude').fixedLayer?.overridden).deepEqual([
      {
        key: 'permissions.defaultMode',
        value: 'acceptEdits',
        from: 'claude-b',
        sentence: 'From your claude-b · Overridden for agents by Ferretry',
      },
      {
        key: '--permission-mode',
        value: '--permission-mode plan',
        from: 'flags-only',
        sentence: 'From your flags-only · Overridden for agents by Ferretry',
      },
    ]);
  });

  it('should show a setting that is not text as the JSON it is when it is overridden', () => {
    // Arrange
    const model = modelOf({ machine: { agentPermissions: 'skip' } });

    // Act
    const actual = runtimeCatalog(model, withReadFacts());

    // Assert
    const overridden = runtimeNamed(actual, 'agent-claude').fixedLayer?.overridden ?? [];
    should(overridden.map(entry => [entry.key, entry.value, entry.from])).deepEqual([
      ['permissions.defaultMode', 'acceptEdits', 'claude-b'],
      ['skipDangerousModePermissionPrompt', 'false', 'claude-a'],
      ['--permission-mode', '--permission-mode plan', 'flags-only'],
    ]);
  });

  it('should show a Codex setting the fixed layer overrides', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts());

    // Assert
    should(runtimeNamed(actual, 'agent-codex').fixedLayer?.overridden).deepEqual([
      {
        key: 'approval_policy',
        value: 'never',
        from: 'codex-a',
        sentence: 'From your codex-a · Overridden for agents by Ferretry',
      },
    ]);
  });

  it('should override nothing when the settings files were not read', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), factsOf());

    // Assert
    should(runtimeNamed(actual, 'agent-codex').fixedLayer?.overridden).deepEqual([]);
    should(runtimeNamed(actual, 'agent-claude').fixedLayer?.overridden).deepEqual([
      {
        key: '--permission-mode',
        value: '--permission-mode plan',
        from: 'flags-only',
        sentence: 'From your flags-only · Overridden for agents by Ferretry',
      },
    ]);
  });

  it('should let a runtime launch when its tool is installed, it is signed in and its profile applies', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts({ credentialStatus: { 'claude-main': 'ready' } }));

    // Assert
    should(runtimeNamed(actual, 'agent-claude').launch).deepEqual({ available: true });
    should(runtimeNamed(actual, 'agent-claude-twin').launch).deepEqual({ available: true });
    should(runtimeNamed(actual, 'helper').launch).deepEqual({ available: true });
  });

  it('should tell a person to install the tool when it is not on this machine', () => {
    // Act
    const actual = runtimeCatalog(
      modelOf(),
      withReadFacts({ tools: { claude: '/usr/local/bin/claude', codex: undefined } }),
    );

    // Assert
    should(runtimeNamed(actual, 'agent-codex').launch).deepEqual({
      available: false,
      reason: 'Install Codex to launch',
    });
    should(runtimeNamed(actual, 'agent-claude').launch).deepEqual({ available: true });
  });

  it('should put installing the tool before signing in', () => {
    // Act
    const actual = runtimeCatalog(
      modelOf(),
      withReadFacts({
        tools: { claude: undefined, codex: undefined },
        credentialStatus: { 'claude-main': 'needs_sign_in' },
      }),
    );

    // Assert
    should(runtimeNamed(actual, 'agent-claude').launch).deepEqual({
      available: false,
      reason: 'Install Claude Code to launch',
    });
  });

  it('should tell a person to sign in when the login needs it, for every runtime on that login', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts({ credentialStatus: { 'claude-main': 'needs_sign_in' } }));

    // Assert
    should(runtimeNamed(actual, 'agent-claude').launch).deepEqual({ available: false, reason: 'Sign in to launch' });
    should(runtimeNamed(actual, 'agent-claude-twin').launch).deepEqual({
      available: false,
      reason: 'Sign in to launch',
    });
    should(runtimeNamed(actual, 'agent-claude').credential.status).equal('needs_sign_in');
    should(runtimeNamed(actual, 'helper').launch).deepEqual({ available: true });
  });

  it('should not block a launch on a login that is only due a refresh or being checked', () => {
    // Act
    const actual = runtimeCatalog(
      modelOf(),
      withReadFacts({ credentialStatus: { 'claude-main': 'refresh_due', 'claude-host': 'checking' } }),
    );

    // Assert
    should(runtimeNamed(actual, 'agent-claude').launch).deepEqual({ available: true });
    should(runtimeNamed(actual, 'helper').launch).deepEqual({ available: true });
  });

  it('should say why a runtime cannot launch when its profile applies nothing on its tool', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts());

    // Assert
    should(runtimeNamed(actual, 'empty-rt').launch).deepEqual({
      available: false,
      reason: 'This profile has no layers yet.',
    });
  });

  it('should say why a runtime cannot launch when its profile is only for the other tool', () => {
    // Arrange
    const model = modelOf({
      profiles: { ...PROFILES, 'codex-only': { layers: ['settings/codex-a'] } },
      runtimes: { ...RUNTIMES, 'wrong-tool': { credential: 'claude-main', profile: 'codex-only' } },
    });

    // Act
    const actual = runtimeCatalog(model, withReadFacts());

    // Assert
    should(runtimeNamed(actual, 'wrong-tool').launch).deepEqual({
      available: false,
      reason: 'Only Codex settings. Nothing here applies on Claude Code.',
    });
  });

  it('should refuse an agent runtime on Claude Code that does not accept Auto mode, in words, and show no fixed layer', () => {
    // Act
    const actual = runtimeCatalog(modelOf(), withReadFacts({ acceptsAutoPermissionMode: false }));

    // Assert
    const runtime = runtimeNamed(actual, 'agent-claude');
    should(runtime.launch).deepEqual({
      available: false,
      reason:
        "Claude Code on this machine does not accept Auto mode (--permission-mode auto), so Ferretry won't launch this agent runtime. Update Claude Code, or switch this machine's Agent permissions to Skip all permission checks.",
    });
    should(runtime).not.have.property('fixedLayer');
    should(runtimeNamed(actual, 'agent-claude-twin').launch).deepEqual({ available: true });
    should(runtimeNamed(actual, 'agent-codex').launch).deepEqual({ available: true });
    should(runtimeNamed(actual, 'agent-codex')).have.property('fixedLayer');
    FleetRuntimeCatalogSchema.parse(actual);
  });

  it('should put a profile that applies nothing before the fixed-layer refusal', () => {
    // Arrange
    const model = modelOf({
      runtimes: { 'agent-empty': { credential: 'claude-main', profile: 'empty', agent: true } },
    });

    // Act
    const actual = runtimeCatalog(model, withReadFacts({ acceptsAutoPermissionMode: false }));

    // Assert
    should(runtimeNamed(actual, 'agent-empty').launch).deepEqual({
      available: false,
      reason: 'This profile has no layers yet.',
    });
  });

  it('should say the profile cannot be read, with no overrides, when a runtime is on a profile that cannot be flattened', () => {
    // Arrange
    const model = unvalidated(modelOf(), {
      profiles: { ...PROFILES, dangling: { layers: ['instructions/ghost'] } },
      runtimes: { agent: { credential: 'claude-main', profile: 'dangling', agent: true } },
    });

    // Act
    const actual = runtimeCatalog(model, withReadFacts());

    // Assert
    const runtime = runtimeNamed(actual, 'agent');
    should(runtime.stack).deepEqual({
      harness: 'claude',
      available: { available: false, reason: 'This profile cannot be read.' },
      applied: [],
      skipped: [],
      conflicts: [],
      partial: [],
    });
    should(runtime.modelSet).deepEqual({ source: 'harness-default' });
    should(runtime.fixedLayer?.overridden).deepEqual([]);
    should(runtime.launch).deepEqual({ available: false, reason: 'This profile cannot be read.' });
    FleetRuntimeCatalogSchema.parse(actual);
  });

  it('should leave out a runtime whose credential is not in the model', () => {
    // Arrange
    const model = unvalidated(modelOf(), {
      runtimes: {
        ghost: { credential: 'nobody', profile: 'base', agent: false },
        helper: { credential: 'claude-host', profile: 'base', agent: false },
      },
    });

    // Act
    const actual = runtimeCatalog(model, withReadFacts());

    // Assert
    should(actual.runtimes.map(runtime => runtime.name)).deepEqual(['helper']);
  });

  it('should list no runtimes for a machine with none', () => {
    // Act
    const actual = runtimeCatalog(modelOf({ runtimes: {} }), factsOf({ format: 'none' }));

    // Assert
    should(actual).deepEqual({ format: 'none', runtimes: [] });
    FleetRuntimeCatalogSchema.parse(actual);
  });
});

// ── Component content, E30 and the draft preview ─────────────────────────────────────────────────

const FAKE_TOKEN = ['sk-', 'abcdefghijklmnop'].join('');
const FAKE_PASSWORD = ['correct', '-horse-battery'].join('');

const contentModel = (): AccountModel =>
  parseAccountModel({
    version: 2,
    credentials: { work: { harness: 'claude' }, codex: { harness: 'codex' } },
    components: {
      instructions: { main: { file: 'instructions/main.md' }, unread: { file: 'instructions/unread.md' } },
      mcp: {
        local: { command: '/home/me/bin/notes', args: ['--root', '/home/me/notes'] },
        copied: { command: 'uvx', args: ['--root', '/Users/other/notes'] },
        remote: { url: 'https://mcp.example.com/home/other/mcp' },
      },
      skills: { tools: { items: ['alpha'] } },
      settings: {
        claude: { harness: 'claude', file: 'settings/claude.json' },
        flags: { harness: 'claude', flags: ['--verbose'] },
      },
      hooks: {
        hooks: { harness: 'claude', file: 'hooks/hooks.json' },
        scripts: { harness: 'claude', directory: 'hooks/scripts' },
      },
      modelSets: { fast: { models: ['claude-sonnet-5'], default: 'claude-sonnet-5' } },
    },
    profiles: {
      base: { layers: ['instructions/main'] },
      agent: { layers: ['profile/base', 'settings/claude'] },
    },
    runtimes: { 'claude-agent': { credential: 'work', profile: 'agent' } },
  });

const CONTENT_SETTINGS: Readonly<Record<string, SettingsObject>> = {
  claude: {
    theme: 'dark',
    permissions: { defaultMode: 'plan', allow: ['Bash'] },
    env: { API_TOKEN: FAKE_TOKEN, NOTES: '/home/other/notes' },
    empty: {},
    verbose: true,
  },
};

const contentFacts = (overrides: Partial<CatalogFacts> = {}): CatalogFacts =>
  factsOf({
    settingsBodies: CONTENT_SETTINGS,
    instructionBodies: { main: `Read /home/me/notes first.\nexport API_TOKEN=${FAKE_TOKEN}\n` },
    hooksTexts: { hooks: `{ "command": "notify", "password": "${FAKE_PASSWORD}" }\n` },
    ...overrides,
  });

describe('componentCatalog content', () => {
  it('should show instructions and hooks text with every secret-looking value cut out', () => {
    // Act
    const actual = componentCatalog(contentModel(), contentFacts());

    // Assert
    should(componentNamed(actual, 'instructions/main').content).deepEqual({
      form: 'text',
      text: 'Read /home/me/notes first.\nexport API_TOKEN=‹hidden›\n',
      redacted: true,
    });
    should(componentNamed(actual, 'hooks/hooks').content).deepEqual({
      form: 'text',
      text: '{ "command": "notify", "password": "‹hidden›" }\n',
      redacted: true,
    });
    FleetComponentCatalogSchema.parse(actual);
  });

  it('should say text was not redacted when nothing in it looks like a secret', () => {
    // Act
    const actual = componentCatalog(contentModel(), contentFacts({ instructionBodies: { main: 'Be brief.\n' } }));

    // Assert
    should(componentNamed(actual, 'instructions/main').content).deepEqual({
      form: 'text',
      text: 'Be brief.\n',
      redacted: false,
    });
  });

  it('should show settings as sorted dotted entries, hiding a secret-looking one', () => {
    // Act
    const actual = componentCatalog(contentModel(), contentFacts());

    // Assert
    should(componentNamed(actual, 'settings/claude').content).deepEqual({
      form: 'entries',
      entries: [
        { key: 'empty', value: '{}' },
        { key: 'env.API_TOKEN', hidden: true },
        { key: 'env.NOTES', value: '/home/other/notes' },
        { key: 'permissions.allow', value: '["Bash"]' },
        { key: 'permissions.defaultMode', value: 'plan' },
        { key: 'theme', value: 'dark' },
        { key: 'verbose', value: 'true' },
      ],
    });
  });

  it('should carry no content for a kind with no file, or a file that was not read', () => {
    // Act
    const actual = componentCatalog(contentModel(), contentFacts());

    // Assert
    for (const reference of [
      'instructions/unread',
      'mcp/local',
      'skills/tools',
      'settings/flags',
      'hooks/scripts',
      'modelSets/fast',
    ]) {
      should(componentNamed(actual, reference)).not.have.property('content');
    }
    should(componentNamed(componentCatalog(contentModel(), factsOf()), 'hooks/hooks')).not.have.property('content');
  });

  it('should never let a hidden value reach the answer, in text, entries or a check path', () => {
    // Act
    const body = JSON.stringify(componentCatalog(contentModel(), contentFacts()));

    // Assert
    should(body).not.containEql(FAKE_TOKEN);
    should(body).not.containEql(FAKE_PASSWORD);
  });

  it('should say where a cloned component came from, by name and by the verified daemon id', () => {
    // Arrange
    const model = parseAccountModel({
      version: 2,
      components: {
        mcp: {
          copied: { command: 'npx', clonedFrom: 'work-mac', clonedFromDaemon: 'sha256:work' },
          named: { command: 'npx', clonedFrom: 'work-mac' },
          own: { command: 'npx' },
        },
      },
    });

    // Act
    const actual = componentCatalog(model, factsOf());

    // Assert
    should(componentNamed(actual, 'mcp/copied')).containDeep({
      clonedFrom: 'work-mac',
      clonedFromDaemon: 'sha256:work',
    });
    should(componentNamed(actual, 'mcp/named').clonedFrom).equal('work-mac');
    should(componentNamed(actual, 'mcp/named')).not.have.property('clonedFromDaemon');
    should(componentNamed(actual, 'mcp/own')).not.have.property('clonedFrom');
  });

  it('should name the first path under somebody else’s home, and none under this machine’s', () => {
    // Act
    const actual = componentCatalog(contentModel(), contentFacts());

    // Assert
    should(componentNamed(actual, 'mcp/copied').checkPath).equal('/Users/other/notes');
    should(componentNamed(actual, 'mcp/remote').checkPath).equal('/home/other/mcp');
    should(componentNamed(actual, 'settings/claude').checkPath).equal('/home/other/notes');
    should(componentNamed(actual, 'mcp/local')).not.have.property('checkPath');
    should(componentNamed(actual, 'instructions/main')).not.have.property('checkPath');
    should(componentNamed(actual, 'skills/tools')).not.have.property('checkPath');
  });

  it('should find a check path in instructions and hooks text, and treat the home itself as its own', () => {
    // Act
    const actual = componentCatalog(
      contentModel(),
      contentFacts({
        instructionBodies: { main: 'See /home/me and /home/meadow/notes.' },
        hooksTexts: { hooks: '{ "command": "/Users/other/bin/hook" }' },
      }),
    );

    // Assert
    should(componentNamed(actual, 'instructions/main').checkPath).equal('/home/meadow/notes.');
    should(componentNamed(actual, 'hooks/hooks').checkPath).equal('/Users/other/bin/hook');
  });
});

describe('redactText', () => {
  it('should hide a token by its own shape even with no name beside it', () => {
    // Act
    const actual = redactText(`curl -H "x: y" ${FAKE_TOKEN}`);

    // Assert
    should(actual).deepEqual({ text: 'curl -H "x: y" ‹hidden›', redacted: true });
  });
});

describe('flattenSettings', () => {
  it('should treat an empty document as no entries', () => {
    // Act & Assert
    should(flattenSettings({})).deepEqual([]);
    should(settingsValueText(3)).equal('3');
  });
});

describe('layersRefusal', () => {
  it('should refuse each kind of bad layer in its own words, and accept good ones', () => {
    // Arrange
    const model = contentModel();

    // Act
    const actual = [
      layersRefusal(model, 'x', ['nonsense']),
      layersRefusal(model, 'x', ['mcp/local', 'mcp/local']),
      layersRefusal(model, 'x', ['profile/ghost']),
      layersRefusal(model, 'base', ['profile/agent']),
      layersRefusal(model, 'x', ['hooks/ghost']),
      layersRefusal(model, 'x', ['profile/base', 'mcp/local']),
    ];

    // Assert
    should(actual).deepEqual([
      '"nonsense" is not a layer — write <kind>/<name> or profile/<name>',
      'MCP server local is in the layers twice',
      'no profile ghost exists on this machine',
      'profile agent would include itself: it is base or is built on it',
      'no hooks ghost exists on this machine',
      undefined,
    ]);
    should(layerWords('nonsense')).equal('nonsense');
    should(layerWords('profile/base')).equal('profile base');
  });
});

describe('profileDraftView', () => {
  it('should resolve a draft exactly as the saved profile with those layers resolves', () => {
    // Arrange
    const model = contentModel();
    const facts = contentFacts();

    // Act
    const draft = profileDraftView(model, { layers: ['profile/base', 'settings/claude'] }, facts);
    const saved = profileNamed(profileCatalog(model, facts), 'agent');

    // Assert
    should({ harnesses: draft.harnesses, scope: draft.scope }).deepEqual({
      harnesses: saved.harnesses,
      scope: saved.scope,
    });
    should(draft.resolved?.map(entry => `${entry.harness} ${entry.field} ${entry.key} ${entry.from}`)).deepEqual([
      'claude instructions main profile/base',
      'claude settings theme settings/claude',
      'claude settings permissions.defaultMode settings/claude',
      'claude settings permissions.allow settings/claude',
      'claude settings env.API_TOKEN settings/claude',
      'claude settings env.NOTES settings/claude',
      'claude settings empty settings/claude',
      'claude settings verbose settings/claude',
      'codex instructions main profile/base',
    ]);
    FleetProfileDraftViewSchema.parse(draft);
  });

  it('should replace the edited profile’s own layers, and stand a new draft under a free name', () => {
    // Arrange
    const model = parseAccountModel({
      version: 2,
      components: { instructions: { main: { file: 'main.md' } } },
      profiles: { draft: { layers: ['instructions/main'] } },
    });

    // Act
    const edited = profileDraftView(model, { layers: [], editing: 'draft' }, factsOf());
    const fresh = profileDraftView(model, { layers: ['profile/draft'] }, factsOf());

    // Assert
    should(edited.harnesses.map(stack => stack.available)).deepEqual([
      { available: false, reason: 'This profile has no layers yet.' },
      { available: false, reason: 'This profile has no layers yet.' },
    ]);
    should(fresh.harnesses[0]?.applied).deepEqual(['instructions/main']);
    should(fresh).not.have.property('refusal');
  });

  it('should report a layer that would include the edited profile itself, and a missing one', () => {
    // Arrange
    const model = contentModel();

    // Act
    const loop = profileDraftView(model, { layers: ['profile/agent'], editing: 'base' }, contentFacts());
    const ghost = profileDraftView(model, { layers: ['mcp/ghost'] }, contentFacts());

    // Assert
    should(loop.refusal).equal('profile agent would include itself: it is base or is built on it');
    should(loop.harnesses.map(stack => stack.available.available)).deepEqual([false, false]);
    should(ghost.refusal).equal('no MCP server ghost exists on this machine');
    FleetProfileDraftViewSchema.parse(loop);
  });
});

describe('harness scope (P7)', () => {
  const scoped = (): AccountModel =>
    parseAccountModel({
      version: 2,
      components: {
        instructions: { main: { file: 'main.md' } },
        settings: {
          'claude-settings': { harness: 'claude', flags: ['--x'] },
          'codex-settings': { harness: 'codex', flags: ['--y'] },
        },
        modelSets: { 'codex-models': { models: ['gpt-6'], default: 'gpt-6' } },
      },
      profiles: {
        shared: { layers: ['instructions/main'] },
        claude: { layers: ['profile/shared', 'settings/claude-settings'] },
        legacy: { layers: ['settings/claude-settings', 'settings/codex-settings'] },
      },
    });

  it('should give each component its scope, a model set its ids’ harness', () => {
    // Act
    const catalog = componentCatalog(scoped(), factsOf());

    // Assert
    const scopes = catalog.kinds.flatMap(group => group.components.map(entry => [entry.reference, entry.scope]));
    should(scopes).deepEqual([
      ['instructions/main', 'generic'],
      ['settings/claude-settings', 'claude'],
      ['settings/codex-settings', 'codex'],
      ['modelSets/codex-models', 'codex'],
    ]);
    FleetComponentCatalogSchema.parse(catalog);
  });

  it('should derive each profile’s scope, and say why a mixed one is', () => {
    // Act
    const catalog = profileCatalog(scoped(), factsOf());

    // Assert
    should(profileNamed(catalog, 'shared').scope).deepEqual({ kind: 'scoped', scope: 'generic' });
    should(profileNamed(catalog, 'claude').scope).deepEqual({ kind: 'scoped', scope: 'claude' });
    should(profileNamed(catalog, 'legacy').scope).deepEqual({
      kind: 'mixed',
      sentence:
        "Profile legacy can't be both Claude only and Codex only: settings claude-settings is Claude only and settings codex-settings is Codex only.",
    });
    FleetLayeredProfileCatalogSchema.parse(catalog);
  });

  it('should refuse a mixed draft with the same sentence, naming an edited profile but not a new one', () => {
    // Act
    const fresh = profileDraftView(scoped(), { layers: ['profile/claude', 'modelSets/codex-models'] }, factsOf());
    const edited = profileDraftView(
      scoped(),
      { layers: ['profile/claude', 'modelSets/codex-models'], editing: 'legacy' },
      factsOf(),
    );

    // Assert
    const sentence =
      "can't be both Claude only and Codex only: profile claude is Claude only and model set codex-models is Codex only.";
    should(fresh.refusal).equal(`A profile ${sentence}`);
    should(fresh.scope).deepEqual({ kind: 'mixed', sentence: `A profile ${sentence}` });
    should(edited.refusal).equal(`Profile legacy ${sentence}`);
    FleetProfileDraftViewSchema.parse(fresh);
  });
});

describe('runtimeCatalog: a login or runtime switched off', () => {
  const NOW = Date.parse('2026-10-30T12:00:00Z');
  const disabledModel = (login: object | undefined, runtime: object | undefined): AccountModel =>
    parseAccountModel({
      version: 2,
      credentials: {
        work: { harness: 'claude', store: 'ferretry', ...(login === undefined ? {} : { disabled: login }) },
        home: { harness: 'claude', store: 'host' },
      },
      components: { modelSets: { fast: { models: ['claude-sonnet-5'], default: 'claude-sonnet-5' } } },
      profiles: { base: { layers: ['modelSets/fast'] } },
      runtimes: {
        a: {
          credential: 'work',
          profile: 'base',
          agent: true,
          ...(runtime === undefined ? {} : { disabled: runtime }),
        },
        b: { credential: 'home', profile: 'base', agent: true },
      },
    });
  const row = (model: AccountModel, name: string, now: number | undefined = NOW) =>
    runtimeCatalog(model, factsOf({ ...(now === undefined ? {} : { now }) })).runtimes.find(r => r.name === name);

  it('should refuse to launch a runtime that is off, name the one to use and show the switch', () => {
    // Act
    const actual = row(disabledModel(undefined, { reason: 'paused', until: '2026-11-01' }), 'a');

    // Assert
    should(actual?.launch).match({ available: false });
    should(actual?.launch.available === false ? actual.launch.reason : '').match(
      /runtime "a" is disabled \(paused\) until 2026-11-01.*Use "b" instead.*`fy runtime enable a`.*`fy migrate <id> -a b`/u,
    );
    should(actual?.disabled).eql({ reason: 'paused', until: '2026-11-01T00:00:00.000Z', source: 'runtime' });
    FleetRuntimeCatalogSchema.parse({ format: 'version-2', runtimes: [actual] });
  });

  it('should hold every runtime on a disabled login and say the switch is on the login', () => {
    // Act
    const actual = row(disabledModel({ reason: 'org spend limit' }, undefined), 'a');

    // Assert
    should(actual?.launch.available).be.false();
    should(actual?.disabled).eql({ reason: 'org spend limit', source: 'login' });
    should(row(disabledModel({}, undefined), 'b')?.disabled).be.undefined();
    should(row(disabledModel({}, undefined), 'b')?.launch).eql({ available: true });
  });

  it('should launch again once the until has passed, and show no switch', () => {
    // Act
    const actual = row(disabledModel(undefined, { until: '2026-10-30T11:00:00Z' }), 'a');

    // Assert
    should(actual?.launch).eql({ available: true });
    should(actual?.disabled).be.undefined();
  });

  it('should take the runtime switch over the login switch when both are on', () => {
    should(row(disabledModel({ reason: 'login' }, { reason: 'runtime' }), 'a')?.disabled).eql({
      reason: 'runtime',
      source: 'runtime',
    });
  });
});
