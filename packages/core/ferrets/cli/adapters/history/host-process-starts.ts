import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Tells one run of a pid apart from a later process that reuses the number. */
export interface ProcessStartSource {
  /** `undefined` when the pid is gone or its start cannot be read. */
  startOf(pid: number): Promise<number | undefined>;
}

/** Field 22 of `/proc/<pid>/stat`, counted after the parenthesised command name, which may hold spaces. */
export function procStatStart(text: string): number | undefined {
  const fields = text
    .slice(text.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/u);
  const start = Number(fields[19]);
  return Number.isSafeInteger(start) && start > 0 ? start : undefined;
}

/** `ps -o lstart=` under `LC_ALL=C TZ=UTC0` (`Sat Sep  6 18:48:09 2026`), as epoch seconds. */
export function psStart(text: string): number | undefined {
  const millis = Date.parse(`${text.trim().replace(/^[A-Z][a-z]{2} /u, '')} UTC`);
  return Number.isFinite(millis) && millis > 0 ? Math.floor(millis / 1000) : undefined;
}

/**
 * The host's own record of when a process started: `/proc` on Linux, `ps` elsewhere.
 *
 * The value is only ever compared with another read on the same host, so each platform's own unit is fine. `ps` is
 * named by absolute path so a minimal `PATH` can neither miss it nor be handed another.
 */
export class HostProcessStarts implements ProcessStartSource {
  constructor(
    private readonly platform: string,
    private readonly procRoot = '/proc',
    private readonly psExecutable = '/bin/ps',
  ) {}

  async startOf(pid: number): Promise<number | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    if (this.platform === 'linux') {
      const text = await readFile(join(this.procRoot, String(pid), 'stat'), 'utf8').catch(() => undefined);
      return text === undefined ? undefined : procStatStart(text);
    }
    const child = Bun.spawn([this.psExecutable, '-o', 'lstart=', '-p', String(pid)], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      env: { LC_ALL: 'C', TZ: 'UTC0' },
    });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? psStart(text) : undefined;
  }
}
