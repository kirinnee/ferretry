import type { DoctorCheck, SpawnPort } from '@ferretry/kernel/contract';
import type { SelftestProbe } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import type { TmuxCommandPort } from '../../lib/tmux/contracts.ts';
import { judgeTmuxRelease, type TmuxReleaseReading } from '../../lib/tmux/version.ts';
import type { ControlTimer } from './control-tmux-process.ts';
import { KernelTmuxProcess, TMUX_PROGRAM } from './kernel-tmux-process.ts';
import { TmuxReleaseReader } from './tmux-release-reader.ts';

/** The doctor row's id; the same words head the selftest line. */
export const TMUX_RELEASE_CHECK = 'tmux-release';

/**
 * The doctor's `tmux release` row. It reads what the release job last saw, or asks once (bounded) when the job has
 * not run yet. NEITHER STARTS A TMUX SERVER: `tmux -V` prints and exits, and `display-message` against a socket nobody
 * serves fails with "no server running".
 */
export function tmuxReleaseDoctorCheck(read: () => Promise<TmuxReleaseReading>): DoctorCheck {
  return {
    id: TMUX_RELEASE_CHECK,
    title: 'tmux release',
    run: async () => judgeTmuxRelease(await read()),
  };
}

/** A one-shot (never control-mode, never attaching) tmux on a socket, for read-only questions. */
export function readOnlyTmux(spawn: SpawnPort, socketPath: string): TmuxCommandPort {
  return new KernelTmuxProcess(spawn, socketPath);
}

/** The reader both the job and the selftest use, over the spawn port and the clock they were handed. */
export function releaseReader(
  spawn: SpawnPort,
  socketPath: string,
  after: ControlTimer,
  timeoutMs?: number,
): TmuxReleaseReader {
  return new TmuxReleaseReader(spawn, TMUX_PROGRAM, readOnlyTmux(spawn, socketPath), after, timeoutMs);
}

/**
 * THE `tmux-release` SELFTEST (`fyd --check` only; ruling #27 Q1). Two read-only questions and nothing else: `tmux -V`,
 * and `display-message` on THIS daemon's own socket in its own state folder. A missing server is a failed line and
 * never a new server — no `new-session`, no `start-server`, no attach. The kernel's timeout kills the children.
 */
export const tmuxReleaseSelftest: SelftestProbe = {
  label: 'tmux',
  host: true,
  run: async ({ spawn, stateDir, clock }) => {
    if (spawn === undefined || stateDir === undefined)
      throw new Error('the check handed no spawn port or state folder');
    const reading = await releaseReader(spawn, `${stateDir}/tmux.sock`, (ms, fn) =>
      clock.after(milliseconds(ms), fn),
    ).read();
    const verdict = judgeTmuxRelease(reading);
    if (verdict.state === 'fail') throw new Error(verdict.detail);
    if (reading.server === undefined)
      throw new Error('no tmux server is running on the daemon socket; none was started');
    return verdict.detail;
  },
};
