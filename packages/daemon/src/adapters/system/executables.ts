import { readlink, stat } from 'node:fs/promises';
import type { ExecutableLookup, ProgramRunner } from '../../lib/input-requests/terminal-modes.ts';

/**
 * Where a running program's executable is, and who owns it, for the adaptive lock's "trusted program" fact
 * (docs/input-requests.md, "How long the lock lasts"). Linux reads `/proc/<pid>/exe`; macOS asks `ps` for the full
 * path. Anything that cannot be read answers `undefined`, which never counts as trusted.
 */
export class SystemExecutables implements ExecutableLookup {
  constructor(
    private readonly platform: string,
    private readonly run: ProgramRunner,
  ) {}

  async path(pid: number): Promise<string | undefined> {
    if (this.platform === 'linux') return await readlink(`/proc/${String(pid)}/exe`).catch(() => undefined);
    if (this.platform !== 'darwin') return undefined;
    const output = await this.run(['ps', '-p', String(pid), '-o', 'comm=']);
    const path = output?.trim();
    return path === undefined || path === '' ? undefined : path;
  }

  async owner(path: string): Promise<{ readonly uid: number; readonly mode: number } | undefined> {
    const found = await stat(path).catch(() => undefined);
    return found === undefined ? undefined : { uid: found.uid, mode: found.mode };
  }
}
