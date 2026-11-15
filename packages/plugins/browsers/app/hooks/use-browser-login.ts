/**
 * THE HUMAN SIGN-IN WINDOW of one daemon, as the Browser panel sees it.
 *
 * The status is read from the daemon's own `DaemonBrowserLoginStore` (built over that daemon's guarded client, so the
 * credential and the `browser` grant stay the shell's). Watching it subscribes the store, which polls while the panel
 * is mounted and stops when the last watcher goes. Without a store there is nothing to watch or to open: the panel
 * then offers no login action rather than implying it can reach one.
 *
 * The snapshot carries a live VNC password. It stays in the store's memory and in this hook's return value; nothing
 * here writes it to storage, a URL or a log.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { BrowserLoginAction } from '../../contract/index.ts';
import type { BrowserLoginSnapshot, DaemonBrowserLoginStore } from '../lib/browser-login.ts';
import type { BrowserDaemon } from '../lib/scope.ts';

export interface BrowserLogin {
  /** `null` is "not read yet" (or no store): nothing is known, so nothing is drawn. */
  readonly status: BrowserLoginSnapshot | null;
  /** Asks the daemon to open the window. Never rejects: a failure is an `unknown` snapshot. */
  readonly open: (() => Promise<BrowserLoginSnapshot>) | undefined;
  /** The person's own close: `primed` is "I signed in". */
  readonly close: ((primed: boolean) => Promise<BrowserLoginSnapshot>) | undefined;
}

const START: BrowserLoginAction = { action: 'start' };
const never = (): null => null;
const unwatched = (): (() => void) => () => undefined;

export function useBrowserLogin(daemon: BrowserDaemon, store: DaemonBrowserLoginStore | undefined): BrowserLogin {
  const subscribe = useCallback(
    (listener: () => void) => (store === undefined ? unwatched() : store.subscribe(daemon, listener)),
    [daemon, store],
  );
  const read = useCallback(
    () => (store === undefined ? null : store.getSnapshot(daemon.daemonId)),
    [daemon.daemonId, store],
  );
  const status = useSyncExternalStore(subscribe, read, never);
  return useMemo(
    () =>
      store === undefined
        ? { status, open: undefined, close: undefined }
        : {
            status,
            open: () => store.act(daemon, START),
            close: primed => store.act(daemon, { action: 'stop', primed }),
          },
    [daemon, status, store],
  );
}
