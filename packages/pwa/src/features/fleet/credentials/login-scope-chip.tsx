/**
 * A login's scope chip: "Claude only" or "Codex only", from which CLI the login drives
 * (docs/provider-presets.md). Every place a login is listed shows it, so a Codex login is never picked
 * for a Claude Code runtime by mistake.
 */

import { Badge } from '../../../shell/primitives.tsx';
import { SCOPE_WORDS } from '../components/component-model.ts';
import type { HarnessKind } from './credentials-model.ts';

export function LoginScopeChip({ harness }: { readonly harness: HarnessKind }) {
  return <Badge data-login-scope={harness}>{SCOPE_WORDS[harness]}</Badge>;
}
