/** Stable role exposed by this workspace package's initial public surface. */
export const packageRole = 'fleet' as const;

export * from './login.ts';
export * from './provisioning.ts';
export * from './usage.ts';
