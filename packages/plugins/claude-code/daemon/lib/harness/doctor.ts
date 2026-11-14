import type { DoctorFinding } from '@ferretry/kernel/contract';
import type { DoctorRun } from '@ferretry/kernel/manifest';
import type { ClaudeLocation } from '../update/ports.ts';

/** Today's sentence (`harness-readiness.ts` `harnessAbsenceImpact`): what an absent `claude` breaks, and what it does not. */
const CLAUDE_ABSENCE_IMPACT =
  'A wrapper the fleet publishes for a claude account runs `claude`, so no claude session can start on this host. Accounts on the other harness are unaffected.';

/** One location as a person reads it: the file, and the rule that chose it (today's `harnessLocationLine`). */
const locationLine = (location: Exclude<ClaudeLocation, { readonly outcome: 'override-absent' }>): string =>
  location.outcome === 'located'
    ? `${location.path}  (${location.rule} — ${location.declaredBy})`
    : location.searched.length === 0
      ? 'not found in the inherited environment, and no extra search path is declared'
      : `not found in the inherited environment, nor in ${location.searched.join(', ')}`;

/**
 * THE `claude` DOCTOR ROW (today's `harnessCommand`): whether the harness's own command is on THIS MACHINE, which file it
 * is, and which rule chose it (`docs/harness-paths.md`). Nothing is launched but the location rule's own `--version`
 * look, and the row never says the harness is signed in or can reach its provider.
 *
 * `alternative`, NEVER `required`: a host with only Codex installed is a working host, so a missing Claude is a warning
 * and the report stays ready. An override that names nothing is a misconfiguration rather than an absence: its reason
 * leads, because the operator has already done the thing this row would otherwise tell them to do.
 */
export function claudeCodeDoctor(locate: () => Promise<ClaudeLocation>): DoctorRun {
  return async (): Promise<DoctorFinding | undefined> => {
    let location: ClaudeLocation;
    try {
      location = await locate();
    } catch {
      return undefined;
    }
    const base = { name: 'claude', requirement: 'alternative' } as const;
    if (location.outcome === 'located')
      return { ...base, state: 'ok', detail: locationLine(location), fix: CLAUDE_ABSENCE_IMPACT };
    if (location.outcome === 'override-absent')
      return {
        ...base,
        state: 'warn',
        detail: 'declared, and unusable',
        fix: `${location.declaredBy} names ${location.path}, and ${location.reason}. ${CLAUDE_ABSENCE_IMPACT}`,
      };
    return { ...base, state: 'warn', detail: locationLine(location), fix: CLAUDE_ABSENCE_IMPACT };
  };
}
