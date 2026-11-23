import {
  appAction,
  definePlugin,
  panel,
  route,
  settingsTab,
  refusedItemOptions,
  verb,
} from '@ferretry/kernel/manifest';
import {
  CLAUDE_CODE,
  CLAUDE_CODE_AGENT_HOMES,
  CLAUDE_CODE_AUDIT,
  CLAUDE_CODE_CONFIG,
  CLAUDE_CODE_DISCOVERY,
  CLAUDE_CODE_HISTORY_ENTRIES,
  CLAUDE_CODE_HISTORY_POOL,
  CLAUDE_CODE_LAUNCH_SETTINGS,
  CLAUDE_CODE_HOOKS,
  CLAUDE_CODE_READ_MODELS,
  CLAUDE_CODE_SETTINGS,
  CLAUDE_CODE_WORDS,
  ClaudeCodePort,
  ClaudeCodeUpdateFinished,
} from './contract/index.ts';
import { audit, cap } from '@ferretry/core-gate/contract';
import { FerretsPort, Harnesses, StartDecide } from '@ferretry/core-ferrets/contract';
import {
  PROFILE_COMPONENTS_KEY,
  ProfileClaudeHooksSource,
  ProfileClaudeSettingsSource,
  RuntimesPort,
} from '@ferretry/plugin-runtimes/contract';
import { HARNESS_DIALOG_RULES_KEY, WardenDialogRulesClaude } from '@ferretry/plugin-warden/contract';

/**
 * Claude Code (§2.3): a harness. It takes `harnesses:claude-code` from Ferrets and needs a `runners` provider only at
 * run time (no build edge). Route paths: the machine-level ones sit under `/v1/claude-code/…` (§3.2 route prefix);
 * the two per-ferret answers keep their place under the ferret, `/v1/sessions/:sessionId/…` renamed to
 * `/v1/ferrets/:ferretId/…` (§1.4). They are declared here because Claude Code owns G31 and G32; Codex's prompts and
 * dialogs are answered through the same two routes (the harness is read from the ferret).
 */
