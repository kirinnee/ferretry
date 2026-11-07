/**
 * The wire shape of the account model's catalogue and its reviewed changes.
 *
 * Every object is strict, so a field the daemon grew without declaring it — or a credential value
 * somebody tried to smuggle into an environment entry — is REFUSED rather than stripped.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type {
  AccountChangeView,
  ComponentView,
  LayeredProfileView,
  RuntimeView,
} from '../../../contract/index.ts';
import * as catalog from '../../../contract/wire/catalog.ts';
import { INSTANT } from './fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const component = {
  reference: 'mcp/notes',
  kind: 'mcp',
  name: 'notes',
  scope: 'generic',
  detail: {
    kind: 'mcp',
    command: 'uvx',
    args: ['notes-server'],
    env: [
      { name: 'NOTES_DIR', value: '/srv/notes' },
      { name: 'NOTES_TOKEN', hidden: true },
    ],
  },
  partial: [{ harness: 'codex', reason: 'Codex ignores its url.' }],
  warnings: ['Command not found: uvx'],
  usedBy: { profiles: ['default'], runtimes: ['claude-default'] },
  editNote: 'Used by 1 profile and 1 runtime. Saving changes it everywhere.',
  remove: { available: false, reason: 'It is a layer in default. Remove it from that profile first.' },
  content: { form: 'text', text: 'TOKEN=‹hidden›', redacted: true },
  checkPath: '/Users/other/notes',
} satisfies ComponentView;

const stack = {
  harness: 'claude-code',
  available: { available: true },
  applied: ['instructions/main', 'mcp/notes'],
  skipped: [
    { reference: 'settings/codex', sentence: 'Settings codex is for Codex only, so it is skipped on Claude Code.' },
  ],
  conflicts: [
    {
      harness: 'claude-code',
      field: 'settings',
      key: 'permissions.defaultMode',
      sentence: '`permissions.defaultMode` · Claude Code: acceptEdits (from agent) overrides plan (from default)',
      winner: 'agent',
      overridden: ['default'],
    },
  ],
  partial: [],
} as const;

const profile = {
  name: 'default',
  layers: ['instructions/main', 'mcp/notes'],
  usedBy: ['claude-default'],
  baseFor: [],
  wouldIncludeItself: ['default'],
  scope: { kind: 'scoped', scope: 'claude-code' },
  harnesses: [stack],
  remove: { available: true },
} satisfies LayeredProfileView;

const runtime = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'claude-default',
  wrapper: 'claude-default',
  harness: 'claude-code',
  credential: { id: 'claude-you', store: 'host', status: 'ready' },
  profile: 'default',
  agent: true,
  stack,
  modelSet: {
    source: 'model-set',
    name: 'models',
    models: [{ id: 'claude-opus-5-5', available: true }],
    declaredDefault: 'claude-opus-5-5',
    default: 'claude-opus-5-5',
  },
  fixedLayer: {
    agentPermissions: 'auto',
    entries: [{ key: 'permission mode', value: 'auto' }],
    overridden: [
      {
        key: 'permissions.defaultMode',
        value: 'plan',
        from: 'default',
        sentence: 'From your default · Overridden for agents by Ferretry',
      },
    ],
  },
  launch: { available: true },
  sameAs: [],
} satisfies RuntimeView;

const MACHINE_SETTINGS = {
  kind: 'machine.settings',
  agentPermissions: 'auto',
  defaultRuntime: null,
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  browserMode: 'headless',
  browserProxy: null,
  browserPorts: 'random',
  browserFirewallFailure: 'warn',
  autoResume: true,
  agendaMode: false,
  publicUsageFeed: false,
} as const;

const change = {
  kind: 'component.put',
  name: 'main',
  component: { kind: 'instructions' },
  content: 'Main guidance.\n',
  create: true,
} as const;

const view = {
  id: 'fy_fprop_abcdefghijklmnopqrstuv',
  revision: 'absent',
  change: { kind: 'component.put', name: 'main', component: { kind: 'instructions' }, create: true },
  summary: 'Add instructions main',
  consequences: [],
  expiresAt: INSTANT,
  state: 'pending',
  preview: {
    kind: 'apply',
    operations: [
      { kind: 'credential-link', source: '/fy/fleet/credentials/codex/auth.json', path: '/fy/homes/x/auth.json' },
    ],
    documents: [{ path: '/fy/fleet/config.yaml', bytes: 120 }],
    runtimes: [{ name: 'claude-default', harness: 'claude-code', agent: true, launch: { available: true } }],
  },
} satisfies AccountChangeView;

const cases: readonly SchemaCase[] = [
  { name: 'ComponentNameSchema', schema: catalog.ComponentNameSchema, value: 'main notes' },
  { name: 'ComponentKindSchema', schema: catalog.ComponentKindSchema, value: 'modelSets' },
  { name: 'CatalogFormatSchema', schema: catalog.CatalogFormatSchema, value: 'none' },
  { name: 'HarnessScopeSchema', schema: catalog.HarnessScopeSchema, value: 'codex' },
  {
    name: 'ProfileScopeSchema',
    schema: catalog.ProfileScopeSchema,
    value: { kind: 'mixed', sentence: "Profile default can't be both Claude only and Codex only." },
  },
  { name: 'CatalogActSchema', schema: catalog.CatalogActSchema, value: { available: true } },
  {
    name: 'MachineToolSchema',
    schema: catalog.MachineToolSchema,
    value: { harness: 'codex', label: 'Codex', installed: false },
  },
  {
    name: 'MachineViewSchema',
    schema: catalog.MachineViewSchema,
    value: {
      name: 'studio',
      format: 'none',
      setUp: false,
      agentPermissions: 'skip',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
      browserMode: 'headless',
      browserProxy: null,
      browserPorts: 'random',
      browserFirewallFailure: 'warn',
      autoResume: true,
      agendaMode: false,
      publicUsageFeed: false,
      lastAutoResume: null,
      tools: [{ harness: 'claude-code', label: 'Claude Code', installed: true, command: '/usr/bin/claude' }],
      runtimeCount: 0,
      runningSessions: 2,
      authority: { mayApply: false, applyRefusal: 'step-up-required' },
    },
  },
  {
    name: 'MachineAuthoritySchema',
    schema: catalog.MachineAuthoritySchema,
    value: { mayApply: true, applyRefusal: 'granted' },
  },
  {
    name: 'AgentControlSchema',
    schema: catalog.AgentControlSchema,
    value: { terminals: true, browsers: false, files: true, ferretrySettings: true, pageScripts: false },
  },
  { name: 'EnvEntrySchema', schema: catalog.EnvEntrySchema, value: { name: 'API_KEY', hidden: true } },
  { name: 'ComponentDetailSchema', schema: catalog.ComponentDetailSchema, value: component.detail },
  { name: 'ComponentUsageSchema', schema: catalog.ComponentUsageSchema, value: component.usedBy },
  { name: 'PartialSupportSchema', schema: catalog.PartialSupportSchema, value: component.partial[0] },
  { name: 'ComponentViewSchema', schema: catalog.ComponentViewSchema, value: component },
  {
    name: 'ComponentGroupSchema',
    schema: catalog.ComponentGroupSchema,
    value: { kind: 'mcp', label: 'MCP servers', description: 'Tools a session can call.', components: [component] },
  },
  {
    name: 'ComponentCatalogSchema',
    schema: catalog.ComponentCatalogSchema,
    value: { format: 'present', kinds: [] },
  },
  { name: 'LayerConflictSchema', schema: catalog.LayerConflictSchema, value: stack.conflicts[0] },
  { name: 'SkippedLayerSchema', schema: catalog.SkippedLayerSchema, value: stack.skipped[0] },
  { name: 'StackViewSchema', schema: catalog.StackViewSchema, value: stack },
  { name: 'LayeredProfileViewSchema', schema: catalog.LayeredProfileViewSchema, value: profile },
  {
    name: 'LayeredProfileCatalogSchema',
    schema: catalog.LayeredProfileCatalogSchema,
    value: { format: 'present', profiles: [profile] },
  },
  {
    name: 'RuntimeModelSetSchema',
    schema: catalog.RuntimeModelSetSchema,
    value: { source: 'harness-default' },
  },
  {
    name: 'RuntimeModelChoiceSchema',
    schema: catalog.RuntimeModelChoiceSchema,
    value: {
      id: 'glm-5.3',
      label: 'GLM-5.3',
      tier: 'best',
      context: 1_000_000,
      reasoning: true,
      efforts: ['low'],
      defaultEffort: 'low',
      note: 'Fast.',
      available: true,
    },
  },
  {
    name: 'RuntimeModelsSchema',
    schema: catalog.RuntimeModelsSchema,
    value: {
      catalog: {
        id: 'ollama',
        label: 'Ollama',
        origin: 'file',
        customIds: true,
        docs: 'https://docs.ollama.com',
        detect: 'ollama',
      },
      choices: [{ id: 'gpt-oss:20b', label: 'gpt-oss 20B', efforts: [], available: true, local: true }],
      default: 'gpt-oss:20b',
      local: {
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        state: 'none-pulled',
        models: [],
        checkedAt: '2026-10-19T00:00:00.000Z',
        message: 'Ollama is running, but no model is installed yet. Run: ollama pull gpt-oss:20b',
        pullCommand: 'ollama pull gpt-oss:20b',
      },
    },
  },
  { name: 'FixedLayerViewSchema', schema: catalog.FixedLayerViewSchema, value: runtime.fixedLayer },
  { name: 'RuntimeViewSchema', schema: catalog.RuntimeViewSchema, value: runtime },
  {
    name: 'RuntimeViewSchema switched off',
    schema: catalog.RuntimeViewSchema,
    value: { ...runtime, disabled: { reason: 'resting it', source: 'runtime' } },
  },
  {
    name: 'RuntimeViewSchema with items the last apply skipped',
    schema: catalog.RuntimeViewSchema,
    value: { ...runtime, skipped: ['skills/review', 'commands/ship.md'] },
  },
  {
    name: 'RuntimeCatalogSchema',
    schema: catalog.RuntimeCatalogSchema,
    value: { format: 'present', runtimes: [runtime] },
  },
  {
    name: 'EnvInputSchema',
    schema: catalog.EnvInputSchema,
    value: { NOTES_DIR: '/srv/notes', NOTES_TOKEN: { keep: true } },
  },
  {
    name: 'ComponentInputSchema',
    schema: catalog.ComponentInputSchema,
    value: { kind: 'settings', harness: 'claude-code', flags: ['--verbose'], env: { LOG: 'debug' } },
  },
  { name: 'AccountChangeSchema', schema: catalog.AccountChangeSchema, value: change },
  {
    name: 'CatalogInstallChangeSchema',
    schema: catalog.CatalogInstallChangeSchema,
    value: {
      kind: 'catalog.install',
      name: 'pdf-tools',
      component: { kind: 'skills', items: ['pdf-tools'] },
      files: [{ path: 'SKILL.md', content: '# pdf\n' }],
      profile: 'work',
      installedFrom: {
        publisher: `fy_daemon_${'p'.repeat(43)}`,
        publisherName: 'kirin-box',
        catalogId: `cat_${'c'.repeat(22)}`,
        catalogName: 'Catalog',
        itemId: `itm_${'i'.repeat(22)}`,
        kind: 'skill',
        name: 'pdf-tools',
        version: 1,
        digest: `sha256:${'a'.repeat(64)}`,
      },
      replace: false,
    },
  },
  { name: 'AccountChangeRequestSchema', schema: catalog.AccountChangeRequestSchema, value: { change } },
  {
    name: 'ChangedRuntimeSchema',
    schema: catalog.ChangedRuntimeSchema,
    value: view.preview.runtimes[0],
  },
  {
    name: 'RunningSessionSchema',
    schema: catalog.RunningSessionSchema,
    value: { id: 'ms0v8vgc-d445a669', name: 'Fisher', harness: 'codex' },
  },
  {
    name: 'AccountChangePreviewSchema',
    schema: catalog.AccountChangePreviewSchema,
    value: { kind: 'sign-out', credential: 'codex-work', runtimesAffected: 2, signsOutTerminal: false },
  },
  {
    name: 'AccountChangePreviewSchema',
    schema: catalog.AccountChangePreviewSchema,
    value: {
      kind: 'apply',
      operations: [],
      documents: [],
      runtimes: [],
      runningSessions: [{ id: 'ms0v8vgc-d445a669', name: 'Fisher', harness: 'codex' }],
    },
  },
  { name: 'AccountChangeViewSchema', schema: catalog.AccountChangeViewSchema, value: view },
  {
    name: 'AccountChangeOutcomeSchema',
    schema: catalog.AccountChangeOutcomeSchema,
    value: { outcome: 'executed', executor: 'clone', summary: 'Cloned 3 runtimes' },
  },
  { name: 'CatalogRefusalCodeSchema', schema: catalog.CatalogRefusalCodeSchema, value: 'fleet_change_stale' },
  {
    name: 'SettingsEntrySchema',
    schema: catalog.SettingsEntrySchema,
    value: { key: 'permissions.defaultMode', value: 'plan' },
  },
  {
    name: 'ComponentContentSchema',
    schema: catalog.ComponentContentSchema,
    value: {
      form: 'entries',
      entries: [
        { key: 'env.API_TOKEN', hidden: true },
        { key: 'theme', value: 'dark' },
      ],
    },
  },
  {
    name: 'SettingsEntriesInputSchema',
    schema: catalog.SettingsEntriesInputSchema,
    value: { theme: { value: 'dark' }, 'env.API_TOKEN': { keep: true }, 'permissions.allow': { value: ['Bash'] } },
  },
  {
    name: 'ProfileDraftRequestSchema',
    schema: catalog.ProfileDraftRequestSchema,
    value: { layers: ['profile/default', 'mcp/notes'], editing: 'agent' },
  },
  {
    name: 'ResolvedFieldSchema',
    schema: catalog.ResolvedFieldSchema,
    value: 'env',
  },
  {
    name: 'ResolvedSetterSchema',
    schema: catalog.ResolvedSetterSchema,
    value: { value: '‹hidden›', hidden: true, from: 'settings/claude' },
  },
  {
    name: 'ResolvedEntrySchema',
    schema: catalog.ResolvedEntrySchema,
    value: {
      harness: 'claude-code',
      field: 'settings',
      key: 'permissions.defaultMode',
      value: 'acceptEdits',
      from: 'settings/agent',
      overridden: [{ value: 'plan', from: 'profile/default' }],
    },
  },
  {
    name: 'ProfileDraftViewSchema',
    schema: catalog.ProfileDraftViewSchema,
    value: {
      harnesses: [stack],
      resolved: [],
      scope: { kind: 'scoped', scope: 'generic' },
      refusal: 'no profile ghost exists on this machine',
    },
  },
];

const rejects = (name: string, schema: SchemaCase['schema'], value: unknown): SchemaCase => ({ name, schema, value });

describe('the account-model catalogue wire contract', () => {
  it('should round-trip every shape a browser reads and every change it may send', () => {
    // Act & Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(catalog, cases);
  });

  it('should accept every kind of change the catalogue stages', () => {
    // Arrange
    const changes = [
      {
        kind: 'runtime.put',
        name: 'Claude Review',
        credential: 'claude-you',
        profile: 'default',
        agent: false,
        create: true,
      },
      { kind: 'runtime.remove', name: 'claude-review' },
      { kind: 'runtime.rename', name: 'claude-review', to: 'claude-reviewer' },
      { kind: 'profile.put', name: 'agent', layers: ['profile/default', 'settings/claude'], create: false },
      { kind: 'profile.remove', name: 'agent', switchRuntimesTo: 'default', removeFromProfiles: true },
      {
        kind: 'component.put',
        name: 'claude',
        component: { kind: 'settings', harness: 'claude-code', entries: { theme: { value: 'dark' } } },
        create: false,
      },
      { kind: 'component.remove', componentKind: 'skills', name: 'mine', removeFromProfiles: true },
      { kind: 'credential.add', id: 'codex-work', harness: 'codex', label: 'work' },
      {
        kind: 'credential.add',
        id: 'glm',
        harness: 'claude-code',
        store: 'environment',
        preset: 'zai-glm',
        env: { ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}' },
        cloudCredential: 'azure-cli',
      },
      { kind: 'credential.env', id: 'glm', env: { ANTHROPIC_AUTH_TOKEN: { keep: true } }, cloudCredential: null },
      { kind: 'credential.label', id: 'codex-work', label: null },
      { kind: 'credential.disable', id: 'codex-work', reason: 'spend limit', until: '2026-11-01T00:00:00.000Z' },
      { kind: 'credential.disable', id: 'codex-work' },
      { kind: 'credential.enable', id: 'codex-work' },
      { kind: 'runtime.disable', name: 'claude-review', reason: 'resting it' },
      { kind: 'runtime.enable', name: 'claude-review' },
      { kind: 'credential.remove', id: 'codex-work' },
      {
        kind: 'credential.remove',
        id: 'codex-work',
        switchRuntimes: { alpha: 'codex-spare' },
        removeRuntimes: ['beta'],
        defaultRuntime: 'alpha',
      },
      { kind: 'credential.signout', id: 'codex-work' },
      { ...MACHINE_SETTINGS, defaultRuntime: 'claude-default' },
      { ...MACHINE_SETTINGS, browserPorts: { cdp: 9222, relay: 9223, vnc: 5901 } },
      { ...MACHINE_SETTINGS, browserProxy: { url: 'http://proxy.example.test:3128', bypass: [] }, browserMode: 'window' },
      { kind: 'setup.import', acceptedUpdates: ['instructions/main'], addDuplicates: true },
      { kind: 'clone.import', mode: 'alongside', bundle: { version: 1 } },
      {
        kind: 'clone.import',
        mode: 'replace',
        bundle: { version: 1 },
        skip: ['hooks/guard'],
        source: { daemonId: 'sha256:abc' },
      },
      {
        kind: 'clone.import',
        mode: 'replace',
        bundle: { version: 1 },
        defaultRuntime: 'claude-default',
        names: { source: 'Liftoff EC2', target: 'Liftoff MBP' },
      },
      { kind: 'clone.import', mode: 'replace', bundle: { version: 1 }, defaultRuntime: null },
    ];

    // Act
    const parsed = changes.map(entry => catalog.AccountChangeSchema.safeParse(entry).success);

    // Assert
    should(parsed).deepEqual(changes.map(() => true));
  });

  it('should accept a catalog.install of an MCP server or a skill, and refuse any other kind of component', () => {
    // Arrange
    const installedFrom = {
      publisher: `fy_daemon_${'p'.repeat(43)}`,
      publisherName: 'kirin-box',
      catalogId: `cat_${'c'.repeat(22)}`,
      catalogName: 'Catalog',
      itemId: `itm_${'i'.repeat(22)}`,
      kind: 'skill',
      name: 'pdf-tools',
      version: 1,
      digest: `sha256:${'a'.repeat(64)}`,
    };
    const sent = (component: unknown) => ({
      kind: 'catalog.install',
      name: 'pdf-tools',
      component,
      files: [{ path: 'SKILL.md', content: '# pdf\n' }],
      profile: 'work',
      installedFrom,
      replace: false,
    });
    const install = (component: unknown) => catalog.CatalogInstallChangeSchema.safeParse(sent(component)).success;

    // Act
    const actual = [
      install({ kind: 'skills', items: ['pdf-tools'] }),
      install({ kind: 'mcp', url: 'https://mcp.example.com/x' }),
      install({ kind: 'hooks', harness: 'claude-code' }),
    ];

    // Assert
    should(actual).deepEqual([true, true, false]);
    should(
      catalog.CatalogInstallChangeSchema.safeParse({
        ...sent({ kind: 'skills', items: ['x'] }),
        files: [{ path: '../x', content: 'x' }],
      }).success,
    ).be.false();
  });

  it('should not let the public change schema express a catalog.install at all', () => {
    // Arrange
    const forged = {
      kind: 'catalog.install',
      name: 'pdf-tools',
      component: { kind: 'skills', items: ['pdf-tools'] },
      files: [{ path: 'SKILL.md', content: '# pdf\n' }],
      profile: 'work',
      replace: false,
    };

    // Act
    const asChange = catalog.AccountChangeSchema.safeParse(forged);
    const asRequest = catalog.AccountChangeRequestSchema.safeParse({ change: forged });

    // Assert
    should([asChange.success, asRequest.success]).deepEqual([false, false]);
  });

  it('should accept a runtime.put naming which half of a dual login it runs, and leave it optional', () => {
    // Act
    const named = catalog.AccountChangeSchema.safeParse({
      kind: 'runtime.put',
      name: 'Codex Review',
      credential: 'glm',
      profile: 'default',
      harness: 'codex',
      agent: false,
      create: true,
    });
    const unnamed = catalog.AccountChangeSchema.safeParse({
      kind: 'runtime.put',
      name: 'Default',
      credential: 'claude-you',
      profile: 'default',
      agent: false,
      create: false,
    });

    // Assert
    should(named.success && named.data.kind === 'runtime.put' && named.data.harness).equal('codex');
    should(unnamed.success && unnamed.data.kind === 'runtime.put' && 'harness' in unnamed.data).be.false();
  });

  it('should take browserPorts on a settings change and refuse ports that cannot work', () => {
    // Arrange
    const explicit = { cdp: 9222, relay: 9223, vnc: 5901 };

    // Act
    const parse = (browserPorts: unknown) =>
      catalog.AccountChangeSchema.safeParse({ ...MACHINE_SETTINGS, browserPorts });

    // Assert
    should(parse('random').success).be.true();
    should(parse('per-user').success).be.true();
    should(parse(explicit).success).be.true();
    should(parse({ ...explicit, relay: 9222 }).success).be.false();
    should(parse('fixed').success).be.false();
  });

  it('should take browserFirewallFailure on a settings change and refuse another word', () => {
    // Act
    const parse = (browserFirewallFailure: unknown) =>
      catalog.AccountChangeSchema.safeParse({ ...MACHINE_SETTINGS, browserFirewallFailure });

    // Assert
    should(parse('warn').success).be.true();
    should(parse('refuse').success).be.true();
    should(parse('ignore').success).be.false();
  });

  it('should require every machine setting in what a caller sends, so one change never clobbers a field it was not shown', () => {
    // Arrange
    const { browserPorts: _ports, ...withoutPorts } = MACHINE_SETTINGS;
    const { ferretrySettings: _setting, ...control } = MACHINE_SETTINGS.agentControl;

    // Assert
    should(catalog.AccountChangeSchema.safeParse(MACHINE_SETTINGS).success).be.true();
    assertRejects([
      rejects('a send that omits browserPorts', catalog.AccountChangeSchema, withoutPorts),
      rejects('a machine report that omits ferretrySettings', catalog.AgentControlSchema, control),
      rejects('a send that makes ferretrySettings a string', catalog.AccountChangeSchema, {
        ...MACHINE_SETTINGS,
        agentControl: { ...MACHINE_SETTINGS.agentControl, ferretrySettings: 'yes' },
      }),
    ]);
  });

  it('should refuse a component name with a slash, a file path in a change, and an unknown field', () => {
    // Arrange / Act / Assert
    assertRejects([
      rejects('a name with a slash', catalog.ComponentNameSchema, 'a/b'),
      rejects('a name that climbs', catalog.ComponentNameSchema, '..'),
      rejects('a name with edge spaces', catalog.ComponentNameSchema, ' main'),
      rejects('a component input naming its own file', catalog.ComponentInputSchema, {
        kind: 'instructions',
        file: '/etc/passwd',
      }),
      rejects('a view carrying a raw environment map', catalog.ComponentViewSchema, {
        ...component,
        env: { NOTES_TOKEN: 'fake' },
      }),
      rejects('an env entry with both a value and hidden', catalog.EnvEntrySchema, {
        name: 'TOKEN',
        value: 'fake',
        hidden: true,
      }),
      rejects('text past the limit', catalog.AccountChangeSchema, {
        ...change,
        content: 'x'.repeat(catalog.MAX_COMPONENT_CONTENT_BYTES + 1),
      }),
      rejects('a settings entry with both a value and hidden', catalog.SettingsEntrySchema, {
        key: 'env.TOKEN',
        value: 'fake',
        hidden: true,
      }),
      rejects('an entry value that is not JSON', catalog.SettingsEntriesInputSchema, {
        theme: { value: () => 1 },
      }),
      rejects('a draft past the layer limit', catalog.ProfileDraftRequestSchema, {
        layers: Array.from({ length: 201 }, (_, index) => `mcp/m${String(index)}`),
      }),
      rejects('a refusal code nobody declared', catalog.CatalogRefusalCodeSchema, 'fleet_change_bad'),
      rejects('an authority that still announces a confirmation', catalog.MachineAuthoritySchema, {
        mayApply: true,
        applyRefusal: 'granted',
        confirmation: 'none',
      }),
      rejects('an authority refused for a lock that no longer exists', catalog.MachineAuthoritySchema, {
        mayApply: false,
        applyRefusal: 'locked',
      }),
    ]);
  });
});
