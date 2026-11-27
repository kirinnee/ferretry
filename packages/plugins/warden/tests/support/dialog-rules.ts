/**
 * SAMPLE BUILT-IN DIALOG RULES for the Warden's engine tests: the same words as the tables the harness plugins own
 * (`claude-code/daemon/dialog-rules.ts`, `codex/daemon/dialog-rules.ts`), frozen here so the engine is tested over
 * realistic rules without the Warden depending on a harness plugin. The tables themselves are tested in their plugins.
 */
import type { DialogRule } from '../../contract/dialog-rules.ts';

export const DIALOG_NUDGES: Readonly<Record<string, string>> = {
  'claude-dangerous-rm':
    'Your last command was denied: Claude Code flagged a dangerous rm. Retry it with explicit absolute rm paths; never "$VAR", a $(cmd) variable, or rm inside bash -c.',
};

export const CLAUDE_DIALOG_RULES: readonly DialogRule[] = [
  {
    // "Dangerous rm operation detected" and its two siblings (an rm on a possibly-empty variable path, an rm inside a
    // `bash -c` script) all print this lead on their reason line. The owner never allows one: Esc declines at once.
    id: 'claude-dangerous-rm',
    harness: 'claude',
    kind: 'permission',
    body: '^Bash\\b',
    text: '^Dangerous rm(?:dir)? operation\\b',
    action: { press: 'escape' },
  },
  {
    id: 'claude-mcp-servers',
    harness: 'claude',
    kind: 'mcp-servers',
    title: '^new mcp servers? found\\b',
    action: { choose: 'Continue without using this MCP server' },
  },
  {
    id: 'claude-settings-error',
    harness: 'claude',
    kind: 'settings-error',
    title: '^settings error$',
    action: { choose: 'Continue without these settings' },
  },
  {
    // The LSP-plugin recommendation: a `lspRecommendation*` key in the ferret's home keeps it away; this is the backstop.
    id: 'claude-lsp-recommendation',
    harness: 'claude',
    kind: 'other',
    title: '^lsp plugin recommendation$',
    action: { choose: 'No, not now' },
  },
  {
    // "Claude in Chrome" (2.1.327, drawn by `--chrome`): a notice with no rows. Esc closes it and turns nothing on.
    id: 'claude-chrome-notice',
    harness: 'claude',
    kind: 'other',
    title: '^claude in chrome$',
    action: { press: 'escape' },
  },
];

export const CODEX_DIALOG_RULES: readonly DialogRule[] = [
  {
    // Declining trusts nothing: the person's hooks do not run in this runtime until somebody chooses otherwise.
    id: 'codex-hooks-review',
    harness: 'codex',
    kind: 'hooks-review',
    title: '^hooks need review$',
    action: { choose: "Continue without trusting (hooks won't run)" },
  },
  {
    // The list "Review hooks" opens: Esc closes it.
    id: 'codex-hooks-list',
    harness: 'codex',
    kind: 'hooks-list',
    title: '^hooks$',
    action: { press: 'escape' },
  },
  {
    // "Skip" installs nothing and records nothing; "Update now" and "Skip until next version" are never pressed.
    id: 'codex-update',
    harness: 'codex',
    kind: 'update',
    title: 'update available',
    action: { choose: 'Skip' },
  },
  {
    // 0.164's "Meet GPT-6 Sol": keep the model the ferret was started on.
    id: 'codex-model-successor',
    harness: 'codex',
    kind: 'other',
    title: '^meet gpt-\\S+',
    action: { choose: 'Use existing model' },
  },
];
