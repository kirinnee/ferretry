import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * The canonical current folders of this daemon's live panes. A managed worktree is never removed from under a live
 * shell, and Ferrets imports no plugin, so whoever runs the shells (Terminals) contributes this and the worktree
 * removal asks it.
 */
export interface TerminalRootsSource {
  /** Every live pane's current folder (realpath). Throws on any unreadable endpoint or cwd: that is not "none". */
  roots(): Promise<readonly string[]>;
  /** Exclude new shell/runner launches until removal settles; drain earlier launches before sampling roots. */
  withRemoval<T>(path: string, remove: () => Promise<T>): Promise<T>;
}

/** Terminals contributes its open shells' folders; worktree removal reads them (docs/rebuild/ports/terminals.md). */
export const TerminalRoots = defineHook('terminal.roots', {
  mode: 'contribute',
  item: z.custom<TerminalRootsSource>(),
});
