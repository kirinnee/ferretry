/** A FIXED FAKE screen for the "Screens Ferretry clears" card: no real pane, no real ferret, nothing secret. */
import type { DialogProposal, DialogRulesView } from '../../../contract/dialog-rules.ts';

export const FAKE_PROPOSAL: DialogProposal = {
  ferret: 'ada',
  title: 'Try the new fullscreen renderer? (beta)',
  rows: [
    { number: 1, label: 'Yes, try it', pressed: false },
    { number: 2, label: 'No, keep the current one', pressed: true },
    { number: 3, label: 'Never ask again', pressed: false },
  ],
  held: false,
  rule: {
    id: 'learned-other-1abc',
    harness: 'claude',
    kind: 'other',
    title: '^Try the new fullscreen renderer',
    action: { choose: 'No, keep the current one' },
  },
};

export const FAKE_VIEW: DialogRulesView = {
  builtIn: [
    { id: 'claude-dangerous-rm', harness: 'claude', kind: 'permission', does: 'presses Esc' },
    {
      id: 'claude-mcp-servers',
      harness: 'claude',
      kind: 'mcp-servers',
      does: 'chooses “Continue without using this MCP server”',
    },
    { id: 'codex-update', harness: 'codex', kind: 'update', does: 'chooses “Skip”' },
  ],
  taught: [{ id: 'learned-other-9z', harness: 'codex', kind: 'other', does: 'chooses “Not now”' }],
  pending: [],
};
