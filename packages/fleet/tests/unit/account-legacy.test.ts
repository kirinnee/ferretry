import { describe, it } from 'bun:test';
import should from 'should';
import {
  convertLegacyConfig,
  type LegacyConversion,
  readFleetDocument,
  slugName,
} from '../../src/lib/account/legacy.ts';
import { type FleetConfig, FleetConfigSchema } from '../../src/lib/config.ts';
import type { FleetLayout } from '../../src/lib/provisioning.ts';
import { buildFleetScaffold, fleetScaffoldIds } from '../../src/lib/scaffold.ts';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const LAYOUT: FleetLayout = {
  stateHome: '/fy',
  userHome: '/home/someone',
  fleetDirectory: '/fy/fleet',
  binDirectory: '/fy/fleet/bin',
  homesDirectory: '/fy/fleet/homes',
  assetsDirectory: '/fy/fleet/assets',
  manifestPath: '/fy/fleet/manifest.json',
  defaultHomeDirectories: { claude: '/home/someone/.claude', codex: '/home/someone/.codex' },
};

/** Today's real first run: the exact `config.yaml` `buildFleetScaffold` writes for a Claude + Codex host. */
const firstRunDocument = (): unknown => {
  let next = 0;
  const scaffold = buildFleetScaffold({
    layout: LAYOUT,
    ids: fleetScaffoldIds(() => id(next++)),
    configPath: '/fy/fleet/config.yaml',
    firstAccounts: ['claude', 'codex'],
  });
  return Bun.YAML.parse(scaffold.files[0]?.content ?? '');
};

/** A route that satisfies every availability rule, so a test only varies what it is about. */
const route = (n: number, wrapper: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: id(n),
  wrapper,
  home: wrapper,
  defaultModel: 'model-one',
  models: ['model-one'],
  ...overrides,
});

const parse = (input: Record<string, unknown>): FleetConfig => FleetConfigSchema.parse(input);

const convert = (input: Record<string, unknown>): LegacyConversion => convertLegacyConfig(parse(input));

const messages = (conversion: LegacyConversion): string[] => conversion.notes.map(note => note.message);

