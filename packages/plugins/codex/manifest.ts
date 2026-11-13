import { definePlugin, panel, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import {
  CODEX,
  CODEX_AGENT_HOMES,
  CODEX_CONFIG,
  CODEX_DISCOVERY,
  CODEX_FAST_CATALOG,
  CODEX_HOOKS,
  CODEX_READ_MODELS,
  CODEX_ROLLOUTS,
  CODEX_LAUNCH_SETTINGS,
  CODEX_SETTINGS,
  CodexPort,
  CodexUpdateFinished,
} from './contract/index.ts';
import { cap } from '@ferretry/core-gate/contract';
import { Harnesses, StartDecide } from '@ferretry/core-ferrets/contract';
import {
  PROFILE_COMPONENTS_KEY,
  ProfileCodexHooksSource,
  ProfileCodexSettingsSource,
} from '@ferretry/plugin-runtimes/contract';

/**
 * Codex (§2.3): a harness, the same way as Claude Code. It takes `harnesses:codex` from Ferrets and needs a `runners`
 * provider only at run time (no build edge). Machine-level routes sit under `/v1/codex/…` (§3.2). The permission-prompt
 * and harness-dialog answers (`POST /v1/ferrets/:ferretId/permission|dialog`, G31 and G32) are declared once, by Claude
 * Code, and serve a Codex ferret too: the harness is read from the ferret. Codex words: none (Claude Code owns
 * `harness` and `transcript`).
 */
export default definePlugin({
  id: 'codex',
  title: 'Codex',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['harness', 'command', 'view'],

  provides: { codex: CodexPort },

  actions: {
    routes: [
      route('GET /v1/codex/update', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read; the update view is not recorded today (docs/audit.md)' },
        guard: { none: 'install facts and versions only' },
      }),
      route('POST /v1/codex/update', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'not recorded today (docs/audit.md has no update row); the install log is the job report' },
        guard: { none: 'install facts and versions only' },
      }),
    ],
    cli: [
      verb('harness codex status', {
        summary: 'where codex is, how it was installed, its version, and whether Ferretry verified it',
      }),
      verb('harness codex update', { summary: 'update codex, with the command for how it was installed' }),
      verb('harness codex settings ls', { summary: 'the Codex settings items on this machine' }),
      verb('harness codex settings show', { summary: 'one settings item and where it is used' }),
      verb('harness codex settings add', { summary: 'add a settings item' }),
      verb('harness codex settings edit', {
        summary: 'change a settings item; every runtime that uses it changes too',
      }),
      verb('harness codex settings rm', { summary: 'remove a settings item' }),
    ],
  },

  ui: {
    settings: [settingsTab('codex', { label: 'Codex', order: 21 })],
    // The first-run step's body (Onboarding's steps screen offers this slot): the same view as the Settings tab.
    panels: [panel('onboarding.step', { id: 'onboarding-step', order: 21 })],
  },

  data: {
    state: [CODEX_AGENT_HOMES, CODEX_DISCOVERY, CODEX_FAST_CATALOG, CODEX_ROLLOUTS, CODEX_LAUNCH_SETTINGS],
    config: [CODEX_CONFIG, CODEX_SETTINGS, CODEX_HOOKS],
    readModels: CODEX_READ_MODELS,
    publishes: [CodexUpdateFinished],
  },

  hooks: {
    // Runtimes reads the Codex `settings` components a profile names through this plugin, which alone owns them.
    takes: [
      { hook: Harnesses, key: CODEX },
      { hook: StartDecide },
      { hook: ProfileCodexSettingsSource, key: PROFILE_COMPONENTS_KEY },
      { hook: ProfileCodexHooksSource, key: PROFILE_COMPONENTS_KEY },
    ],
  },

  onboarding: [{ id: 'harness', title: 'Codex', order: 21 }],
  doctor: ['codex-paths'],

  permissions: {
    roots: ['agent-homes', 'harness-history'],
    network: ['registry.npmjs.org'],
    spawn: [
      'codex',
      'npm',
      'pnpm',
      'bun',
      'volta',
      'brew',
      'nix',
      'which',
      'test',
      'realpath',
      'readlink',
      'printenv',
      'uname',
    ],
    secrets: [],
  },
});
