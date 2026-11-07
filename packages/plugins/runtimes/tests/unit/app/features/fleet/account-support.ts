/**
 * Fixtures for the Runtimes suites: the prototype's studio-mac, written out longhand and parsed through the real
 * schemas, so a wire change fails here first. Only what the runtimes app reads is here (the machine and the
 * runtimes); the logins, profiles and components fixtures go with the plugins that own those views.
 */

import {
  type LayeredProfileView,
  type MachineView,
  MachineViewSchema,
  type RuntimeCatalog,
  RuntimeCatalogSchema,
  type RuntimeView,
} from '../../../../../contract/index.ts';

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

export const APPLIED = { outcome: 'executed', executor: 'setup', summary: 'Done.' };
