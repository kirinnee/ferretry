/**
 * KEEPS THE MACHINE ON SCREEN TELLING THIS BROWSER WHEN ITS CONFIGURATION MOVES.
 *
 * One configuration stream (`/v1/events?topic=config`) for the machine the route names, folded into the
 * app store's per-machine counters; every screen that shows configuration reads again when a counter it
 * depends on moves (docs/config-files.md "Live changes"). It is the one subscription for the whole
 * app, mounted by the shell, so ten open screens never mean ten sockets.
 *
 * BACK IN THE FOREGROUND, OR BACK ONLINE, IT REOPENS AT ONCE. A phone that slept may hold a socket that
 * died silently; reopening costs one frame, and that frame's revision is how the store learns whether
 * anything moved while the app was away. Nothing is read on a timer.
 *
 * KEYED ON THE PAIRING, NOT ON THE CONNECTION OBJECT, for the same reason the fleet poll is: a daemon
 * republishing its carriers hands the app a new object for the same machine.
 */

import { useEffect, useRef } from 'react';
import { type ConfigStreamEnvironment, startConfigChangeStream } from '../lib/config-changes.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { AppStore } from '../lib/store.tsx';

/** The browser seams the feed needs, injectable so a suite drives them. */
export interface ConfigChangeFeedEnvironment extends ConfigStreamEnvironment {
  /** Calls back whenever the app may have been away: it is visible again, or the network came back. */
  readonly onReturn: (callback: () => void) => () => void;
}

export const browserConfigChangeFeedEnvironment: ConfigChangeFeedEnvironment = {
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  random: () => Math.random(),
  onReturn: callback => {
    const visible = (): void => {
      if (document.visibilityState !== 'hidden') callback();
    };
    document.addEventListener('visibilitychange', visible);
    globalThis.addEventListener('online', callback);
    return () => {
      document.removeEventListener('visibilitychange', visible);
      globalThis.removeEventListener('online', callback);
    };
  },
};

export function useConfigChangeFeed(
  store: Pick<AppStore, 'clients' | 'configChanges'>,
  connection: DaemonConnection | undefined,
  environment: ConfigChangeFeedEnvironment = browserConfigChangeFeedEnvironment,
): void {
  const current = useRef(connection);
  current.current = connection;
  const daemonId = connection?.daemonId;
  const baseUrl = connection?.baseUrl;
  const deviceId = connection?.deviceId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairing's three facts are the deliberate key
  useEffect(() => {
    const paired = current.current;
    if (paired === undefined) return;
    let stop = false;
    let control: ReturnType<typeof startConfigChangeStream> | undefined;
    let opening = false;
    const begin = (): void => {
      if (opening) return;
      opening = true;
      void store.clients.client(paired).then(
        api => {
          if (stop) return;
          control = startConfigChangeStream({
            api,
            environment,
            onFrame: frame => store.configChanges.observe(paired.daemonId, frame),
          });
        },
        // A machine this browser cannot reach yet answers nothing, and the screens keep what they read;
        // the next return to the foreground tries again.
        () => {
          opening = false;
        },
      );
    };
    begin();
    const release = environment.onReturn(() => {
      if (control === undefined) begin();
      else control.reconnect();
    });
    return () => {
      stop = true;
      release();
      control?.stop();
    };
  }, [daemonId, baseUrl, deviceId, environment, store]);
}
