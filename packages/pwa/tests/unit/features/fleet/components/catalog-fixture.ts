/**
 * The prototype's studio-mac, as the daemon would answer it (docs/design/account-model-prototype.html
 * `studioSetUp`), parsed through the real schemas so a schema change fails every suite that uses it.
 */

import {
  type FleetAccountChange,
  type FleetComponentCatalog,
  FleetComponentCatalogSchema,
  type FleetComponentView,
  type FleetLayeredProfileCatalog,
  FleetLayeredProfileCatalogSchema,
  type FleetLayeredProfileView,
  type FleetMachineView,
  type FleetRuntimeCatalog,
  FleetRuntimeCatalogSchema,
  type FleetRuntimeView,
  type FleetStackView,
} from '@ferretry/protocol';
import type { AccountCatalog } from '../../../../../src/features/fleet/components/account-catalog.ts';

/** A `${secret:NAME}` reference, spelled so it is never mistaken for a template. */
export const secretRef = (name: string): string => ['$', `{secret:${name}}`].join('');

type ComponentInput = Omit<FleetComponentView, 'partial' | 'warnings' | 'usedBy' | 'editNote' | 'remove' | 'scope'> &
  Partial<Pick<FleetComponentView, 'partial' | 'warnings' | 'usedBy' | 'editNote' | 'remove' | 'scope'>>;

/** A component's scope defaults to the harness it names, as the daemon derives it for every kind but a model set. */
export const component = (input: ComponentInput): FleetComponentView => ({
  scope: input.harness ?? 'generic',
  partial: [],
  warnings: [],
  usedBy: { profiles: [], runtimes: [] },
  editNote: 'Nothing uses it yet.',
  remove: { available: true },
  ...input,
});

export const instructions = component({
  reference: 'instructions/Main instructions',
  kind: 'instructions',
  name: 'Main instructions',
  detail: { kind: 'instructions', file: 'components/instructions/Main instructions.md' },
  content: { form: 'text', text: '# How we work\n- Small PRs.', redacted: false },
  usedBy: {
    profiles: ['Agent work', 'Default', 'Review'],
    runtimes: ['claude-agent', 'claude-default', 'claude-review'],
  },
});

export const github = component({
  reference: 'mcp/github',
  kind: 'mcp',
  name: 'github',
  detail: {
    kind: 'mcp',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: [
      { name: 'GITHUB_TOKEN', value: secretRef('GITHUB_TOKEN') },
      { name: 'LOG', value: 'info' },
    ],
  },
  usedBy: { profiles: ['Default', 'Review'], runtimes: ['claude-default', 'claude-review'] },
});

export const notes = component({
  reference: 'mcp/notes',
  kind: 'mcp',
  name: 'notes',
  detail: { kind: 'mcp', command: 'uvx', args: ['notes-mcp', '--vault', '/Users/other/Notes'], env: [] },
  warnings: ['Command not found: uvx'],
  checkPath: '/Users/other/Notes',
});

export const skills = component({
  reference: 'skills/My skills',
  kind: 'skills',
  name: 'My skills',
  detail: { kind: 'skills', items: ['release-notes', 'pr-review'] },
  partial: [
    {
      harness: 'codex',
      reason: 'release-notes limits which tools it may use. Codex ignores that limit and loads the rest.',
    },
  ],
});

export const claudeSettings = component({
  reference: 'settings/Claude settings',
  kind: 'settings',
  name: 'Claude settings',
  harness: 'claude',
  detail: {
    kind: 'settings',
    file: 'components/settings/Claude settings.json',
    flags: ['--verbose'],
    env: [{ name: 'API_KEY', hidden: true }],
  },
  content: {
    form: 'entries',
    entries: [
      { key: 'env.ANTHROPIC_API_KEY', hidden: true },
      { key: 'permissions.defaultMode', value: 'plan' },
      { key: 'statusLine', value: 'on' },
    ],
  },
});

export const hooks = component({
  reference: 'hooks/Format on save',
  kind: 'hooks',
  name: 'Format on save',
  harness: 'claude',
  detail: { kind: 'hooks', file: 'components/hooks/Format on save.json' },
  content: { form: 'text', text: '{"PostToolUse": []}', redacted: false },
});

export const models = component({
  reference: 'modelSets/Claude models',
  kind: 'modelSets',
  name: 'Claude models',
  detail: { kind: 'modelSets', models: ['claude-opus-5', 'claude-sonnet-5'], default: 'claude-sonnet-5' },
});

const group = (kind: FleetComponentView['kind'], label: string, list: readonly FleetComponentView[]) => ({
  kind,
  label,
  description: `${label} description.`,
  components: list,
});