export default definePlugin({
  id: 'claude-code',
  title: 'Claude Code',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['harness', 'command', 'view'],
  words: CLAUDE_CODE_WORDS,

  // The prompt read below is Ferrets' own (`FerretsApi.prompt`): the pane's recorded permission request and dialog, masked.
  needs: { ferrets: FerretsPort },
  // Which settings and hooks components a runtime's profile selects (`RuntimesApi.layers`), read live and late (Runtimes
  // takes this plugin's component sources, so it cannot be a build edge): only those items reach that runtime's home.
  uses: { runtimes: RuntimesPort },
  provides: { claudeCode: ClaudeCodePort },

  actions: {
    routes: [
      route('GET /v1/claude-code/update', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read; the update view is not recorded today (docs/audit.md)' },
        guard: { none: 'install facts and versions only' },
      }),
      route('POST /v1/claude-code/update', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'not recorded today (docs/audit.md has no update row); the install log is the job report' },
        guard: { none: 'install facts and versions only' },
      }),
      // What the ferret is stopped on (Ferrets' record of its pane), for the two cards. A ferret reads only its own and its
      // helpers' (Ferrets' `mayTouch`). The body is built from text Ferrets masked inside one `Redaction.read`, and is
      // withheld by the kernel's final check if Vault cannot vouch for it. Answering stays the two POSTs below.
      route('GET /v1/ferrets/:ferretId/prompt', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('terminal', 'use'),
        noStore: true,
        audit: { skip: 'a read; the pane prompt is not recorded (docs/audit.md)' },
        guard: 'secrets',
      }),
      route('POST /v1/ferrets/:ferretId/permission', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('terminal', 'use'),
        noStore: true,
        audit: audit(CLAUDE_CODE_AUDIT.permission),
        guard: {
          none: 'the answer carries a request id and whether the prompt cleared, never pane text or the choice',
        },
      }),
      route('POST /v1/ferrets/:ferretId/dialog', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('terminal', 'use'),
        noStore: true,
        audit: audit(CLAUDE_CODE_AUDIT.dialog),
        guard: { none: 'the answer carries a dialog id and whether the dialog cleared, never pane text or the choice' },
      }),
    ],
    cli: [
      verb('harness claude-code status', {
        summary: 'where claude is, how it was installed, its version, and whether Ferretry verified it',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('harness claude-code update', {
        summary: 'update claude, with the command for how it was installed',
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
      verb('harness claude-code settings ls', {
        summary: 'the Claude Code settings items on this machine',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('harness claude-code settings show', {
        summary: 'one settings item and where it is used',
        args: [{ name: 'name', help: 'the settings item’s name' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('harness claude-code settings add', {
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
      verb('harness claude-code settings edit', {
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
      verb('harness claude-code settings rm', {
        summary: 'remove a settings item',
        args: [{ name: 'name', help: 'the settings item’s name' }],
        options: [
          { flag: '--remove-from-profiles', help: 'take it out of every profile that has it first' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('harness claude-code hooks ls', {
        summary: 'the Claude Code hooks items on this machine',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('harness claude-code hooks show', {
        summary: 'one hooks item and where it is used',
        args: [{ name: 'name', help: 'the hooks item’s name' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('harness claude-code hooks add', {
        summary: 'add a hooks item',
        args: [{ name: 'name', help: 'the hooks item’s name' }],
        options: [
          ...refusedItemOptions([]),
          { flag: '--file <path>', help: "the item's text, from a local file" },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('harness claude-code hooks edit', {
        summary: 'change a hooks item; every runtime that uses it changes too',
        args: [{ name: 'name', help: 'the hooks item’s name' }],
        options: [
          ...refusedItemOptions([]),
          { flag: '--file <path>', help: "the item's text, from a local file" },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('harness claude-code hooks rm', {
        summary: 'remove a hooks item',
        args: [{ name: 'name', help: 'the hooks item’s name' }],
        options: [
          { flag: '--remove-from-profiles', help: 'take it out of every profile that has it first' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
    ],
    app: [
      appAction('permission.answer', {
        on: 'ferret',
        label: 'Approve or deny',
        calls: 'POST /v1/ferrets/:ferretId/permission',
      }),
      appAction('dialog.answer', {
        on: 'ferret',
        label: 'Answer harness dialog',
        calls: 'POST /v1/ferrets/:ferretId/dialog',
      }),
    ],
  },

  ui: {
    // The permission card and the harness-dialog card draw above the composer, for either harness. The slot is
    // Conversation's (its contract names it, `CONVERSATION_ABOVE_COMPOSER_SLOT`); written out here because this plugin
    // imports nothing of Conversation, and the shell's slot test pairs the two names.
    panels: [
      panel('conversation.above-composer', { id: 'permission-request', order: 20 }),
      panel('conversation.above-composer', { id: 'harness-dialog', order: 30 }),
      // The Claude segment's first-run pages (r10 O7); each draws only for its own step. The import pages (O7b) are the seven after the choice.
      panel('onboarding.step', { id: 'onboarding-installed', order: 20 }),
      panel('onboarding.step', { id: 'onboarding-sign-in', order: 21 }),
      panel('onboarding.step', { id: 'onboarding-import-choice', order: 22 }),
      panel('onboarding.step', { id: 'onboarding-import-settings', order: 23 }),
      panel('onboarding.step', { id: 'onboarding-import-model-set', order: 24 }),
      panel('onboarding.step', { id: 'onboarding-import-instructions', order: 25 }),
      panel('onboarding.step', { id: 'onboarding-import-skills', order: 26 }),
      panel('onboarding.step', { id: 'onboarding-import-mcp', order: 27 }),
      panel('onboarding.step', { id: 'onboarding-conversations', order: 28 }),
      panel('onboarding.step', { id: 'onboarding-import-run', order: 29 }),
      panel('onboarding.step', { id: 'onboarding-permission', order: 30 }),
      panel('onboarding.step', { id: 'onboarding-ready', order: 31 }),
    ],
    settings: [settingsTab('claude-code', { icon: 'sparkles', group: 'tools', label: 'Claude Code', order: 20 })],
  },

  data: {
    state: [CLAUDE_CODE_AGENT_HOMES, CLAUDE_CODE_HISTORY_POOL, CLAUDE_CODE_DISCOVERY, CLAUDE_CODE_LAUNCH_SETTINGS],
    config: [CLAUDE_CODE_CONFIG, CLAUDE_CODE_SETTINGS, CLAUDE_CODE_HOOKS],
    readModels: CLAUDE_CODE_READ_MODELS,
    publishes: [ClaudeCodeUpdateFinished],
  },

  hooks: {
    // Runtimes reads the Claude `settings` and `hooks` components a profile names through this plugin, which alone owns them.
    takes: [
      { hook: Harnesses, key: CLAUDE_CODE },
      { hook: StartDecide },
      { hook: ProfileClaudeSettingsSource, key: PROFILE_COMPONENTS_KEY },
      { hook: ProfileClaudeHooksSource, key: PROFILE_COMPONENTS_KEY },
      // The Warden clears the screens this plugin draws by rules that live here (`daemon/dialog-rules.ts`).
      { hook: WardenDialogRulesClaude, key: HARNESS_DIALOG_RULES_KEY },
    ],
  },

  // The one sentence that keeps Claude's dangerous-rm guard from stopping a Claude ferret (c58 O11b). Claude only: Codex has no such guard.
  instructions: [{ id: 'rm-targets', text: 'instructions/rm.md', when: { role: 'any', harness: CLAUDE_CODE } }],

  // The Claude segment (side: daemon, group: Claude Code: both are the defaults). The import steps 23-29 have their pages
  // in O7b; the retired `harness` step is replaced by `installed`.
  onboarding: [
    { id: 'installed', title: 'Install Claude Code', order: 20, stepHost: true },
    { id: 'sign-in', title: 'Sign in to Claude', order: 21, stepHost: true },
    { id: 'import-choice', title: 'What to bring over', order: 22, stepHost: true },
    { id: 'import-settings', title: 'Settings', order: 23, stepHost: true },
    { id: 'import-model-set', title: 'Models', order: 24, stepHost: true },
    { id: 'import-instructions', title: 'CLAUDE.md', order: 25, stepHost: true },
    { id: 'import-skills', title: 'Skills', order: 26, stepHost: true },
    { id: 'import-mcp', title: 'MCP servers', order: 27, stepHost: true },
    { id: 'conversations', title: 'Conversations', order: 28, stepHost: true },
    { id: 'import-run', title: 'Bring it over', order: 29, stepHost: true },
    { id: 'permission', title: 'Permissions', order: 30, stepHost: true },
    { id: 'ready', title: 'Your runtime', order: 31, stepHost: true },
  ],
  doctor: ['claude-code-paths'],

  permissions: {
    // Every ferret home links these entries to one pool of this plugin's own (`RootHandle.linkHistory`).
    historyPool: { state: CLAUDE_CODE_HISTORY_POOL.name, entries: CLAUDE_CODE_HISTORY_ENTRIES },
    roots: ['agent-homes', 'harness-history'],
    network: ['registry.npmjs.org'],
    // tmux: the answers type into the ferret's pane; which, readlink, uname, printenv: the facts the kernel has no port for.
    spawn: ['claude', 'npm', 'pnpm', 'bun', 'volta', 'brew', 'nix', 'tmux', 'which', 'readlink', 'uname', 'printenv'],
    secrets: [],
  },
});