describe('convertLegacyConfig — the real first run', () => {
  it('should turn four accounts into four runtimes on two logins shared with the terminal', () => {
    // Arrange
    const config = FleetConfigSchema.parse(firstRunDocument());

    // Act
    const actual = convertLegacyConfig(config, { isHostLogin: () => true });

    // Assert
    should(actual.model.credentials).deepEqual({
      'claude-default': { harness: 'claude', store: 'host' },
      'codex-default': { harness: 'codex', store: 'host' },
    });
    should(actual.model.runtimes).deepEqual({
      'claude-default': { credential: 'claude-default', profile: 'claude-default', agent: false },
      'claude-auto-default': { credential: 'claude-default', profile: 'claude-auto-default', agent: true },
      'codex-default': { credential: 'codex-default', profile: 'codex-default', agent: false },
      'codex-auto-default': { credential: 'codex-default', profile: 'codex-auto-default', agent: true },
    });
    should(actual.model.machine.agentPermissions).equal('skip');
  });

  it('should give each lane its own instructions instead of concatenating the base and the auto document', () => {
    // Arrange — version 1 replaces memory; version 2 would concatenate two instruction layers
    const config = FleetConfigSchema.parse(firstRunDocument());

    // Act
    const actual = convertLegacyConfig(config);

    // Assert
    should(actual.model.profiles).deepEqual({
      'claude-default': { layers: ['instructions/claude', 'settings/claude', 'modelSets/claude-models'] },
      'claude-auto-default': {
        layers: [
          'instructions/claude-auto',
          'settings/claude',
          'settings/claude-auto-default-settings',
          'modelSets/claude-models',
        ],
      },
      'codex-default': { layers: ['instructions/codex', 'settings/codex', 'modelSets/codex-models'] },
      'codex-auto-default': { layers: ['instructions/codex-auto', 'settings/codex', 'modelSets/codex-models'] },
    });
    should(actual.model.components.instructions).deepEqual({
      claude: { file: './CLAUDE.md', harness: 'claude' },
      'claude-auto': { file: './CLAUDE-auto.md', harness: 'claude' },
      codex: { file: './AGENTS.md', harness: 'codex' },
      'codex-auto': { file: './AGENTS-auto.md', harness: 'codex' },
    });
  });

  it('should hand the permission and fixed-layer flags of the auto lane to Agent permissions', () => {
    // Arrange
    const config = FleetConfigSchema.parse(firstRunDocument());

    // Act
    const actual = convertLegacyConfig(config);

    // Assert — no launch-flag settings were made, because every auto flag is a fixed-layer one
    should(Object.keys(actual.model.components.settings).sort()).deepEqual([
      'claude',
      'claude-auto-default-settings',
      'codex',
    ]);
    should(actual.settingsBodies).deepEqual([
      {
        component: 'claude-auto-default-settings',
        harness: 'claude',
        file: 'components/settings/claude-auto-default-settings.json',
        format: 'json',
        content: { skipDangerousModePermissionPrompt: true },
      },
    ]);
  });

  it('should keep every route id, wrapper and home for ids.json', () => {
    // Arrange
    const config = FleetConfigSchema.parse(firstRunDocument());

    // Act
    const actual = convertLegacyConfig(config);

    // Assert
    should(actual.runtimes['codex-auto-default']).deepEqual({
      routeId: id(3),
      wrapper: 'codex-auto-default',
      home: 'codex-auto-default',
      agent: 'default',
      variant: 'auto',
      harness: 'codex',
    });
    should(actual.credentials['claude-default']).deepEqual({
      key: 'claude:default',
      harness: 'claude',
      identity: 'default',
      routeIds: [id(0), id(1)],
    });
  });

  it('should keep logins with Ferretry when the caller does not say they are the host login', () => {
    // Act
    const actual = convertLegacyConfig(FleetConfigSchema.parse(firstRunDocument()));

    // Assert
    should(actual.model.credentials['claude-default']?.store).equal('ferretry');
  });

  it('should say, once, that the profiles are flat, and what else changed', () => {
    // Act
    const actual = convertLegacyConfig(FleetConfigSchema.parse(firstRunDocument()));

    // Assert
    should(messages(actual)).containEql(
      'each runtime gets one flat profile holding what it used; you can split it into layers later',
    );
    should(messages(actual)).containEql('history is now shared by every claude runtime');
    should(messages(actual)).containEql(
      'display name "Claude (default)" is not carried; a runtime is shown by its name',
    );
  });
});

