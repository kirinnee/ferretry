/**
 * CODEX'S DIALOG RULES: every screen Codex draws that a key can dismiss or decline, and the one way out.
 *
 * Read off real panes of Codex 0.145.0, 0.156.1, 0.163.0 and 0.164.0 (`packages/plugins/codex/tests/fixtures/dialogs`).
 * No rule picks a row that grants: each `choose` is the row that DECLINES, and the planner refuses a grant anyway.
 *
 * Not here, on purpose (they stay a notice): the sign-in screen (no row dismisses it), the folder-access screens (their
 * only ways out trust the folder or leave it), and the usage-limit screen (the auto-move's).
 */
import type { DialogRule } from '../../contract/dialog-rules.ts';

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
