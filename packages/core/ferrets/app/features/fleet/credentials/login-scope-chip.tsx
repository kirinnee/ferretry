/**
 * A login's scope chip: "Claude only", "Codex only", or "Claude + Codex" for a login whose provider
 * drives both CLIs with one secret (docs/provider-presets.md). Every place a login is listed shows it,
 * so a Codex login is never picked for a Claude Code runtime by mistake.
 */

import { Badge } from '../../../shell/primitives.tsx';
import { type HarnessKind, LOGIN_SCOPE_WORDS, scopeOfHarnesses } from './credentials-model.ts';

export function LoginScopeChip({ harnesses }: { readonly harnesses: readonly HarnessKind[] }) {
  const scope = scopeOfHarnesses(harnesses);
  return <Badge data-login-scope={scope}>{LOGIN_SCOPE_WORDS[scope]}</Badge>;
}
