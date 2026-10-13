import type { Command } from 'commander';

// Account-model seed, created by U0 and filled by U20 (docs/design/account-model.md §13.2). The
// composition root already calls it, so filling it touches no shared file.

/** Mounts `fy credentials / fy credential …` onto the program. Adds nothing until U20 fills it. */
export function registerCredentialCommands(_program: Command): void {}
