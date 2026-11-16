import type { Harness } from '@ferretry/core-ferrets/contract';
import { composeClaudeHarness, type ClaudeMembers } from '../harness/parts/compose.ts';
import type { ClaudeHarnessDeps } from '../harness/parts/core.ts';

export interface ClaudeHarness extends ClaudeMembers {}

/**
 * Claude Code as a harness (§4.3): the value of `harnesses:claude-code`. It finds `claude`, writes a ferret's home
 * in Claude's own format inside `agent-homes`, starts and resumes it through whatever runner Ferrets hands it,
 * delivers messages into its pane, and reads its transcript and usage back. It never opens a sign-in file.
 *
 * It holds no member of its own: each is served by one part under `harness/parts/` (one registry, `parts/index.ts`),
 * and this class is the parts composed over one set of dependencies.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the members come from the parts and are typed once, in ClaudeMembers; the constructor assigns every one of them
export class ClaudeHarness implements Harness {
  constructor(deps: ClaudeHarnessDeps) {
    Object.assign(this, composeClaudeHarness({ deps, delivered: new Set<string>() }));
  }
}
