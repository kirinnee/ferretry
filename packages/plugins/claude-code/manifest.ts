import { appAction, definePlugin, panel, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import {
  CLAUDE_CODE,
  CLAUDE_CODE_AGENT_HOMES,
  CLAUDE_CODE_AUDIT,
  CLAUDE_CODE_CONFIG,
  CLAUDE_CODE_DISCOVERY,
  CLAUDE_CODE_HOOKS,
  CLAUDE_CODE_READ_MODELS,
  CLAUDE_CODE_SETTINGS,
  CLAUDE_CODE_WORDS,
  ClaudeCodePort,
  ClaudeCodeUpdateFinished,
} from './contract/index.ts';
import { audit, cap, Harnesses } from './contract/core.ts';

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
      }),
      verb('harness claude-code update', { summary: 'update claude, with the command for how it was installed' }),
      verb('harness claude-code settings ls', { summary: 'the Claude Code settings items on this machine' }),
      verb('harness claude-code settings show', { summary: 'one settings item and where it is used' }),
      verb('harness claude-code settings add', { summary: 'add a settings item' }),
      verb('harness claude-code settings edit', {
        summary: 'change a settings item; every runtime that uses it changes too',
      }),
      verb('harness claude-code settings rm', { summary: 'remove a settings item' }),
      verb('harness claude-code hooks ls', { summary: 'the Claude Code hooks items on this machine' }),
      verb('harness claude-code hooks show', { summary: 'one hooks item and where it is used' }),
      verb('harness claude-code hooks add', { summary: 'add a hooks item' }),
      verb('harness claude-code hooks edit', {
        summary: 'change a hooks item; every runtime that uses it changes too',
      }),
      verb('harness claude-code hooks rm', { summary: 'remove a hooks item' }),
    ],
    app: [
      appAction('permission.answer', {
        on: 'ferret',
        label: 'Answer permission prompt',
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
    // The permission card and the harness-dialog card draw above the composer, for either harness.
    panels: [
      panel('bottom', { id: 'permission-request', order: 20 }),
      panel('bottom', { id: 'harness-dialog', order: 30 }),
    ],
    settings: [settingsTab('claude-code', { label: 'Claude Code', order: 20 })],
  },

  data: {
    state: [CLAUDE_CODE_AGENT_HOMES, CLAUDE_CODE_DISCOVERY],
    config: [CLAUDE_CODE_CONFIG, CLAUDE_CODE_SETTINGS, CLAUDE_CODE_HOOKS],
    readModels: CLAUDE_CODE_READ_MODELS,
    publishes: [ClaudeCodeUpdateFinished],
  },

  hooks: {
    takes: [{ hook: Harnesses, key: CLAUDE_CODE }],
  },

  onboarding: [{ id: 'harness', title: 'Claude Code', order: 20 }],
  doctor: ['claude-code-paths'],

  permissions: {
    roots: ['agent-homes', 'harness-history'],
    network: ['registry.npmjs.org'],
    spawn: ['claude', 'npm', 'pnpm', 'bun', 'volta', 'brew', 'nix'],
    secrets: [],
  },
});
