import type { DoctorFinding } from '@ferretry/kernel/contract';
import type { DoctorRun } from '@ferretry/kernel/manifest';
import type { HarnessLocation } from './update/ports.ts';

/** Today's sentence (`harness-readiness.ts` `harnessAbsenceImpact`): what an absent `codex` breaks, and what it does not. */
const CODEX_ABSENCE_IMPACT =
  'A wrapper the fleet publishes for a codex account runs `codex`, so no codex session can start on this host. Accounts on the other harness are unaffected.';

/** One location as a person reads it: the file, and the rule that chose it (today's `harnessLocationLine`). */
const locationLine = (location: Exclude<HarnessLocation, { readonly outcome: 'override-absent' }>): string =>
  location.outcome === 'located'
    ? `${location.path}  (${location.rule} — ${location.declaredBy})`
    : location.searched.length === 0
      ? 'not found in the inherited environment, and no extra search path is declared'
      : `not found in the inherited environment, nor in ${location.searched.join(', ')}`;

/**
 * THE `codex` DOCTOR ROW (today's `harnessCommand`): whether the harness's own command is on THIS MACHINE, which file it
 * is, and which rule chose it (`docs/harness-paths.md`). Nothing is launched to find out and the row never says Codex is
 * signed in.
 *
 * `alternative`, NEVER `required`: a host with only Claude installed is a working host, so a missing Codex is a warning
 * and the report stays ready. An override that names nothing is a misconfiguration rather than an absence: its reason
 * (which already names the file and the key) leads the consequence.
 */
export function codexDoctor(locate: () => Promise<HarnessLocation>): DoctorRun {
  return async (): Promise<DoctorFinding | undefined> => {
    let location: HarnessLocation;
    try {
      location = await locate();
    } catch {
      return undefined;
    }
    const base = { name: 'codex', requirement: 'alternative' } as const;
    if (location.outcome === 'located')
      return { ...base, state: 'ok', detail: locationLine(location), fix: CODEX_ABSENCE_IMPACT };
    if (location.outcome === 'override-absent')
      return {
        ...base,
        state: 'warn',
        detail: 'declared, and unusable',
        fix: `${location.reason}. ${CODEX_ABSENCE_IMPACT}`,
      };
    return { ...base, state: 'warn', detail: locationLine(location), fix: CODEX_ABSENCE_IMPACT };
  };
}