describe('convertLegacyConfig — a hand-built fleet', () => {
  /**
   * Shaped like the owner's: several logins, base and named profiles, a third variant, per-route
   * layers, an API-key account, commands and aliases.
   */
  const ownerLike = (): Record<string, unknown> => ({
    secretsFile: '~/.secrets',
    shared: { memory: { main: './CLAUDE.md' } },
    profiles: {
      base: {
        claude: { memory: './CLAUDE.md', settings: './templates/claude/settings.json' },
        codex: { memory: './CLAUDE.md', settings: './templates/codex/config.toml' },
      },
      reviewer: {
        skills: ['review', 'pr-review', 'review'],
        claude: { hooks: './hooks/claude.json' },
        codex: {
          hooks: './hooks/codex.json',
          hooksDir: './hooks/scripts',
          settings: [{ model_reasoning_effort: 'high' }],
        },
      },
      tools: { mcp: './mcp/servers.json' },
    },
    variants: {
      default: {},
      auto: {
        mode: 'auto',
        claude: { flags: ['--dangerously-skip-permissions', '--disallowed-tools=AskUserQuestion'] },
        codex: { flags: ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'] },
      },
      f5: { profiles: ['reviewer'], flags: ['--verbose'], env: { LOG_LEVEL: 'debug' } },
    },
    agents: [
      {
        name: 'kirin',
        kind: 'claude',
        profiles: ['tools'],
        routes: {
          default: route(1, 'claude-kirin'),
          auto: route(2, 'claude-auto-kirin'),
          f5: route(3, 'claude.f5.kirin', {
            layer: { memory: './accounts/f5/CLAUDE.md' },
            models: [
              'claude-opus-5-5',
              { id: 'claude-haiku-5-5', available: false, unavailableReason: 'not on this plan' },
            ],
            defaultModel: 'claude-opus-5-5',
          }),
        },
      },
      {
        name: 'work',
        kind: 'claude',
        env: { ANTHROPIC_BASE_URL: 'https://proxy.example.test' },
        routes: { default: route(4, 'claude-work') },
      },
      {
        name: 'api',
        kind: 'claude',
        auth: 'api-key',
        env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' },
        routes: {
          default: route(5, 'claude-api'),
          auto: route(6, 'claude-auto-api', { layer: { env: { ANTHROPIC_API_KEY: '${secret:OTHER_KEY}' } } }),
        },
      },
      {
        name: 'kirin',
        kind: 'codex',
        profiles: ['tools'],
        routes: {
          default: route(7, 'codex-kirin', { models: ['gpt-6', 'gpt-6-mini'], defaultModel: 'gpt-6' }),
          auto: route(8, 'codex-auto-kirin', { models: ['gpt-6', 'gpt-6-mini'], defaultModel: 'gpt-6' }),
          f5: route(9, 'codex-f5-kirin', {
            available: false,
            unavailableReason: 'paused',
            defaultModel: undefined,
            models: [],
          }),
        },
      },
    ],
    commands: [
      { wrapper: 'claude-fast', target: id(1), flags: ['--model', 'claude-haiku-5-5'] },
      { wrapper: 'claude.slow', target: id(1) },
    ],
    aliases: { yolo: { claude: '--dangerously-skip-permissions' } },
    defaultHomes: { claude: id(1) },
    health: { enabled: true },
    sharedHistory: { claude: true },
  });

  it('should make one credential per login group, keeping an API key in the environment', () => {
    // Act
    const actual = convertLegacyConfig(parse(ownerLike()), { isHostLogin: origin => origin.identity !== 'api' });

    // Assert
    should(actual.model.credentials).deepEqual({
      'claude-kirin': { harness: 'claude', store: 'host' },
      'claude-work': { harness: 'claude', store: 'ferretry' },
      'claude-api': { harness: 'claude', store: 'environment', env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } },
      'codex-kirin': { harness: 'codex', store: 'host' },
    });
    should(messages(actual)).containEql(
      'login claude-work would be a second claude login shared with your terminal, and a machine has one — it is kept by Ferretry instead',
    );
    should(messages(actual)).containEql(
      'claude-auto-api sets ANTHROPIC_API_KEY differently from the other runtimes on login claude-api; the first value is kept',
    );
  });

  it('should make one runtime per route, renaming only names version 2 cannot spell', () => {
    // Act
    const actual = convert(ownerLike());

    // Assert
    should(Object.keys(actual.model.runtimes)).deepEqual([
      'claude-kirin',
      'claude-auto-kirin',
      'claude-f5-kirin',
      'claude-work',
      'claude-api',
      'claude-auto-api',
      'codex-kirin',
      'codex-auto-kirin',
      'codex-f5-kirin',
    ]);
    should(actual.runtimes['claude-f5-kirin']?.wrapper).equal('claude.f5.kirin');
    should(messages(actual)).containEql(
      'claude.f5.kirin is named claude-f5-kirin as a runtime (letters, digits and dashes only); the old name still starts it',
    );
    should(actual.model.runtimes['claude-auto-kirin']?.agent).be.true();
    should(actual.model.runtimes['claude-f5-kirin']?.agent).be.false();
  });

  it('should keep a non-permission flag and the environment as launch settings', () => {
    // Act
    const actual = convert(ownerLike());

    // Assert — the f5 lane's flag and variable still reach the runtime
    should(actual.model.components.settings['claude-f5-kirin-launch']).deepEqual({
      harness: 'claude',
      flags: ['--verbose'],
      env: { LOG_LEVEL: 'debug' },
    });
    should(actual.model.components.settings['claude-work-launch']).deepEqual({
      harness: 'claude',
      env: { ANTHROPIC_BASE_URL: 'https://proxy.example.test' },
    });
  });

  it('should never repeat a credential variable in a runtime settings component', () => {
    // Act
    const actual = convert(ownerLike());

    // Assert
    const everyEnv = Object.values(actual.model.components.settings).flatMap(settings =>
      Object.keys(settings.env ?? {}),
    );
    should(everyEnv).not.containEql('ANTHROPIC_API_KEY');
  });

  it('should carry hooks to Codex only, and an MCP list for Claude only, as version 1 delivered them', () => {
    // Act
    const actual = convert(ownerLike());

    // Assert
    should(actual.model.components.hooks).deepEqual({
      'codex-codex': { harness: 'codex', file: './hooks/codex.json' },
      'codex-scripts': { harness: 'codex', directory: './hooks/scripts' },
    });
    should(messages(actual)).containEql(
      'hooks "./hooks/claude.json" had no effect on claude in version 1, so it is not carried',
    );
    should(messages(actual)).containEql(
      'mcp "./mcp/servers.json" had no effect on codex in version 1, so it is not carried',
    );
    should(actual.pendingMcp).deepEqual([
      {
        harness: 'claude',
        file: './mcp/servers.json',
        profiles: ['claude-kirin', 'claude-auto-kirin', 'claude-f5-kirin'],
      },
    ]);
  });

  it('should collapse identical skill selections and keep one instructions document both harnesses read', () => {
    // Act
    const actual = convert(ownerLike());

    // Assert
    should(actual.model.components.skills).deepEqual({ 'claude-f5-kirin-skills': { items: ['review', 'pr-review'] } });
    should(actual.model.components.instructions.main).deepEqual({ file: './CLAUDE.md' });
    should(actual.model.profiles['codex-f5-kirin']?.layers).containEql('skills/claude-f5-kirin-skills');
  });

  it('should write an inline Codex settings object as a TOML body', () => {
    // Act
    const actual = convert(ownerLike());

    // Assert
    should(actual.settingsBodies).containEql({
      component: 'codex-f5-kirin-settings',
      harness: 'codex',
      file: 'components/settings/codex-f5-kirin-settings.toml',
      format: 'toml',
      content: { model_reasoning_effort: 'high' },
    });
  });

  it('should collapse identical model lists, leave unavailable models out and say so', () => {
    // Act
    const actual = convert(ownerLike());

    // Assert
    should(actual.model.components.modelSets).deepEqual({
      'claude-models': { models: ['model-one'], default: 'model-one' },
      'claude-models-2': { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' },
      'codex-models': { models: ['gpt-6', 'gpt-6-mini'], default: 'gpt-6' },
    });
    should(messages(actual)).containEql(
      'model claude-haiku-5-5 was declared unavailable (not on this plan) and is left out',
    );
    should(messages(actual)).containEql(
      'codex-f5-kirin was declared unavailable (paused); runtimes have no such switch',
    );
    should(actual.model.profiles['codex-f5-kirin']?.layers.some(layer => layer.startsWith('modelSets/'))).be.false();
  });

  it('should target commands by runtime name and carry aliases and the secrets file', () => {
    // Act
    const actual = convert(ownerLike());

    // Assert
    should(actual.model.advanced.commands).deepEqual([
      { wrapper: 'claude-fast', runtime: 'claude-kirin', flags: ['--model', 'claude-haiku-5-5'] },
      { wrapper: 'claude-slow', runtime: 'claude-kirin', flags: [] },
    ]);
    should(messages(actual)).containEql('command claude.slow is named claude-slow (letters, digits and dashes only)');
    should(actual.model.advanced.aliases).deepEqual({ yolo: { claude: '--dangerously-skip-permissions' } });
    should(actual.model.advanced.secretsFile).equal('~/.secrets');
  });

  it('should note what has no place in version 2', () => {
    // Act
    const actual = convert(ownerLike());

    // Assert
    should(messages(actual)).containEql("health probes are gone; a login's status comes from free usage reads instead");
    should(messages(actual)).containEql(
      'the bare claude command is no longer pointed at a runtime; your own claude keeps its own setup',
    );
    should(messages(actual)).not.containEql('history is now shared by every claude runtime');
    should(messages(actual)).containEql('history is now shared by every codex runtime');
  });
});

describe('convertLegacyConfig — edges', () => {
  it('should choose Auto mode when not every agent runtime skipped permissions, and name the one that did', () => {
    // Arrange — an `auto`-mode route on the default lane carries no skip flag
    const input = {
      variants: { default: {}, auto: { mode: 'auto', flags: ['--dangerously-skip-permissions'] } },
      agents: [
        {
          name: 'a',
          kind: 'claude',
          routes: { default: route(1, 'claude-a', { mode: 'auto' }), auto: route(2, 'claude-auto-a') },
        },
      ],
    };

    // Act
    const actual = convert(input);

    // Assert
    should(actual.model.machine.agentPermissions).equal('auto');
    should(messages(actual)).containEql(
      'claude-auto-a skipped every permission check, but not every agent runtime did, so agents use Auto mode; choose "Skip all permission checks" in Agent permissions to keep the old behaviour',
    );
  });

  it('should keep a permission flag on a runtime that is not an agent, because it still launches with it', () => {
    // Arrange
    const input = {
      agents: [
        {
          name: 'a',
          kind: 'claude',
          flags: ['--dangerously-skip-permissions'],
          routes: { default: route(1, 'claude-a') },
        },
      ],
    };

    // Act
    const actual = convert(input);

    // Assert
    should(actual.model.machine.agentPermissions).equal('auto');
    should(actual.model.components.settings['claude-a-launch']).deepEqual({
      harness: 'claude',
      flags: ['--dangerously-skip-permissions'],
    });
  });

  it('should treat a route of the auto lane as an agent unless the route says it is interactive', () => {
    // Arrange
    const input = {
      variants: { default: {}, auto: {} },
      agents: [
        {
          name: 'a',
          kind: 'codex',
          routes: { default: route(1, 'codex-a'), auto: route(2, 'codex-auto-a') },
        },
        { name: 'b', kind: 'codex', routes: { auto: route(3, 'codex-auto-b', { mode: 'interactive' }) } },
      ],
    };

    // Act
    const actual = convert(input);

    // Assert
    should(actual.model.runtimes['codex-auto-a']?.agent).be.true();
    should(actual.model.runtimes['codex-auto-b']?.agent).be.false();
  });

  it('should make a sign-in slot for an API-key account that names no key, and say why', () => {
    // Arrange
    const input = { agents: [{ name: 'k', kind: 'codex', auth: 'api-key', routes: { default: route(1, 'codex-k') } }] };

    // Act
    const actual = convert(input);

    // Assert
    should(actual.model.credentials['codex-k']).deepEqual({ harness: 'codex', store: 'ferretry' });
    should(messages(actual)).containEql(
      'login codex-k is declared "auth: api-key" but nothing says where its key comes from, so it becomes a login that needs sign-in',
    );
  });

  it('should fall back to the first available model when the default is not one', () => {
    // Arrange — an unavailable account may name no default
    const input = {
      agents: [
        {
          name: 'a',
          kind: 'claude',
          routes: {
            default: route(1, 'claude-a', {
              available: false,
              unavailableReason: 'paused',
              defaultModel: undefined,
              models: ['m1', 'm2'],
            }),
          },
        },
      ],
    };

    // Act
    const actual = convert(input);

    // Assert
    should(actual.model.components.modelSets['claude-models']).deepEqual({ models: ['m1', 'm2'], default: 'm1' });
  });

  it('should give every runtime of one MCP file its own profile, even when their layers match', () => {
    // Arrange
    const input = {
      agents: [
        {
          name: 'a',
          kind: 'claude',
          mcp: './mcp.json',
          routes: { default: route(1, 'claude-a'), other: route(2, 'claude-b') },
        },
      ],
      variants: { default: {}, other: {} },
    };

    // Act
    const actual = convert(input);

    // Assert
    should(actual.model.runtimes['claude-a']?.profile).equal('claude-a');
    should(actual.model.runtimes['claude-b']?.profile).equal('claude-b');
    should(actual.pendingMcp).deepEqual([
      { harness: 'claude', file: './mcp.json', profiles: ['claude-a', 'claude-b'] },
    ]);
  });

  it('should share one profile between runtimes that resolve to the same layers', () => {
    // Arrange
    const input = {
      agents: [
        { name: 'a', kind: 'claude', routes: { default: route(1, 'claude-a') } },
        { name: 'b', kind: 'claude', routes: { default: route(2, 'claude-b') } },
      ],
    };

    // Act
    const actual = convert(input);

    // Assert
    should(actual.model.profiles).deepEqual({ 'claude-a': { layers: ['modelSets/claude-models'] } });
    should(actual.model.runtimes['claude-b']?.profile).equal('claude-a');
  });

  it('should give a clashing renamed runtime the next free name', () => {
    // Arrange — `claude.a` and `claude_a` both slug to `claude-a`, which is also taken
    const input = {
      agents: [
        { name: 'x', kind: 'claude', routes: { default: route(1, 'claude-a') } },
        { name: 'y', kind: 'claude', routes: { default: route(2, 'claude.a') } },
        { name: 'z', kind: 'claude', routes: { default: route(3, 'claude_a') } },
      ],
    };

    // Act
    const actual = convert(input);

    // Assert
    should(Object.keys(actual.model.runtimes)).deepEqual(['claude-a', 'claude-a-2', 'claude-a-3']);
  });

  it('should keep an empty fleet empty, with nothing to say about profiles', () => {
    // Act
    const actual = convert({});

    // Assert
    should(actual.model.runtimes).deepEqual({});
    should(actual.model.credentials).deepEqual({});
    should(messages(actual)).deepEqual([
      'history is now shared by every claude runtime',
      'history is now shared by every codex runtime',
    ]);
  });

  it('should skip a command whose target is not a declared route in a hand-built value', () => {
    // Arrange — the schema refuses this, so only a value built by hand can reach it
    const config = { ...parse({}), commands: [{ wrapper: 'stray', target: id(9), flags: [] }] };

    // Act
    const actual = convertLegacyConfig(config);

    // Assert
    should(actual.model.advanced.commands).deepEqual([]);
  });
});

describe('slugName', () => {
  it.each([
    ['claude-default', 'claude-default'],
    ['claude.f5 kirin', 'claude-f5-kirin'],
    ['--a__b--', 'a-b'],
    ['…', 'fallback'],
  ])('should spell %p as %p', (value, expected) => {
    // Assert
    should(slugName(value, 'fallback')).equal(expected);
  });

  it('should stay within the name limit', () => {
    // Assert
    should(slugName('a'.repeat(80), 'fallback')).have.length(64);
  });
});

describe('readFleetDocument', () => {
  it('should read a version-2 document as the model', () => {
    // Act
    const actual = readFleetDocument({ version: 2 });

    // Assert
    should(actual.version).equal(2);
    should(actual.version === 2 && actual.model.runtimes).deepEqual({});
  });

  it('should read a document with no version as version 1, and convert it', () => {
    // Act
    const actual = readFleetDocument(firstRunDocument(), { isHostLogin: () => true });

    // Assert
    should(actual.version).equal(1);
    if (actual.version !== 1) return;
    should(actual.config.agents).have.length(2);
    should(Object.keys(actual.conversion.model.runtimes)).have.length(4);
    should(actual.conversion.model.credentials['codex-default']?.store).equal('host');
  });

  it('should read "version: 1" as version 1', () => {
    // Act
    const actual = readFleetDocument({ version: 1, agents: [] });

    // Assert
    should(actual.version).equal(1);
  });

  it('should read an empty file as an empty version-1 fleet', () => {
    // Act
    const actual = readFleetDocument(null);

    // Assert
    should(actual.version).equal(1);
  });

  it('should check any other version against version 2, which names what it expected', () => {
    // Act
    const actual = (): unknown => readFleetDocument({ version: 3 });

    // Assert
    should(actual).throw(/expected 2/);
  });

  it('should refuse a document that is not a mapping, exactly as version 1 does', () => {
    // Act
    const actual = (): unknown => readFleetDocument(['agents']);

    // Assert
    should(actual).throw();
  });
});
