/** Stable role exposed by this workspace package's initial public surface. */
export const packageRole = 'pwa' as const;

export * from './daemon-connection.ts';
export * from './api-client.ts';
export * from './drafts.ts';
export * from './daemon-scope.ts';
export * from './daemon-transport.ts';
export * from './pairing.ts';
