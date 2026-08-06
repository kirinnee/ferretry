import type { CgroupPlacementPort } from '../../lib/cgroups/index.ts';

/**
 * Where a live pid actually sits, read from the kernel rather than reconstructed.
 *
 * A SCOPE NAME IS NEVER REBUILT. Every managed scope carries a nonce precisely so it cannot be
 * guessed, and this is the reader that makes that safe: the running scope comes out of the pid's own
 * placement, so a relaunch racing a still-deactivating scope can never be addressed by name.
 *
 * IT THROWS FOR AN UNREADABLE PID, and the domain turns that into a warning plus a conservative
 * restart requirement. Answering with an empty string would be indistinguishable from a pid that is
 * provably in no managed scope, which is the one claim this daemon must not make without evidence.
 */
export class ProcCgroupPlacements implements CgroupPlacementPort {
  /** Overridable only so a test can point the reader at a fixture tree instead of the live kernel. */
  constructor(private readonly procRoot = '/proc') {}

  async placement(pid: number): Promise<string> {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`${pid} is not a process id`);
    return await Bun.file(`${this.procRoot}/${pid}/cgroup`).text();
  }
}
