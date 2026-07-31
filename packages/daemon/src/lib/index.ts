/** Stable role exposed by this workspace package. */
export const packageRole = 'daemon' as const;

export * from './attachments/index.ts';
export * from './instant.ts';
export * from './journal.ts';
export * from './json.ts';
export * from './layout.ts';
export * from './names/index.ts';
export * from './paths.ts';
export * from './ports.ts';
export * from './rebuild.ts';
export * from './reconciliation.ts';
export * from './session-id.ts';
export * from './state-home.ts';
export * from './storage-types.ts';
export * from './task-boards/index.ts';
export * from './tasks/index.ts';
export * from './tmux/index.ts';
export * from './version.ts';
export * from './worktrees/index.ts';
