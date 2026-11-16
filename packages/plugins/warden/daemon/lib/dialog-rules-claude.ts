/**
 * CLAUDE CODE'S DIALOG RULES: every screen Claude Code draws that a key can dismiss or decline, and the one way out.
 *
 * Read off real panes of Claude Code 2.1.220, 2.1.281 and (the dangerous-rm prompt, which has no fixture: it is a
 * Bash permission prompt whose reason line is printed by the binary) the 2.1.317 strings. No rule picks a row that
 * grants: each `choose` is the row that DECLINES, and the planner refuses a grant anyway.
 *
 * Not here, on purpose (they stay a notice): the folder-trust screen (its only ways out are to trust or to exit the
 * ferret), the usage-limit screen (the auto-move's), and any screen this build has no name for.
 */
import type { DialogRule } from '../../contract/dialog-rules.ts';

export const CLAUDE_DIALOG_RULES: readonly DialogRule[] = [
  {
    // "Dangerous rm operation detected" and its two siblings (an rm on a possibly-empty variable path, an rm inside a
    // `bash -c` script) all print this lead on their reason line. The owner never allows one: Esc declines at once.
    id: 'claude-dangerous-rm',
    harness: 'claude-code',
    kind: 'permission',
    body: '^Bash\\b',
    text: '^Dangerous rm(?:dir)? operation\\b',
    action: { press: 'escape' },
  },
  {
    id: 'claude-mcp-servers',
    harness: 'claude-code',
    kind: 'mcp-servers',
    title: '^new mcp servers? found\\b',
    action: { choose: 'Continue without using this MCP server' },
  },
  {
    id: 'claude-settings-error',
    harness: 'claude-code',
    kind: 'settings-error',
    title: '^settings error$',
    action: { choose: 'Continue without these settings' },
  },
  {
    // The LSP-plugin recommendation: a `lspRecommendation*` key in the ferret's home keeps it away; this is the backstop.
    id: 'claude-lsp-recommendation',
    harness: 'claude-code',
    kind: 'other',
    title: '^lsp plugin recommendation$',
    action: { choose: 'No, not now' },
  },
];
