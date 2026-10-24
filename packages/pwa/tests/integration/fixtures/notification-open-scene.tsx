/**
 * The browser entry for `tests/integration/notification-open.test.ts`: the app's notification-open
 * wiring and nothing else, served as `/app/index.html` of a signed release so the REAL built worker
 * answers every page load, exactly as it does for the app.
 *
 * It is wired the way `main.tsx` and `AppShell` wire it: the entry point attaches the inbox to
 * `navigator.serviceWorker` before anything mounts, the app's real `RouterProvider` mounts once its
 * "store" has loaded, and `useNotificationOpen` routes through the router's own `navigate`. What the
 * page shows is the route the app would render — parsed by the real `parseRoute`, with the Attention
 * item the real `attentionTargetFromSearch` reads — so the suite asserts what a reader would land on.
 *
 * Two switches, read from `localStorage` so that no URL the worker opens carries them:
 *
 *   `scene-boot-ms`  how long the "store" takes to load before the router mounts (default 0);
 *   `scene-app`      `none` makes this a page with no notification wiring at all — an app too old to
 *                    know the message, or a page that is not the app.
 */

import { useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { NotificationOpenContext, useNotificationOpen } from '../../../src/hooks/use-notification-open.ts';
import { attentionTargetFromSearch } from '../../../src/lib/attention-inbox.ts';
import { attachNotificationOpens, NotificationOpenInbox } from '../../../src/lib/notification-open.ts';
import { RouterProvider, useRouter } from '../../../src/lib/router.tsx';

const setting = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const wired = setting('scene-app') !== 'none';
const bootMs = Number(setting('scene-boot-ms') ?? '0');

/** Every in-app navigation a notification asked for, in order. */
const opens: string[] = [];
(globalThis as unknown as { __notificationOpens: string[] }).__notificationOpens = opens;

// `main.tsx`: attached before React mounts.
const inbox = wired
  ? attachNotificationOpens(new NotificationOpenInbox(window.location.origin), navigator.serviceWorker)
  : null;

function Shown() {
  const { route, navigate, entryKey } = useRouter();
  // `AppShell`: the router's own navigate, as the app passes it.
  const open = useCallback(
    (to: string): void => {
      opens.push(to);
      navigate(to);
    },
    [navigate],
  );
  useNotificationOpen(wired ? navigator.serviceWorker : null, window.location.origin, open);
  return (
    <output
      id="route"
      data-route={JSON.stringify({
        ...route,
        path: `${window.location.pathname}${window.location.search}`,
        attention: attentionTargetFromSearch(window.location.search),
        entry: entryKey,
      })}
    />
  );
}

const host = document.getElementById('root');
if (host === null) throw new Error('missing #root');
setTimeout(() => {
  createRoot(host).render(
    <NotificationOpenContext.Provider value={inbox}>
      <RouterProvider>
        <Shown />
      </RouterProvider>
    </NotificationOpenContext.Provider>,
  );
}, bootMs);
