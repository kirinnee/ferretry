import { isAbsolute } from 'node:path';
import { type ProcessIncarnation, procStatStartTicks, psStartSeconds } from '../lib/process-incarnation.ts';

/** Linux: the kernel's start time in clock ticks, exact per incarnation. */
export class ProcStatProcessIncarnation implements ProcessIncarnation {
  constructor(private readonly procRoot = '/proc') {}

  async startOf(pid: number): Promise<number | undefined> {
    try {
      return procStatStartTicks(await Bun.file(`${this.procRoot}/${pid}/stat`).text());
    } catch {
      return undefined;
    }
  }
}

/**
 * macOS: the start time `ps` reads from the kernel's `kinfo_proc`, to the second.
 *
 * A second is exact enough here because macOS hands out pids in increasing order up to 99999 before
 * wrapping, so a reused pid inside the same second needs ninety-nine thousand process launches in
 * that second — and the reaper also requires the tmux pane id, which one server never reuses. `ps`
 * is named by absolute path so a daemon's minimal `PATH` can neither miss it nor be handed another.
 */
export class PsProcessIncarnation implements ProcessIncarnation {
  constructor(private readonly psExecutable = '/bin/ps') {
    if (!isAbsolute(psExecutable)) throw new Error('the ps executable must be an absolute path');
  }

  async startOf(pid: number): Promise<number | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    try {
      const child = Bun.spawn([this.psExecutable, '-o', 'lstart=', '-p', String(pid)], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        env: { LC_ALL: 'C', TZ: 'UTC0' },
      });
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return code === 0 ? psStartSeconds(stdout) : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Any other platform: sessions refuse to start, saying why, rather than registering an unprovable pane. */
export class UnsupportedProcessIncarnation implements ProcessIncarnation {
  constructor(private readonly platform: string) {}

  async startOf(): Promise<number | undefined> {
    throw new Error(
      `sessions cannot start on ${this.platform}: Ferretry can only tell a session's process apart from a later one on Linux and macOS`,
    );
  }
}

/** The incarnation source for the platform this program runs on. */
export function processIncarnationFor(platform: string = process.platform): ProcessIncarnation {
  if (platform === 'linux') return new ProcStatProcessIncarnation();
  if (platform === 'darwin') return new PsProcessIncarnation();
  return new UnsupportedProcessIncarnation(platform);
}
