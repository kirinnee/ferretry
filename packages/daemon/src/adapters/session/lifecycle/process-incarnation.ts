import { isAbsolute } from 'node:path';

/**
 * Tells one run of a pid apart from a later process that reuses the same number.
 *
 * The value is only ever compared for equality with another read on the same host, so its unit is
 * each platform's own: Linux clock ticks since boot, macOS whole seconds since the epoch. Both are
 * positive safe integers, which is the shape a stored pane registration already carries, so a
 * registration written before this port existed stays readable unchanged.
 */
export interface ProcessIncarnation {
  /** `undefined` when the process is gone or unreadable; throws only when the platform has no source. */
  startOf(pid: number): Promise<number | undefined>;
}

function positive(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Field 22 of `/proc/<pid>/stat`, counted after the parenthesised command name that may hold spaces. */
export function procStatStartTicks(text: string): number | undefined {
  const close = text.lastIndexOf(')');
  if (close < 1) return undefined;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  if (fields.length < 20) return undefined;
  return positive(Number(fields[19]));
}

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `ps -o lstart=` under `LC_ALL=C` and `TZ=UTC0`: `Sat Sep  6 18:48:09 2026`, as epoch seconds.
 *
 * Both variables are pinned by the caller because the text is otherwise localised AND local time,
 * so a daylight-saving change between registering a pane and reaping it would make the same
 * process read as a different one.
 */
export function psStartSeconds(text: string): number | undefined {
  const match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(text.trim());
  if (match === null) return undefined;
  const [, month, day, hour, minute, second, year] = match;
  const monthIndex = MONTHS.indexOf(month ?? '');
  if (monthIndex < 0) return undefined;
  const millis = Date.UTC(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second));
  return positive(millis / 1000);
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

/** The incarnation source for the platform this daemon runs on. */
export function processIncarnationFor(platform: string = process.platform): ProcessIncarnation {
  if (platform === 'linux') return new ProcStatProcessIncarnation();
  if (platform === 'darwin') return new PsProcessIncarnation();
  return new UnsupportedProcessIncarnation(platform);
}
