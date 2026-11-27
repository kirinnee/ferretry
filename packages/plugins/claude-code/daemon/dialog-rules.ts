/**
 * CLAUDE CODE'S DIALOG RULES: every screen Claude Code draws that a key can dismiss or decline, and the one way out.
 *
 * Read off real panes of Claude Code 2.1.220, 2.1.281 and (the dangerous-rm prompt, which has no fixture: it is a
 * Bash permission prompt whose reason line is printed by the binary) the 2.1.317 strings. No rule picks a row that
 * grants: each `choose` is the row that DECLINES, and the planner refuses a grant anyway.
 *
 * The Warden reads this table through the `warden.dialog-rules.claude` hook (`daemon/index.ts`), validates every rule, and
 * drops one it refuses; it owns the engine that presses the keys, this plugin owns the words of the screens it draws.
 *
 * Not here, on purpose (they stay a notice): the folder-trust screen (its only ways out are to trust or to exit the
 * ferret), the usage-limit screen (the auto-move's), and any screen this build has no name for.
 */
import type { DialogRule } from '@ferretry/plugin-warden/contract';

/**
 * What a ferret is told, as its next message and by no hook, after a rule declined its prompt: why it was denied, so it
 * tries again the way Claude accepts. Fixed words by rule id; never pane text. A rule with no entry says nothing.
 */
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
