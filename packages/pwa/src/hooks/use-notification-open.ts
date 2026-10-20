/**
 * The page's half of a notification tap (`lib/notification-open.ts`): the service worker asks the open
 * window to route to the tapped notification's page, and this routes there IN THE APP — the same push
 * an in-app link makes — and says so, so the worker does not reload the window instead.
 */

import { useEffect } from 'react';
import { NOTIFICATION_OPEN_ACK, notificationOpenPath } from '../lib/notification-open.ts';

/** Where the worker's messages arrive: `navigator.serviceWorker` in a browser. */
export interface NotificationOpenSource {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export function useNotificationOpen(
  source: NotificationOpenSource | null,
  origin: string,
  navigate: (to: string) => void,
): void {
  useEffect(() => {
    if (source === null) return;
    const onMessage = (event: MessageEvent): void => {
      const path = notificationOpenPath(event.data, origin);
      if (path === null) return;
      navigate(path);
      event.ports[0]?.postMessage(NOTIFICATION_OPEN_ACK);
    };
    source.addEventListener('message', onMessage);
    return () => source.removeEventListener('message', onMessage);
  }, [navigate, origin, source]);
}
