/**
 * Fixtures for the Runtimes and Credentials suites: the prototype's studio-mac, written out longhand
 * and parsed through the real schemas, so a wire change fails here first.
 */

import {
  type FleetComponentCatalog,
  FleetComponentCatalogSchema,
  type FleetCredentialList,
  FleetCredentialListSchema,
  type FleetCredentialView,
  type FleetLayeredProfileCatalog,
  FleetLayeredProfileCatalogSchema,
  type FleetLayeredProfileView,
  type FleetMachineView,
  type FleetRuntimeCatalog,
  FleetRuntimeCatalogSchema,
  type FleetRuntimeView,
  type HarnessLoginFlow,
} from '@ferretry/protocol';
import type { z } from 'zod';
import type { FleetClient } from '../../../../src/features/fleet/fleet-client.ts';
import type { MachineData } from '../../../../src/features/fleet/runtimes/machine-data.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';

export const NOW = Date.parse('2026-10-13T08:00:00.000Z');
export const CHANGE_ID = 'fy_fprop_abcdefghijklmnopqrstuv';

export const STUDIO = daemonConnection({
  daemonId: 'studio',
  baseUrl: 'https://studio.example.test',
  deviceId: 't',
});

export const machine = (overrides: Partial<FleetMachineView> = {}): FleetMachineView => ({
  name: 'studio-mac',
  format: 'version-2',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  tools: [
    { harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
    { harness: 'codex', label: 'Codex', installed: true, command: '/usr/local/bin/codex' },
  ],
  runtimeCount: 5,
  runningSessions: 0,
  authority: { mayApply: true, applyRefusal: 'granted' },
  ...overrides,
});

/** The machine view with this caller's authority: where every change reads what it may do. */
export const machineWith = (authority: Partial<FleetMachineView['authority']>): FleetMachineView =>
  machine({ authority: { mayApply: true, applyRefusal: 'granted', ...authority } });

const status = (word: FleetCredentialView['status']['word']): FleetCredentialView['status'] => {
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

export const credential = (overrides: Partial<FleetCredentialView> & { id: string }): FleetCredentialView => ({
  harness: 'claude',
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

export const withStatus = (word: FleetCredentialView['status']['word']) => ({ status: status(word) });

export const CREDENTIALS: FleetCredentialList = FleetCredentialListSchema.parse({
  format: 2,
  machine: 'studio-mac',
  credentials: [
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
      store: 'host',
      sharedWithTerminal: true,
      usedBy: ['codex-default'],
      usage: { fiveHour: {}, weekly: {} },
    }),
    credential({ id: 'claude-work', label: 'work', ...withStatus('refresh_due'), usedBy: ['claude-work'] }),
  ],
});

const stack = (
  harness: 'claude' | 'codex',
  overrides: Partial<FleetLayeredProfileView['harnesses'][number]> = {},
): FleetLayeredProfileView['harnesses'][number] => ({
  harness,
  available: { available: true },
  applied: ['instructions/Main instructions', 'modelSets/Claude models'],
  skipped: [],
  conflicts: [],
  partial: [],
  ...overrides,
});

export const profile = (overrides: Partial<FleetLayeredProfileView> & { name: string }): FleetLayeredProfileView => ({
  layers: ['instructions/Main instructions', 'modelSets/Claude models'],
  usedBy: [],
  baseFor: [],
  wouldIncludeItself: [],
  scope: { kind: 'scoped', scope: 'generic' },
  harnesses: [stack('claude'), stack('codex')],
  remove: { available: true },
  ...overrides,
});

export const PROFILES: FleetLayeredProfileCatalog = FleetLayeredProfileCatalogSchema.parse({
  format: 'version-2',
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
        stack('claude'),
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
        stack('claude', { applied: ['hooks/Format on save'] }),
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
  kind: FleetComponentCatalog['kinds'][number]['kind'],
  name: string,
  detail: FleetComponentCatalog['kinds'][number]['components'][number]['detail'],
  overrides: Partial<FleetComponentCatalog['kinds'][number]['components'][number]> = {},
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

export const COMPONENTS: FleetComponentCatalog = FleetComponentCatalogSchema.parse({
  format: 'version-2',
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
        component('settings', 'Claude settings', { kind: 'settings', env: [] }, { harness: 'claude' }),
        component('settings', 'Agent settings', { kind: 'settings', env: [] }, { harness: 'claude' }),
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
          { harness: 'claude', warnings: ['Command not found: fmt-hook'] },
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

const modelSet = (models: readonly [string, boolean][], declaredDefault: string, resolved?: string) => ({
  source: 'model-set' as const,
  name: 'Claude models',
  models: models.map(([id, available]) => ({ id, available })),
  declaredDefault,
  ...(resolved === undefined ? {} : { default: resolved }),
});

export const runtime = (overrides: Partial<FleetRuntimeView> & { name: string }): FleetRuntimeView => ({
  id: `rt-${overrides.name}`,
  wrapper: overrides.name,
  harness: 'claude',
  credential: { id: 'claude-personal', store: 'host', label: 'personal', status: 'ready' },
  profile: 'Default',
  agent: false,
  stack: stack('claude'),
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

export const RUNTIMES: FleetRuntimeCatalog = FleetRuntimeCatalogSchema.parse({
  format: 'version-2',
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

export const DATA: MachineData = {
  credentials: CREDENTIALS,
  runtimes: RUNTIMES,
  profiles: PROFILES,
  components: COMPONENTS,
};

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export type Route = unknown | Error | ((call: Call) => unknown);

/** `"GET /v1/fleet/credentials"` → answer. A route with no answer fails like an unreachable machine. */
export const scripted = (routes: Readonly<Record<string, Route>>, calls: Call[] = []): FleetClient => ({
  request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    const call: Call = {
      method: init?.method ?? 'GET',
      path,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${path}`;
    if (!(key in routes)) throw new Error(`no route ${key}`);
    const answer = routes[key];
    const value = typeof answer === 'function' ? (answer as (call: Call) => unknown)(call) : answer;
    if (value instanceof Error) throw value;
    return schema.parse(value);
  },
});

/** The four reads and an open authority: a machine that answers everything and asks for nothing. */
export const READS = (data: MachineData = DATA): Record<string, Route> => ({
  'GET /v1/fleet/credentials': data.credentials,
  'GET /v1/fleet/runtimes': data.runtimes,
  'GET /v1/fleet/profiles': data.profiles,
  'GET /v1/fleet/components': data.components,
  'GET /v1/fleet/machine': machine(),
});

/** A staged change, echoing what was sent. */
export const stagedFrom = (call: Call) => ({
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

export const claudeFlow = (
  state: 'starting' | 'awaiting-code' | 'complete' | 'failed',
  credentialId = 'claude-work',
): HarnessLoginFlow => {
  const base = {
    harness: 'claude' as const,
    flowId: 'flow-1',
    credentialId,
    identity: 'claude:you@example.com',
    startedAt: '2026-10-13T08:00:00.000Z',
    expiresAt: '2026-10-13T08:10:00.000Z',
  };
  if (state === 'awaiting-code')
    return { ...base, state, verificationUrl: 'https://claude.ai/oauth/authorize?code=true' };
  if (state === 'complete') return { ...base, state };
  if (state === 'failed') return { ...base, state, reason: 'The sign-in ended.', remedy: 'Run fy fleet login.' };
  return { ...base, state };
};
