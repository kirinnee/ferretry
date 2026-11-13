import { type BrowserDaemon, type BrowserSessionScope, browserSessionScope } from '../../../app/lib/scope.ts';

/** The `(daemonId, sessionId)` identity a surface speaks for. */
export const daemonSessionScope = (daemon: Pick<BrowserDaemon, 'daemonId'>, sessionId: string): BrowserSessionScope =>
  browserSessionScope(daemon, sessionId);
