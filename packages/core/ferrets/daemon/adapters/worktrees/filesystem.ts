import type { Clock } from '@ferretry/kernel/contract';
import type { WorktreeClock } from '../../lib/worktrees/ports.ts';

/**
 * Today's `NodeWorktreeFileSystem` (mkdir with a mode, realpath, lstat, exclusive write with a mode) is NOT ported
 * here: a subsystem reaches the file system only through kernel roots (`banned-globals`). `WorktreeFileSystem` in
 * `lib/worktrees/ports.ts` names exactly the `RootHandle` additions being made on `rebuild/port-kernel`
 * (`makeDirectory(mode)`, `realPath`, `lstat`, exclusive `writeText(mode)`); the host binds it to the `worktrees`
 * root when they land.
 */

/** Today's `SystemWorktreeClock`, on the kernel clock. */
export class KernelWorktreeClock implements WorktreeClock {
  constructor(private readonly clock: Clock) {}

  nowIso(): string {
    return this.clock.now();
  }
}
