/**
 * The page's half of a notification tap (`lib/notification-open.ts`): the service worker asks the open
 * window to route to the tapped notification's page, and this routes there IN THE APP — the same push
 * an in-app link makes — and says so, so the worker does not reload the window instead.
 *
 * The entry point's inbox (`NotificationOpenContext`, created in `main.tsx` before React mounts) is
 * what the app routes from, so a tap that arrived while the app was still starting is routed the moment
 * the router is up. Without one — a test, the component harness — this listens on `source` itself, for
 * as long as it is mounted.
 */

import { createContext, useContext, useEffect, useRef } from 'react';
import { notificationTapTarget, type RouteTable } from '../shell.ts';
import {
  NotificationOpenInbox,
  type NotificationOpenSource as NotificationOpenListenable,
} from '../lib/notification-open.ts';

/** The inbox the entry point attached before the app mounted, or `null` where none was provided. */
export const NotificationOpenContext = createContext<NotificationOpenInbox | null>(null);

/** Where the worker's messages arrive: `navigator.serviceWorker` in a browser. */
export interface NotificationOpenSource extends NotificationOpenListenable {
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/**
 * What decides where an open lands: the shell's route table and the machines this browser has paired. A page that is
 * shown a notification by the page itself (the app-wide registration) names its address in a `data.url` the worker
 * can only shape-check — it holds no pairings — so THIS is where a machine this browser never paired is refused.
 */
export interface NotificationTap {
  readonly routes: Pick<RouteTable, 'parse'>;
  readonly isPaired: (daemon: string) => boolean;
}

export function useNotificationOpen(
  source: NotificationOpenSource | null,
  origin: string,
  navigate: (to: string) => void,
  tap: NotificationTap,
): void {
  const provided = useContext(NotificationOpenContext);
  const deciding = useRef(tap);
  deciding.current = tap;
  useEffect(() => {
    // Every open, from the entry point's inbox or this hook's own, goes through the shell's rule: an address the route
    // table does not draw under a paired machine opens the app's home instead (`notificationTapTarget`).
    const open = (path: string): void => {
      const landing = new URL(
        notificationTapTarget(path, origin, deciding.current.routes, deciding.current.isPaired),
        origin,
      );
      navigate(`${landing.pathname}${landing.search}${landing.hash}`);
    };
    if (provided !== null) return provided.subscribe(open);
    if (source === null) return;
    const inbox = new NotificationOpenInbox(origin);
    source.addEventListener('message', inbox.receive);
    const stop = inbox.subscribe(open);
    return () => {
      stop();
      source.removeEventListener('message', inbox.receive);
    };
  }, [navigate, origin, provided, source]);
}
