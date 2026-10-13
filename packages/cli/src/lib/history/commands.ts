import type { Command } from 'commander';

// Account-model seed, created by U0 and filled by U8 (docs/design/account-model.md §13.2). The
// composition root already calls it, so filling it touches no shared file.

/** Mounts `fy history` onto the program. Adds nothing until U8 fills it. */
export function registerHistoryCommands(_program: Command): void {}
