import {
  type BrowserDaemon,
  type BrowserSessionScope,
  type BrowserViewerSlot,
  browserSessionScope,
} from '../../../app/lib/scope.ts';

/** The `(daemonId, sessionId)` identity a surface speaks for. */
export const daemonSessionScope = (
  daemon: Pick<BrowserDaemon, 'daemonId'>,
  sessionId: string,
  viewer?: BrowserViewerSlot,
): BrowserSessionScope => browserSessionScope(daemon, sessionId, viewer);
