/** Stable role exposed by this workspace package's initial public surface. */
export const packageRole = 'pwa' as const;

export * from '../shell/bottom-sheet.tsx';
export * from '../shell/primitives.tsx';
export * from '../shell/sheet-tabs.tsx';
export * from '../shell/side-pane-resize-handle.tsx';
export * from '../shell/side-pane-search.tsx';
export * from '../shell/side-pane-tab-icons.ts';
export * from '../shell/side-pane-tabs.tsx';
export * from '../shell/side-pane-tab-model.ts';
export * from '../shell/view-tabs.tsx';
export * from '../hooks/use-details-tab.ts';
export * from '../hooks/use-dialog-focus.ts';
export * from '../worklets/pcm16-worklet.ts';
export * from './api-client.ts';
export * from './class-names.ts';
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
export * from './side-pane-preferences.ts';
