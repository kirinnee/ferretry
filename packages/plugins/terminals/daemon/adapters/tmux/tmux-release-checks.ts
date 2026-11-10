import type { DoctorFinding, SpawnPort } from '@ferretry/kernel/contract';
import type { DoctorRun, SelftestProbe } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import manifest from '../../../manifest.ts';
import type { TmuxCommandPort } from '../../lib/tmux/contracts.ts';
import {
  renderTmuxReleaseRow,
  type TmuxReleaseReading,
  type TmuxReleaseRow,
  tmuxReleaseRow,
} from '../../lib/tmux/version.ts';
import type { ControlTimer } from './control-tmux-process.ts';
import { boundedSpawn } from './bounded.ts';
import { KernelTmuxProcess, TMUX_PROGRAM } from './kernel-tmux-process.ts';
import { DEFAULT_RELEASE_TIMEOUT_MS, TmuxReleaseReader } from './tmux-release-reader.ts';

const [tmuxSocketState] = manifest.data.state;

/**
 * THE ONE PLACE the tmux socket's path is built: the manifest's opaque `tmux` state file (`tmux.sock`) in Terminals'
 * own state folder. The daemon (from its `downloads` root's parent) and the selftest (from the kernel's `stateDir`)
 * both name the socket through this, so they cannot drift apart.
 */
export function tmuxSocketIn(stateDir: string): string {
  return `${stateDir.replace(/\/+$/u, '')}/${tmuxSocketState.path}`;
}

/**
 * Today's row as a doctor finding: `present` is `ok`, `missing` a `warn` (a capability, so never a `fail` and never
 * "not ready"); the summary is the detail and the impact is the fix, word for word.
 */
export function tmuxReleaseFinding(row: TmuxReleaseRow): DoctorFinding {
  return { state: row.status === 'present' ? 'ok' : 'warn', detail: row.summary, fix: row.impact };
}

/**
 * The doctor's `tmux-release` row. It asks FRESH on every report, as today's doctor did (each question bounded), and
 * reports no row when neither answer came back. NEITHER STARTS A TMUX SERVER: `tmux -V` prints and exits, and
 * `display-message` against a socket nobody serves fails with "no server running".
 */
export function tmuxReleaseDoctor(read: () => Promise<TmuxReleaseReading>): DoctorRun {
  return async () => {
    const row = tmuxReleaseRow(await read());
    return row === undefined ? undefined : tmuxReleaseFinding(row);
  };
}

/** A one-shot (never control-mode, never attaching) tmux on a socket, for read-only questions. */
function readOnlyTmux(spawn: SpawnPort, socketPath: string): TmuxCommandPort {
  return new KernelTmuxProcess(spawn, socketPath);
}

/** The reader the doctor and the selftest use, over the spawn port and the clock they were handed. */
export function releaseReader(
  spawn: SpawnPort,
  socketPath: string,
  after: ControlTimer,
  timeoutMs: number = DEFAULT_RELEASE_TIMEOUT_MS,
): TmuxReleaseReader {
  const bounded = boundedSpawn(spawn, timeoutMs);
  return new TmuxReleaseReader(bounded, TMUX_PROGRAM, readOnlyTmux(bounded, socketPath), after, timeoutMs);
}

/**
 * THE `tmux-release` SELFTEST (`fyd --check` only; ruling #27 Q1). Two read-only questions and nothing else: `tmux -V`,
 * and `display-message` on THIS daemon's own socket in its own state folder, through a spawn that may run tmux and
 * nothing else. The line is today's doctor row text. The one documented difference from today: a missing server is a
 * failed line (Q1) — and never a new server: no `new-session`, no `start-server`, no attach. The kernel's timeout
 * kills the children.
 */
export const tmuxReleaseSelftest: SelftestProbe = {
  label: 'tmux',
  host: true,
  programs: [TMUX_PROGRAM],
  run: async ({ spawn, stateDir, clock }) => {
    if (spawn === undefined || stateDir === undefined)
      throw new Error('the check handed no spawn port or state folder');
    const reading = await releaseReader(spawn, tmuxSocketIn(stateDir), (ms, fn) =>
      clock.after(milliseconds(ms), fn),
    ).read();
    if (reading.server === undefined)
      throw new Error('no tmux server is running on the daemon socket; none was started');
    const row = tmuxReleaseRow(reading);
    if (row === undefined) throw new Error('tmux did not name its release');
    return renderTmuxReleaseRow(row);
  },
};
