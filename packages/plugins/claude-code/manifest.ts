import { appAction, definePlugin, panel, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import {
  CLAUDE_CODE,
  CLAUDE_CODE_AGENT_HOMES,
  CLAUDE_CODE_AUDIT,
  CLAUDE_CODE_CONFIG,
  CLAUDE_CODE_DISCOVERY,
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
          { flag: '--file <path>', help: "the item's text, from a local file" },
          { flag: '--env <NAME=value>', help: 'MCP or settings: one environment variable; repeat it' },
          { flag: '--flag <flag>', help: 'settings: one launch flag; repeat it' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('harness claude-code settings edit', {
        summary: 'change a settings item; every runtime that uses it changes too',
        args: [{ name: 'name', help: 'the settings item’s name' }],
        options: [
          { flag: '--file <path>', help: "the item's text, from a local file" },
          { flag: '--env <NAME=value>', help: 'MCP or settings: one environment variable; repeat it' },
          { flag: '--flag <flag>', help: 'settings: one launch flag; repeat it' },
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
      // The first-run step's body (Onboarding's steps screen offers this slot): the same view as the Settings tab.
      panel('onboarding.step', { id: 'onboarding-step', order: 20 }),
    ],
    settings: [settingsTab('claude-code', { group: 'tools', label: 'Claude Code', order: 20 })],
  },

  data: {
    state: [CLAUDE_CODE_AGENT_HOMES, CLAUDE_CODE_DISCOVERY, CLAUDE_CODE_LAUNCH_SETTINGS],
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
    ],
  },

  onboarding: [{ id: 'harness', title: 'Claude Code', order: 20 }],
  doctor: ['claude-code-paths'],

  permissions: {
    roots: ['agent-homes', 'harness-history'],
    network: ['registry.npmjs.org'],
    // tmux: the answers type into the ferret's pane; which, readlink, uname, printenv: the facts the kernel has no port for.
    spawn: ['claude', 'npm', 'pnpm', 'bun', 'volta', 'brew', 'nix', 'tmux', 'which', 'readlink', 'uname', 'printenv'],
    secrets: [],
  },
});
