import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * The folders the shells this daemon has open were started in. A managed worktree is never removed from under a live
 * shell, and Ferrets imports no plugin, so whoever runs the shells (Terminals) contributes this and the worktree
 * removal asks it.
 */
export interface TerminalRootsSource {
  /** Every open shell's start folder (absolute). Throws when the shells could not be listed: that is not "none". */
  roots(): Promise<readonly string[]>;
}

/** Terminals contributes its open shells' folders; worktree removal reads them (docs/rebuild/ports/terminals.md). */
export const TerminalRoots = defineHook('terminal.roots', {
  mode: 'contribute',
  item: z.custom<TerminalRootsSource>(),
});
