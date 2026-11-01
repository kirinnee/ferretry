import type { RemoteBrowserPaneState } from '../../src/features/browser/remote-browser-pane.tsx';

/** What a pane publishes, with the display facts a test does not care about filled in quietly. */
export const paneState = (
  state: Pick<RemoteBrowserPaneState, 'status' | 'busy' | 'error' | 'runAction'>,
): RemoteBrowserPaneState => ({
  ...state,
  connection: 'connected',
  fit: true,
  viewportMode: 'responsive',
  toggleFit: () => undefined,
  toggleViewportMode: () => undefined,
  pasteFromClipboard: () => undefined,
  clearError: () => undefined,
});
