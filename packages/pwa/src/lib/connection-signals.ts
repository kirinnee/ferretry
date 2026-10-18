/**
 * THE BROWSER SAYING THE NETWORK MAY HAVE CHANGED, AS ONE PORT.
 *
 * Three signals mean "what you knew about your sockets may be stale": the device came back online,
 * the page came back to the foreground (a phone that slept), and the network itself changed
 * (`navigator.connection`, where the browser has it). Each one is the moment to stop waiting out a
 * backoff and to prove the sockets still held are still alive — a phone that wakes holding a socket
 * the far end evicted minutes ago should find out in seconds, not at its next regular ping.
 */

import type { DaemonId } from './daemon-connection.ts';

/** Which signal fired. Reported for tests and diagnostics; every one is acted on the same way. */
export type ConnectionSignal = 'online' | 'visible' | 'network-change';

/** Where the signals come from, injected so a suite needs no browser. */
export interface ConnectionSignalEnvironment {
  /** Registers `listener` for every signal; returns how to stop. */
  readonly listen: (listener: (signal: ConnectionSignal) => void) => () => void;
}

/** What a signal acts on. The health model and the carrier router, as narrowly as they are used. */
export interface ConnectionSignalTargets {
  /** Every daemon currently reconnecting. */
  readonly reconnecting: () => readonly DaemonId[];
  readonly retryNow: (daemonId: DaemonId) => void;
  /** A ping on every held session, with a short deadline. */
  readonly checkLiveness: () => void;
}

/** Act on every signal: retry each outage now, and prove each live session is still alive. */
export const watchConnectionSignals = (
  environment: ConnectionSignalEnvironment,
  targets: ConnectionSignalTargets,
): (() => void) =>
  environment.listen(() => {
    targets.checkLiveness();
    for (const daemonId of targets.reconnecting()) targets.retryNow(daemonId);
  });

/** The slice of a browser this reads. Each part is optional: a browser without one has no such signal. */
export interface ConnectionSignalGlobals {
  readonly window?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly document?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  readonly navigator?: {
    readonly connection?: {
      addEventListener(type: 'change', listener: () => void): void;
      removeEventListener(type: 'change', listener: () => void): void;
    };
  };
}

/** The page's own signals. `navigator.connection` is feature-detected: Safari and Firefox have none. */
export const browserConnectionSignals = (
  globals: ConnectionSignalGlobals = globalThis as unknown as ConnectionSignalGlobals,
): ConnectionSignalEnvironment => ({
  listen: listener => {
    const online = (): void => listener('online');
    const visibility = (): void => {
      if (globals.document?.visibilityState === 'visible') listener('visible');
    };
    const change = (): void => listener('network-change');
    const connection = globals.navigator?.connection;
    globals.window?.addEventListener('online', online);
    globals.document?.addEventListener('visibilitychange', visibility);
    connection?.addEventListener('change', change);
    return () => {
      globals.window?.removeEventListener('online', online);
      globals.document?.removeEventListener('visibilitychange', visibility);
      connection?.removeEventListener('change', change);
    };
  },
});
