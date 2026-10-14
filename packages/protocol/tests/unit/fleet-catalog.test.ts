/**
 * The wire shape of the account model's catalogue and its reviewed changes.
 *
 * Every object is strict, so a field the daemon grew without declaring it — or a credential value
 * somebody tried to smuggle into an environment entry — is REFUSED rather than stripped.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import * as catalog from '../../src/lib/fleet-catalog.ts';
import type {
  FleetAccountChangeView,
  FleetComponentView,
  FleetLayeredProfileView,
  FleetRuntimeView,
} from '../../src/lib/index.ts';
import { INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const component = {
  reference: 'mcp/notes',
  kind: 'mcp',
  name: 'notes',
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
} satisfies FleetComponentView;

const stack = {
  harness: 'claude',
  available: { available: true },
  applied: ['instructions/main', 'mcp/notes'],
  skipped: [
    { reference: 'settings/codex', sentence: 'Settings codex is for Codex only, so it is skipped on Claude Code.' },
  ],
  conflicts: [
    {
      harness: 'claude',
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
  harnesses: [stack],
  remove: { available: true },
} satisfies FleetLayeredProfileView;

const runtime = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'claude-default',
  wrapper: 'claude-default',
  harness: 'claude',
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
} satisfies FleetRuntimeView;

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
    runtimes: [{ name: 'claude-default', harness: 'claude', agent: true, launch: { available: true } }],
  },
} satisfies FleetAccountChangeView;

const cases: readonly SchemaCase[] = [
  { name: 'FleetComponentNameSchema', schema: catalog.FleetComponentNameSchema, value: 'main notes' },
  { name: 'FleetComponentKindSchema', schema: catalog.FleetComponentKindSchema, value: 'modelSets' },
  { name: 'FleetCatalogFormatSchema', schema: catalog.FleetCatalogFormatSchema, value: 'none' },
  { name: 'FleetCatalogActSchema', schema: catalog.FleetCatalogActSchema, value: { available: true } },
  {
    name: 'FleetMachineToolSchema',
    schema: catalog.FleetMachineToolSchema,
    value: { harness: 'codex', label: 'Codex', installed: false },
  },
  {
    name: 'FleetMachineViewSchema',
    schema: catalog.FleetMachineViewSchema,
    value: {
      name: 'studio',
      format: 'none',
      setUp: false,
      agentPermissions: 'skip',
      tools: [{ harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/bin/claude' }],
      runtimeCount: 0,
      runningSessions: 2,
      authority: { mayApply: false, applyRefusal: 'step-up-required' },
    },
  },
  {
    name: 'FleetMachineAuthoritySchema',
    schema: catalog.FleetMachineAuthoritySchema,
    value: { mayApply: true, applyRefusal: 'granted' },
  },
  { name: 'FleetEnvEntrySchema', schema: catalog.FleetEnvEntrySchema, value: { name: 'API_KEY', hidden: true } },
  { name: 'FleetComponentDetailSchema', schema: catalog.FleetComponentDetailSchema, value: component.detail },
  { name: 'FleetUsageSchema', schema: catalog.FleetUsageSchema, value: component.usedBy },
  { name: 'FleetPartialSupportSchema', schema: catalog.FleetPartialSupportSchema, value: component.partial[0] },
  { name: 'FleetComponentViewSchema', schema: catalog.FleetComponentViewSchema, value: component },
  {
    name: 'FleetComponentGroupSchema',
    schema: catalog.FleetComponentGroupSchema,
    value: { kind: 'mcp', label: 'MCP servers', description: 'Tools a session can call.', components: [component] },
  },
  {
    name: 'FleetComponentCatalogSchema',
    schema: catalog.FleetComponentCatalogSchema,
    value: { format: 'version-2', kinds: [] },
  },
  { name: 'FleetLayerConflictSchema', schema: catalog.FleetLayerConflictSchema, value: stack.conflicts[0] },
  { name: 'FleetSkippedLayerSchema', schema: catalog.FleetSkippedLayerSchema, value: stack.skipped[0] },
  { name: 'FleetStackViewSchema', schema: catalog.FleetStackViewSchema, value: stack },
  { name: 'FleetLayeredProfileViewSchema', schema: catalog.FleetLayeredProfileViewSchema, value: profile },
  {
    name: 'FleetLayeredProfileCatalogSchema',
    schema: catalog.FleetLayeredProfileCatalogSchema,
    value: { format: 'version-2', profiles: [profile] },
  },
  {
    name: 'FleetRuntimeModelSetSchema',
    schema: catalog.FleetRuntimeModelSetSchema,
    value: { source: 'harness-default' },
  },
  { name: 'FleetFixedLayerViewSchema', schema: catalog.FleetFixedLayerViewSchema, value: runtime.fixedLayer },
  { name: 'FleetRuntimeViewSchema', schema: catalog.FleetRuntimeViewSchema, value: runtime },
  {
    name: 'FleetRuntimeCatalogSchema',
    schema: catalog.FleetRuntimeCatalogSchema,
    value: { format: 'version-2', runtimes: [runtime] },
  },
  {
    name: 'FleetEnvInputSchema',
    schema: catalog.FleetEnvInputSchema,
    value: { NOTES_DIR: '/srv/notes', NOTES_TOKEN: { keep: true } },
  },
  {
    name: 'FleetComponentInputSchema',
    schema: catalog.FleetComponentInputSchema,
    value: { kind: 'settings', harness: 'claude', flags: ['--verbose'], env: { LOG: 'debug' } },
  },
  { name: 'FleetAccountChangeSchema', schema: catalog.FleetAccountChangeSchema, value: change },
  { name: 'FleetAccountChangeRequestSchema', schema: catalog.FleetAccountChangeRequestSchema, value: { change } },
  {
    name: 'FleetChangedRuntimeSchema',
    schema: catalog.FleetChangedRuntimeSchema,
    value: view.preview.runtimes[0],
  },
  {
    name: 'FleetAccountChangePreviewSchema',
    schema: catalog.FleetAccountChangePreviewSchema,
    value: { kind: 'sign-out', credential: 'codex-work', runtimesAffected: 2, signsOutTerminal: false },
  },
  { name: 'FleetAccountChangeViewSchema', schema: catalog.FleetAccountChangeViewSchema, value: view },
  {
    name: 'FleetAccountChangeOutcomeSchema',
    schema: catalog.FleetAccountChangeOutcomeSchema,
    value: { outcome: 'executed', executor: 'clone', summary: 'Cloned 3 runtimes' },
  },
  { name: 'FleetCatalogRefusalCodeSchema', schema: catalog.FleetCatalogRefusalCodeSchema, value: 'fleet_change_stale' },
  {
    name: 'FleetSettingsEntrySchema',
    schema: catalog.FleetSettingsEntrySchema,
    value: { key: 'permissions.defaultMode', value: 'plan' },
  },
  {
    name: 'FleetComponentContentSchema',
    schema: catalog.FleetComponentContentSchema,
    value: {
      form: 'entries',
      entries: [
        { key: 'env.API_TOKEN', hidden: true },
        { key: 'theme', value: 'dark' },
      ],
    },
  },
  {
    name: 'FleetSettingsEntriesInputSchema',
    schema: catalog.FleetSettingsEntriesInputSchema,
    value: { theme: { value: 'dark' }, 'env.API_TOKEN': { keep: true }, 'permissions.allow': { value: ['Bash'] } },
  },
  {
    name: 'FleetProfileDraftRequestSchema',
    schema: catalog.FleetProfileDraftRequestSchema,
    value: { layers: ['profile/default', 'mcp/notes'], editing: 'agent' },
  },
  {
    name: 'FleetProfileDraftViewSchema',
    schema: catalog.FleetProfileDraftViewSchema,
    value: { harnesses: [stack], refusal: 'no profile ghost exists on this machine' },
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
      { kind: 'profile.put', name: 'agent', layers: ['profile/default', 'settings/claude'], create: false },
      { kind: 'profile.remove', name: 'agent', switchRuntimesTo: 'default', removeFromProfiles: true },
      {
        kind: 'component.put',
        name: 'claude',
        component: { kind: 'settings', harness: 'claude', entries: { theme: { value: 'dark' } } },
        create: false,
      },
      { kind: 'component.remove', componentKind: 'skills', name: 'mine', removeFromProfiles: true },
      { kind: 'credential.add', id: 'codex-work', harness: 'codex', label: 'work' },
      { kind: 'credential.label', id: 'codex-work', label: null },
      { kind: 'credential.remove', id: 'codex-work' },
      { kind: 'credential.signout', id: 'codex-work' },
      { kind: 'machine.settings', agentPermissions: 'auto' },
      { kind: 'setup.import', acceptedUpdates: ['instructions/main'], addDuplicates: true },
      { kind: 'clone.import', mode: 'alongside', bundle: { version: 1 } },
      {
        kind: 'clone.import',
        mode: 'replace',
        bundle: { version: 1 },
        skip: ['hooks/guard'],
        source: { daemonId: 'sha256:abc' },
      },
    ];

    // Act
    const parsed = changes.map(entry => catalog.FleetAccountChangeSchema.safeParse(entry).success);

    // Assert
    should(parsed).deepEqual(changes.map(() => true));
  });

  it('should refuse a component name with a slash, a file path in a change, and an unknown field', () => {
    // Arrange / Act / Assert
    assertRejects([
      rejects('a name with a slash', catalog.FleetComponentNameSchema, 'a/b'),
      rejects('a name that climbs', catalog.FleetComponentNameSchema, '..'),
      rejects('a name with edge spaces', catalog.FleetComponentNameSchema, ' main'),
      rejects('a component input naming its own file', catalog.FleetComponentInputSchema, {
        kind: 'instructions',
        file: '/etc/passwd',
      }),
      rejects('a view carrying a raw environment map', catalog.FleetComponentViewSchema, {
        ...component,
        env: { NOTES_TOKEN: 'fake' },
      }),
      rejects('an env entry with both a value and hidden', catalog.FleetEnvEntrySchema, {
        name: 'TOKEN',
        value: 'fake',
        hidden: true,
      }),
      rejects('text past the limit', catalog.FleetAccountChangeSchema, {
        ...change,
        content: 'x'.repeat(catalog.MAX_COMPONENT_CONTENT_BYTES + 1),
      }),
      rejects('a settings entry with both a value and hidden', catalog.FleetSettingsEntrySchema, {
        key: 'env.TOKEN',
        value: 'fake',
        hidden: true,
      }),
      rejects('an entry value that is not JSON', catalog.FleetSettingsEntriesInputSchema, {
        theme: { value: () => 1 },
      }),
      rejects('a draft past the layer limit', catalog.FleetProfileDraftRequestSchema, {
        layers: Array.from({ length: 201 }, (_, index) => `mcp/m${String(index)}`),
      }),
      rejects('a refusal code nobody declared', catalog.FleetCatalogRefusalCodeSchema, 'fleet_change_bad'),
      rejects('an authority that still announces a confirmation', catalog.FleetMachineAuthoritySchema, {
        mayApply: true,
        applyRefusal: 'granted',
        confirmation: 'none',
      }),
      rejects('an authority refused for a lock that no longer exists', catalog.FleetMachineAuthoritySchema, {
        mayApply: false,
        applyRefusal: 'locked',
      }),
    ]);
  });
});
