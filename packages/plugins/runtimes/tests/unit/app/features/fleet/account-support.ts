/**
 * Fixtures for the Runtimes suites: the prototype's studio-mac, written out longhand and parsed through the real
 * schemas, so a wire change fails here first. Only what the runtimes app reads is here (the machine and the
 * runtimes); the logins, profiles and components fixtures go with the plugins that own those views.
 */

import { type LoginList, LoginListSchema, type LoginStatus } from '@ferretry/plugin-logins/contract';
import {
  type ComponentCatalog,
  ComponentCatalogSchema,
  type LayeredProfileCatalog,
  LayeredProfileCatalogSchema,
  type LayeredProfileView,
  type MachineView,
  MachineViewSchema,
  type RuntimeCatalog,
  RuntimeCatalogSchema,
  type RuntimeView,
} from '../../../../../contract/index.ts';
import type { MachineData } from '../../../../../app/features/fleet/runtimes/machine-data.ts';

export { type Call, type Route, scripted } from '../../support/client.ts';

export const NOW = Date.parse('2026-10-13T08:00:00.000Z');
export const CHANGE_ID = 'fy_fprop_abcdefghijklmnopqrstuv';

export const machine = (overrides: Partial<MachineView> = {}): MachineView =>
  MachineViewSchema.parse({
    name: 'studio-mac',
    format: 'present',
    setUp: true,
    agentPermissions: 'auto',
    defaultRuntime: 'claude-default',
    agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
    browserMode: 'headless',
    browserProxy: null,
    browserPorts: 'random',
    browserFirewallFailure: 'warn',
    autoResume: true,
    agendaMode: false,
    publicUsageFeed: false,
    lastAutoResume: null,
    tools: [
      { harness: 'claude-code', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
      { harness: 'codex', label: 'Codex', installed: true, command: '/usr/local/bin/codex' },
    ],
    runtimeCount: 5,
    runningSessions: 0,
    authority: { mayApply: true, applyRefusal: 'granted' },
    ...overrides,
  });

/** The machine view with this caller's authority: where every change reads what it may do. */
export const machineWith = (authority: Partial<MachineView['authority']>): MachineView =>
  machine({ authority: { mayApply: true, applyRefusal: 'granted', ...authority } });

const stack = (
  harness: 'claude-code' | 'codex',
  overrides: Partial<LayeredProfileView['harnesses'][number]> = {},
): LayeredProfileView['harnesses'][number] => ({
  harness,
  available: { available: true },
  applied: ['instructions/Main instructions', 'modelSets/Claude models'],
  skipped: [],
  conflicts: [],
  partial: [],
  ...overrides,
});

const modelSet = (models: readonly [string, boolean][], declaredDefault: string, resolved?: string) => ({
  source: 'model-set' as const,
  name: 'Claude models',
  models: models.map(([id, available]) => ({ id, available })),
  declaredDefault,
  ...(resolved === undefined ? {} : { default: resolved }),
});

export const runtime = (overrides: Partial<RuntimeView> & { name: string }): RuntimeView => ({
  id: `rt-${overrides.name}`,
  wrapper: overrides.name,
  harness: 'claude-code',
  credential: { id: 'claude-personal', store: 'host', label: 'personal', status: 'ready' },
  profile: 'Default',
  agent: false,
  stack: stack('claude-code'),
  modelSet: modelSet(
    [
      ['Opus 5.5', true],
      ['Sonnet 5.5', true],
    ],
    'Sonnet 5.5',
    'Sonnet 5.5',
  ),
  launch: { available: true },
  sameAs: [],
  ...overrides,
});

export const RUNTIMES: RuntimeCatalog = RuntimeCatalogSchema.parse({
  format: 'present',
  runtimes: [
    runtime({ name: 'claude-default' }),
    runtime({
      name: 'codex-default',
      harness: 'codex',
      credential: { id: 'codex', store: 'host', status: 'ready' },
      stack: stack('codex', {
        skipped: [{ reference: 'settings/Claude settings', sentence: 'Claude settings are skipped on Codex.' }],
      }),
      modelSet: modelSet(
        [
          ['GPT-6', true],
          ['Opus 5.5', false],
        ],
        'Opus 5.5',
        'GPT-6',
      ),
    }),
    runtime({
      name: 'claude-agent',
      profile: 'Agent work',
      agent: true,
      fixedLayer: {
        agentPermissions: 'auto',
        entries: [
          { key: 'permissions.defaultMode', value: 'auto' },
          { key: 'trust prompt', value: 'off' },
        ],
        overridden: [
          {
            key: 'permissions.defaultMode',
            value: 'acceptEdits',
            from: 'Agent settings',
            sentence: 'From your Agent settings · Overridden for agents by Ferretry',
          },
        ],
      },
    }),
    runtime({ name: 'claude-review', profile: 'Review', modelSet: { source: 'harness-default' } }),
    runtime({
      name: 'claude-work',
      credential: { id: 'claude-work', store: 'ferretry', label: 'work', status: 'refresh_due' },
    }),
  ],
});

/** A staged change, echoing what was sent. */
export const stagedFrom = (call: { readonly body: unknown }) => ({
  id: CHANGE_ID,
  revision: 'r1',
  change: (call.body as { change: unknown }).change,
  summary: 'A change',
  consequences: [],
  expiresAt: '2026-10-13T08:15:00.000Z',
  state: 'pending',
  preview: { kind: 'apply', operations: [], documents: [], runtimes: [] },
});

const status = (word: LoginStatus['word']): LoginStatus => {
  const table = {
    ready: ['Ready', 'provider_accepted', 'Ready. Checked a few minutes ago.'],
    refresh_due: [
      'Refresh due',
      'access_expired_refreshable',
      'Refresh due. Ferretry renews it the next time a runtime uses it.',
    ],
    needs_sign_in: ['Needs sign-in', 'not_signed_in', 'Needs sign-in. Runtimes that use this login can’t launch.'],
    checking: ['Checking', 'check_in_flight', 'Checking with the provider…'],
  } as const;
  const [label, reason, explanation] = table[word];
  return { word, label, reason, explanation, lastCheckInconclusive: false };
};

export const credential = (overrides: Record<string, unknown> & { id: string }): Record<string, unknown> => ({
  harness: 'claude-code',
  harnesses: ['claude-code'],
  store: 'ferretry',
  email: 'you@example.com',
  needsLabel: false,
  sharedWithTerminal: false,
  status: status('ready'),
  usage: {
    fiveHour: { usedPercent: 38, resetsAt: '2026-10-13T10:10:00.000Z' },
    weekly: { usedPercent: 83, resetsAt: '2026-10-16T08:00:00.000Z' },
    source: 'anthropic-usage',
    at: '2026-10-13T07:58:00.000Z',
  },
  usedBy: [],
  signIn: { available: true },
  checkNow: { available: true },
  signOut: {
    available: true,
    sentence: 'Sign out of you@example.com? No runtime uses it.',
    runtimesAffected: 0,
    signsOutTerminal: false,
  },
  ...overrides,
});

export const withStatus = (word: LoginStatus['word']) => ({ status: status(word) });

export const CREDENTIALS: LoginList = LoginListSchema.parse({
  format: 1,
  machine: 'studio-mac',
  logins: [
    credential({
      id: 'claude-personal',
      store: 'host',
      label: 'personal',
      sharedWithTerminal: true,
      usedBy: ['claude-default', 'claude-agent', 'claude-review'],
      signOut: {
        available: true,
        sentence:
          'Sign out of you@example.com (personal)? This also signs out claude in your terminal on studio-mac. 3 runtimes will need sign-in.',
        runtimesAffected: 3,
        signsOutTerminal: true,
      },
    }),
    credential({
      id: 'codex',
      harness: 'codex',
      harnesses: ['codex'],
      store: 'host',
      sharedWithTerminal: true,
      usedBy: ['codex-default'],
      usage: { fiveHour: {}, weekly: {} },
    }),
    credential({ id: 'claude-work', label: 'work', ...withStatus('refresh_due'), usedBy: ['claude-work'] }),
  ],
});

export const profile = (overrides: Partial<LayeredProfileView> & { name: string }): LayeredProfileView => ({
  layers: ['instructions/Main instructions', 'modelSets/Claude models'],
  usedBy: [],
  baseFor: [],
  wouldIncludeItself: [],
  scope: { kind: 'scoped', scope: 'generic' },
  harnesses: [stack('claude-code'), stack('codex')],
  remove: { available: true },
  ...overrides,
});

export const PROFILES: LayeredProfileCatalog = LayeredProfileCatalogSchema.parse({
  format: 'present',
  profiles: [
    profile({
      name: 'Default',
      layers: [
        'instructions/Main instructions',
        'skills/My skills',
        'settings/Claude settings',
        'modelSets/Claude models',
      ],
      usedBy: ['claude-default', 'codex-default', 'claude-work'],
      harnesses: [
        stack('claude-code'),
        stack('codex', {
          skipped: [{ reference: 'settings/Claude settings', sentence: 'Claude settings are skipped on Codex.' }],
          partial: [{ reference: 'skills/My skills', reason: 'release-notes limits which tools it may use.' }],
        }),
      ],
    }),
    profile({
      name: 'Claude hooks',
      layers: ['hooks/Format on save'],
      harnesses: [
        stack('claude-code', { applied: ['hooks/Format on save'] }),
        stack('codex', {
          available: { available: false, reason: 'Only Claude settings. Nothing here applies on Codex.' },
          applied: [],
          skipped: [{ reference: 'hooks/Format on save', sentence: 'Claude hooks are skipped on Codex.' }],
        }),
      ],
    }),
    profile({ name: 'Agent work', layers: ['profile/Default', 'settings/Agent settings'], usedBy: ['claude-agent'] }),
    profile({ name: 'Review', layers: ['profile/Default'], usedBy: ['claude-review'] }),
  ],
});

const component = (
  kind: ComponentCatalog['kinds'][number]['kind'],
  name: string,
  detail: ComponentCatalog['kinds'][number]['components'][number]['detail'],
  overrides: Partial<ComponentCatalog['kinds'][number]['components'][number]> = {},
) => ({
  reference: `${kind}/${name}`,
  kind,
  name,
  detail,
  partial: [],
  warnings: [],
  usedBy: { profiles: [], runtimes: [] },
  editNote: 'Saving changes it everywhere.',
  remove: { available: true },
  scope: overrides.harness ?? 'generic',
  ...overrides,
});

export const COMPONENTS: ComponentCatalog = ComponentCatalogSchema.parse({
  format: 'present',
  kinds: [
    {
      kind: 'instructions',
      label: 'Instructions',
      description: 'What every session reads first.',
      components: [
        component('instructions', 'Main instructions', {
          kind: 'instructions',
          file: 'components/instructions/main.md',
        }),
      ],
    },
    {
      kind: 'skills',
      label: 'Skills',
      description: 'Named abilities.',
      components: [
        component(
          'skills',
          'My skills',
          { kind: 'skills', items: ['release-notes'] },
          { partial: [{ harness: 'codex', reason: 'release-notes limits which tools it may use.' }] },
        ),
      ],
    },
    {
      kind: 'settings',
      label: 'Settings',
      description: 'Flags and environment.',
      components: [
        component('settings', 'Claude settings', { kind: 'settings', env: [] }, { harness: 'claude-code' }),
        component('settings', 'Agent settings', { kind: 'settings', env: [] }, { harness: 'claude-code' }),
      ],
    },
    {
      kind: 'hooks',
      label: 'Hooks',
      description: 'Commands on events.',
      components: [
        component(
          'hooks',
          'Format on save',
          { kind: 'hooks', file: 'components/hooks/fmt.json' },
          { harness: 'claude-code', warnings: ['Command not found: fmt-hook'] },
        ),
      ],
    },
    {
      kind: 'modelSets',
      label: 'Model sets',
      description: 'Named models and a default.',
      components: [
        component('modelSets', 'Claude models', {
          kind: 'modelSets',
          models: ['Opus 5.5', 'Sonnet 5.5'],
          default: 'Sonnet 5.5',
        }),
      ],
    },
  ],
});

export const DATA: MachineData = {
  credentials: CREDENTIALS,
  runtimes: RUNTIMES,
  profiles: PROFILES,
  components: COMPONENTS,
};

export const APPLIED = { outcome: 'executed', executor: 'setup', summary: 'Done.' };

/** The R3-M1 file, planted where the fleet needs a directory: the apply fails after the runtime's file landed. */
export const LANDED_FILE = '/home/kirin/.ferretry/config/runtimes/claude-work.yaml';
export const UNRESTORED_PATH = '/home/kirin/.ferretry/fleet/homes/rt-1/settings.json';
export const BACKUP_PATH = '/home/kirin/.ferretry/fleet/homes/rt-1/settings.json.bak';

/** A 200 answer: the daemon applied the change, the fleet apply failed and was put back, the file stayed. */
export const ROLLED_BACK = {
  outcome: 'applied',
  apply: {
    outcome: 'rolled-back',
    failedOperation: 'Publishing the fleet',
    reason: 'fleet/bin is a file, not a directory',
    configurationLanded: [LANDED_FILE],
  },
};

/** A 200 answer: the fleet apply failed and part of it could not be put back. */
export const ROLLBACK_INCOMPLETE = {
  outcome: 'applied',
  apply: {
    outcome: 'rollback-incomplete',
    failedOperation: 'Publishing the fleet',
    reason: 'disk is full',
    unrestored: [{ path: UNRESTORED_PATH, reason: 'permission denied', backup: BACKUP_PATH }],
    configurationLanded: [LANDED_FILE],
  },
};

/** A 200 answer: the apply finished. */
export const COMMITTED = {
  outcome: 'applied',
  apply: {
    outcome: 'committed',
    result: {
      accountCount: 1,
      operationCount: 1,
      manifestPath: '/home/kirin/.ferretry/fleet/manifest.json',
      prunedWrappers: [],
      sharedHistory: [],
    },
  },
};

/** The four reads and an open authority: a machine that answers everything and asks for nothing. */
export const READS = (data: MachineData = DATA): Record<string, unknown> => ({
  'GET /v1/logins': data.credentials,
  'GET /v1/runtimes': data.runtimes,
  'GET /v1/runtimes/profiles': data.profiles,
  'GET /v1/runtimes/components': data.components,
  'GET /v1/runtimes/machine': machine(),
});
