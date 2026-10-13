/** Fixtures for the setup suites: a machine, a scan, an export, credentials and runtimes, all schema-checked. */

import {
  type FleetCloneBundle,
  FleetCloneBundleSchema,
  type FleetCredentialList,
  FleetCredentialListSchema,
  type FleetCredentialView,
  type FleetMachineView,
  FleetMachineViewSchema,
  type FleetRuntimeCatalog,
  FleetRuntimeCatalogSchema,
  type FleetRuntimeView,
  type FleetSetupScan,
  FleetSetupScanSchema,
} from '@ferretry/protocol';
import { daemonConnection } from '../../../../../src/lib/daemon-connection.ts';

export {
  APPLY_PATH,
  type Call,
  machineAnswer,
  STAGED,
  scriptedClient,
  UNLOCK_TOKEN,
  UNLOCKED,
} from '../shell/change-support.ts';

export const NOW = () => Date.parse('2026-10-13T08:00:00.000Z');
export const PASSWORD = 'correct-horse-battery';

export const STUDIO = daemonConnection({
  daemonId: 'studio',
  baseUrl: 'https://studio.example.test',
  deviceId: 't',
});
export const WORK = daemonConnection({ daemonId: 'work', baseUrl: 'https://work.example.test', deviceId: 'u' });
export const ASLEEP = daemonConnection({
  daemonId: 'asleep',
  baseUrl: 'https://asleep.example.test',
  deviceId: 'v',
});

