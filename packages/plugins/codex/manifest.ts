import { definePlugin, panel, route, settingsTab, refusedItemOptions, verb } from '@ferretry/kernel/manifest';
import {
  CODEX,
  CODEX_AGENT_HOMES,
  CODEX_CONFIG,
  CODEX_DISCOVERY,
  CODEX_HISTORY_ENTRIES,
  CODEX_HISTORY_POOL,
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
import { FerretsChanged, Harnesses, StartDecide } from '@ferretry/core-ferrets/contract';
import { LoginChanged, LoginsPort } from '@ferretry/plugin-logins/contract';
import {
  PROFILE_COMPONENTS_KEY,
  ProfileCodexHooksSource,
  ProfileCodexSettingsSource,
  RuntimesPort,
} from '@ferretry/plugin-runtimes/contract';
import { HARNESS_DIALOG_RULES_KEY, WardenDialogRulesCodex } from '@ferretry/plugin-warden/contract';

/**
 * The Codex segment of daemon setup (r10 O10): one flat list the shell linearizes. The import steps (43-47, 49) follow the
 * CURRENT answer at `import-choice` and are shown (never skipped, which the shell persists) when it is not "choose what";
 * `conversations` is asked in both modes.
 */
const CODEX_STEPS = [
  { id: 'installed', title: 'Install Codex', order: 40, group: 'Codex', stepHost: true },
  { id: 'sign-in', title: 'Sign in to Codex', order: 41, group: 'Codex', stepHost: true },
  { id: 'import-choice', title: 'What to bring over', order: 42, group: 'Codex', stepHost: true },
  { id: 'import-settings', title: 'Settings', order: 43, group: 'Codex', stepHost: true },
  { id: 'import-model-set', title: 'Models', order: 44, group: 'Codex', stepHost: true },
  { id: 'import-instructions', title: 'AGENTS.md', order: 45, group: 'Codex', stepHost: true },
  { id: 'import-skills', title: 'Skills', order: 46, group: 'Codex', stepHost: true },
  { id: 'import-mcp', title: 'MCP servers', order: 47, group: 'Codex', stepHost: true },
  { id: 'conversations', title: 'Conversations', order: 48, group: 'Codex', stepHost: true },
  { id: 'import-run', title: 'Bring it over', order: 49, group: 'Codex', stepHost: true },
  { id: 'permission', title: 'Permissions', order: 50, group: 'Codex', stepHost: true },
  { id: 'ready', title: 'Your runtime', order: 51, group: 'Codex', stepHost: true },
] as const;

/** The panel id that draws one step's body. */
const stepPanelId = (step: string): string => `step-${step}`;

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
  // Which settings components a runtime's profile selects (`RuntimesApi.layers`), read live and late (Runtimes takes this
  // plugin's component sources, so it cannot be a build edge): only those items reach that runtime's home.
  uses: { runtimes: RuntimesPort, logins: LoginsPort },

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
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('harness codex update', {
        summary: 'update codex, with the command for how it was installed',
        args: [],
        options: [
          { flag: '--to <version>', help: 'install this version, or "verified" for the one Ferretry verified' },
          { flag: '--yes', help: 'do not ask before updating' },
          {
            flag: '--allow-unverified',
            help: 'install a version Ferretry has not verified yet (--yes never implies this)',
          },
        ],
      }),
      verb('harness codex settings ls', {
        summary: 'the Codex settings items on this machine',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('harness codex settings show', {
        summary: 'one settings item and where it is used',
        args: [{ name: 'name', help: 'the settings item’s name' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('harness codex settings add', {
        summary: 'add a settings item',
        args: [{ name: 'name', help: 'the settings item’s name' }],
        options: [
          ...refusedItemOptions([]),
          { flag: '--file <path>', help: "the item's text, from a local file" },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('harness codex settings edit', {
        summary: 'change a settings item; every runtime that uses it changes too',
        args: [{ name: 'name', help: 'the settings item’s name' }],
        options: [
          ...refusedItemOptions([]),
          { flag: '--file <path>', help: "the item's text, from a local file" },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('harness codex settings rm', {
        summary: 'remove a settings item',
        args: [{ name: 'name', help: 'the settings item’s name' }],
        options: [
          { flag: '--remove-from-profiles', help: 'take it out of every profile that has it first' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
    ],
  },

  ui: {
    settings: [settingsTab('codex', { icon: 'code-xml', group: 'tools', label: 'Codex', order: 21 })],
    // The body of each Codex setup step (Onboarding's flow offers this slot): one panel per step, each drawn only for its own `codex.<step>` subject.
    panels: CODEX_STEPS.map(step => panel('onboarding.step', { id: stepPanelId(step.id), order: step.order })),
  },

  data: {
    state: [
      CODEX_AGENT_HOMES,
      CODEX_HISTORY_POOL,
      CODEX_DISCOVERY,
      CODEX_FAST_CATALOG,
      CODEX_ROLLOUTS,
      CODEX_LAUNCH_SETTINGS,
    ],
    config: [CODEX_CONFIG, CODEX_SETTINGS, CODEX_HOOKS],
    readModels: CODEX_READ_MODELS,
    publishes: [CodexUpdateFinished],
    // A ferret that stopped or went away, and a login removed, signed out or switched off, each take the login's sign-in
    // back out of the Codex homes it was linked into (`RootHandle.linkCredential` makes the link; nothing else removes it).
    subscribes: [FerretsChanged, LoginChanged],
  },

  hooks: {
    // Runtimes reads the Codex `settings` components a profile names through this plugin, which alone owns them.
    takes: [
      { hook: Harnesses, key: CODEX },
      { hook: StartDecide },
      { hook: ProfileCodexSettingsSource, key: PROFILE_COMPONENTS_KEY },
      { hook: ProfileCodexHooksSource, key: PROFILE_COMPONENTS_KEY },
      // The Warden clears the screens this plugin draws by rules that live here (`daemon/dialog-rules.ts`).
      { hook: WardenDialogRulesCodex, key: HARNESS_DIALOG_RULES_KEY },
    ],
  },

  onboarding: CODEX_STEPS,
  doctor: ['codex-paths'],

  permissions: {
    // Every ferret home links these entries to one pool of this plugin's own (`RootHandle.linkHistory`).
    historyPool: { state: CODEX_HISTORY_POOL.name, entries: CODEX_HISTORY_ENTRIES },
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