export const componentCatalog = (extra: Partial<Record<FleetComponentView['kind'], FleetComponentView[]>> = {}) =>
  FleetComponentCatalogSchema.parse({
    format: 'version-2',
    kinds: [
      group('instructions', 'Instructions', [instructions, ...(extra.instructions ?? [])]),
      group('mcp', 'MCP servers', [github, notes, ...(extra.mcp ?? [])]),
      group('skills', 'Skills', [skills, ...(extra.skills ?? [])]),
      group('settings', 'Settings', [claudeSettings, ...(extra.settings ?? [])]),
      group('hooks', 'Hooks', [hooks, ...(extra.hooks ?? [])]),
      group('modelSets', 'Model sets', [models, ...(extra.modelSets ?? [])]),
    ],
  }) satisfies FleetComponentCatalog;

export const stack = (harness: 'claude' | 'codex', overrides: Partial<FleetStackView> = {}): FleetStackView => ({
  harness,
  available: { available: true },
  applied: [],
  skipped: [],
  conflicts: [],
  partial: [],
  ...overrides,
});

export const profile = (
  name: string,
  layers: readonly string[],
  overrides: Partial<FleetLayeredProfileView> = {},
): FleetLayeredProfileView => ({
  name,
  layers,
  usedBy: [],
  baseFor: [],
  wouldIncludeItself: [name],
  scope: { kind: 'scoped', scope: 'generic' },
  harnesses: [stack('claude', { applied: layers.filter(layer => !layer.startsWith('profile/')) }), stack('codex')],
  remove: { available: true },
  ...overrides,
});

const CONFLICT = {
  harness: 'claude',
  field: 'settings',
  key: 'permissions.defaultMode',
  sentence: '`permissions.defaultMode` · Claude Code: acceptEdits (from Agent) overrides plan (from Default)',
  winner: 'Agent',
  overridden: ['Default'],
} as const;

export const profileCatalog = (profiles?: readonly FleetLayeredProfileView[]): FleetLayeredProfileCatalog =>
  FleetLayeredProfileCatalogSchema.parse({
    format: 'version-2',
    profiles: profiles ?? [
      profile('Agent work', ['profile/Default', 'profile/Agent'], {
        usedBy: ['claude-agent'],
        harnesses: [
          stack('claude', { applied: ['instructions/Main instructions'], conflicts: [CONFLICT] }),
          stack('codex', { conflicts: [CONFLICT] }),
        ],
      }),
      profile(
        'Default',
        ['instructions/Main instructions', 'mcp/github', 'settings/Claude settings', 'modelSets/Claude models'],
        {
          scope: { kind: 'scoped', scope: 'claude' },
          usedBy: ['claude-default'],
          baseFor: ['Agent work', 'Review'],
          wouldIncludeItself: ['Agent work', 'Default', 'Review'],
          harnesses: [
            stack('claude', {
              applied: [
                'instructions/Main instructions',
                'mcp/github',
                'settings/Claude settings',
                'modelSets/Claude models',
              ],
            }),
            stack('codex', {
              applied: ['instructions/Main instructions', 'mcp/github'],
              skipped: [
                {
                  reference: 'settings/Claude settings',
                  sentence: 'Settings Claude settings is for Claude Code only, so it is skipped on Codex.',
                },
              ],
            }),
          ],
        },
      ),
      profile('Review', ['profile/Default', 'settings/Claude settings'], { usedBy: ['claude-review'] }),
    ],
  });

export const runtime = (name: string, profileName: string): FleetRuntimeView => ({
  name,
  id: `rt-${name}`,
  wrapper: name,
  harness: 'claude',
  credential: { id: 'personal', store: 'host' },
  profile: profileName,
  agent: false,
  stack: stack('claude'),
  modelSet: { source: 'harness-default' },
  launch: { available: true },
  sameAs: [],
});

export const runtimeCatalog = (runtimes?: readonly FleetRuntimeView[]): FleetRuntimeCatalog =>
  FleetRuntimeCatalogSchema.parse({
    format: 'version-2',
    runtimes: runtimes ?? [
      runtime('claude-agent', 'Agent work'),
      runtime('claude-default', 'Default'),
      runtime('claude-review', 'Review'),
    ],
  });

export const studioCatalog = (overrides: Partial<AccountCatalog> = {}): AccountCatalog => ({
  components: componentCatalog(),
  profiles: profileCatalog(),
  runtimes: runtimeCatalog(),
  ...overrides,
});

export const studioMachine = (overrides: Partial<FleetMachineView> = {}): FleetMachineView => ({
  name: 'studio-mac',
  format: 'version-2',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  tools: [{ harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' }],
  runtimeCount: 3,
  runningSessions: 0,
  authority: { mayApply: true, applyRefusal: 'granted' },
  ...overrides,
});

/** The change a test captured, narrowed to one kind. */
export const changeOf = <Kind extends FleetAccountChange['kind']>(
  change: FleetAccountChange | undefined,
  kind: Kind,
): Extract<FleetAccountChange, { kind: Kind }> => {
  if (change?.kind !== kind) throw new Error(`expected a ${kind} change, got ${change?.kind}`);
  return change as Extract<FleetAccountChange, { kind: Kind }>;
};
