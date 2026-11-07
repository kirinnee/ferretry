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

import { createContext, useContext, useEffect } from 'react';
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

export function useNotificationOpen(
  source: NotificationOpenSource | null,
  origin: string,
  navigate: (to: string) => void,
): void {
  const provided = useContext(NotificationOpenContext);
  useEffect(() => {
    if (provided !== null) return provided.subscribe(navigate);
    if (source === null) return;
    const inbox = new NotificationOpenInbox(origin);
    source.addEventListener('message', inbox.receive);
    const stop = inbox.subscribe(navigate);
    return () => {
      stop();
      source.removeEventListener('message', inbox.receive);
    };
  }, [navigate, origin, provided, source]);
}
