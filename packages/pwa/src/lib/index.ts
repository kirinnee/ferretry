/** Stable role exposed by this workspace package's initial public surface. */
export const packageRole = 'pwa' as const;

export * from '../hooks/use-details-tab.ts';
export * from '../worklets/pcm16-worklet.ts';
export * from '../components/composer.tsx';
export * from '../components/session-details.tsx';
export * from '../components/session-list.tsx';
export * from '../components/transcript.tsx';
export * from './api-client.ts';
export * from './daemon-connection.ts';
export * from './event-transport.ts';
export * from './daemon-scope.ts';
export * from './daemon-transport.ts';
export * from './drafts.ts';
export * from './pages/new-session.ts';
export * from './pages/page-host.tsx';
export * from './pages/routes.ts';
export * from './pages/warden-page.tsx';
export * from './pairing.ts';
export * from './session-screens.ts';