export const machineView = (overrides: Partial<FleetMachineView> = {}): FleetMachineView =>
  FleetMachineViewSchema.parse({
    name: 'studio-mac',
    format: 'version-2',
    setUp: true,
    agentPermissions: 'auto',
    tools: [
      { harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
      { harness: 'codex', label: 'Codex', installed: false },
    ],
    runtimeCount: 2,
    runningSessions: 0,
    authority: { mayApply: true, applyRefusal: 'granted', confirmation: 'none' },
    ...overrides,
  });

export const FRESH_MACHINE = machineView({ format: 'none', setUp: false, runtimeCount: 0 });

const claudeScan = {
  harness: 'claude',
  installed: true,
  account: { state: 'signed-in', email: 'you@example.com' },
  instructions: { name: 'CLAUDE.md', source: '/home/you/.claude/CLAUDE.md', bytes: 2150 },
  settings: { source: '/home/you/.claude/settings.json', count: 6, hooks: 1 },
  mcpServers: ['github', 'linear', 'notes'],
  skills: ['release-notes', 'pr-review'],
  secretKeys: ['env.ANTHROPIC_API_KEY', 'env.GITHUB_TOKEN'],
  missingCommands: ['uvx'],
  problems: [],
} as const;

const codexScan = {
  harness: 'codex',
  installed: true,
  account: { state: 'not-signed-in' },
  instructions: { name: 'AGENTS.md', source: '/home/you/.codex/AGENTS.md', bytes: 2150 },
  mcpServers: [],
  skills: [],
  secretKeys: [],
  missingCommands: [],
  problems: [],
} as const;

export const scan = (overrides: Partial<FleetSetupScan> = {}): FleetSetupScan =>
  FleetSetupScanSchema.parse({
    machine: 'studio-mac',
    format: 'none',
    tools: [
      { harness: 'claude', label: 'Claude Code', installed: true },
      { harness: 'codex', label: 'Codex', installed: true },
    ],
    harnesses: [claudeScan, codexScan],
    instructionsIdentical: true,
    runtimes: [
      { harness: 'claude', name: 'claude-default', profile: 'default' },
      { harness: 'codex', name: 'codex-default', profile: 'default' },
    ],
    updates: [],
    duplicates: [],
    notes: [
      { harness: 'claude', text: 'notes needs uvx: install uv on studio-mac and it starts working.' },
      { harness: 'codex', text: 'Codex needs sign-in before it launches.' },
    ],
    importing: { available: true },
    ...overrides,
  });

/** Neither tool installed (E1): one runnable, one with no package manager. */
export const NOTHING_INSTALLED = scan({
  tools: [
    {
      harness: 'claude',
      label: 'Claude Code',
      installed: false,
      install: { kind: 'runnable', command: 'npm install -g @anthropic-ai/claude-code' },
    },
    {
      harness: 'codex',
      label: 'Codex',
      installed: false,
      install: {
        kind: 'no-package-manager',
        reason: 'No package manager was found on studio-mac.',
        manualCommand: 'npm install -g @openai/codex',
      },
    },
  ],
  harnesses: [
    { ...claudeScan, installed: false },
    { ...codexScan, installed: false },
  ],
  runtimes: [],
  notes: [],
});

export const runtimeView = (name: string, overrides: Partial<FleetRuntimeView> = {}): FleetRuntimeView => ({
  name,
  id: `rt-${name}`,
  wrapper: name,
  harness: 'claude',
  credential: { id: 'claude-host', store: 'host', status: 'ready' },
  profile: 'default',
  agent: true,
  stack: { harness: 'claude', available: { available: true }, applied: [], skipped: [], conflicts: [], partial: [] },
  modelSet: {
    source: 'model-set',
    name: 'claude',
    models: [{ id: 'opus', available: true }],
    declaredDefault: 'opus',
    default: 'opus',
  },
  launch: { available: true },
  sameAs: [],
  ...overrides,
});

export const runtimes = (list: readonly FleetRuntimeView[]): FleetRuntimeCatalog =>
  FleetRuntimeCatalogSchema.parse({ format: 'version-2', runtimes: list });

export const credentialView = (id: string, overrides: Partial<FleetCredentialView> = {}): FleetCredentialView => ({
  id,
  harness: 'claude',
  store: 'ferretry',
  email: `${id}@example.com`,
  needsLabel: false,
  sharedWithTerminal: false,
  status: {
    word: 'needs_sign_in',
    label: 'Needs sign-in',
    reason: 'not_signed_in',
    explanation: 'Nobody has signed in to this login on this machine yet.',
    lastCheckInconclusive: false,
  },
  usage: { fiveHour: {}, weekly: {} },
  usedBy: [],
  signIn: { available: true },
  checkNow: { available: true },
  signOut: { available: false, sentence: 'Nothing to sign out of.', runtimesAffected: 0, signsOutTerminal: false },
  ...overrides,
});

export const credentials = (list: readonly FleetCredentialView[]): FleetCredentialList =>
  FleetCredentialListSchema.parse({ format: 2, machine: 'studio-mac', credentials: list });

export const bundle = (overrides: Partial<FleetCloneBundle> = {}): FleetCloneBundle =>
  FleetCloneBundleSchema.parse({
    format: 'ferretry-clone',
    version: 1,
    machine: 'work-linux',
    exportedAt: '2026-10-13T07:00:00.000Z',
    credentials: [
      { id: 'claude-work', harness: 'claude', email: 'me@work.example' },
      { id: 'codex-work', harness: 'codex', label: 'Work' },
    ],
    components: {
      instructions: { default: { file: 'components/instructions/default.md' } },
      mcp: { notes: { command: '/home/me/bin/notes-server' } },
      modelSets: { claude: { models: ['opus'], default: 'opus' } },
    },
    profiles: { default: { layers: ['instructions/default'] } },
    runtimes: {
      'claude-default': { credential: 'claude-work', profile: 'default' },
      'claude-review': { credential: 'claude-work', profile: 'default' },
      'codex-default': { credential: 'codex-work', profile: 'default' },
    },
    files: [{ path: 'components/instructions/default.md', content: 'Read /Users/me/notes.md first.' }],
    notCopied: [],
    ...overrides,
  });

/** A credential id, as the clone done screen links it. */
export type { FleetCredentialView };
