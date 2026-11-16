import type { DoctorFinding } from '@ferretry/kernel/contract';
import type { DoctorRun } from '@ferretry/kernel/manifest';
import { TMUX_PROGRAM } from './kernel-tmux-process.ts';

/** Today's sentence (`daemon/src/lib/core/doctor.ts`, `tmux` row): what an absent tmux breaks. */
export const TMUX_ABSENT_IMPACT = 'Sessions cannot start or be managed.';

/**
 * Where a bare program name resolves, or nothing: `kernel.paths.which`. It searches the daemon's `PATH` for a regular
 * file this process may execute and RUNS NOTHING — the same name the spawn port is handed to launch tmux.
 */
export type ProgramLocator = (name: string) => Promise<string | undefined>;

/**
 * THE `tmux` DOCTOR ROW (today's `binary(input, 'tmux', 'required', …)`): tmux is found and may be run, or it is not.
 *
 * REQUIRED, not a note: with no tmux no session starts, so an absent one is a `fail` — the doctor report is then
 * `required` + `missing` and not ready, and the CLI says FAIL. The rows' words are today's: `found on PATH at <path>`
 * (ok), or `not found on PATH` with the impact above as the fix.
 *
 * It resolves {@link TMUX_PROGRAM} — the one name every tmux launch in this plugin uses — and launches nothing to find
 * out (the release row is the one that asks tmux anything, and only `tmux -V`).
 */
export function tmuxAvailabilityDoctor(locate: ProgramLocator): DoctorRun {
  return async (): Promise<DoctorFinding> => {
    const resolved = await locate(TMUX_PROGRAM);
    return resolved === undefined
      ? { state: 'fail', detail: 'not found on PATH', fix: TMUX_ABSENT_IMPACT }
      : { state: 'ok', detail: `found on PATH at ${resolved}`, fix: TMUX_ABSENT_IMPACT };
  };
}
