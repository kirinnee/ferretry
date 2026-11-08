/**
 * The browser entry for `tests/integration/notification-open.test.ts`: the app's notification-open
 * wiring and nothing else, served as `/app/index.html` of a signed release so the REAL built worker
 * answers every page load, exactly as it does for the app.
 *
 * It is wired the way `main.tsx` and `AppShell` wire it: the entry point attaches the inbox to
 * `navigator.serviceWorker` before anything mounts, the app's real `RouterProvider` mounts once its
 * "store" has loaded, and `useNotificationOpen` routes through the router's own `navigate`. What the
 * page shows is the route the app would render — parsed by the shell's real route table, given Conversation's
 * `chat` screen (`ferrets/:ferret/chat`), with the ask the real `agendaTargetFromSearch` reads from `?ask=` — so the
 * suite asserts what a reader would land on: the ferret's chat, on its daemon, AT the ask.
 *
 * Two switches, read from `localStorage` so that no URL the worker opens carries them:
 *
 *   `scene-hold`     `1` keeps the "store" loading, so the router does not mount, until the page calls
 *                    `__mountScene()` (default: it mounts at once);
 *   `scene-app`      `none` makes this a page with no notification wiring at all — an app too old to
 *                    know the message, or a page that is not the app.
 */

import { useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { NotificationOpenContext, useNotificationOpen } from '../../../../app/hooks/use-notification-open.ts';
import { useAskFocus } from '../../../../app/features/agenda/use-ask-focus.ts';
import { attachNotificationOpens, NotificationOpenInbox } from '../../../../app/lib/notification-open.ts';
import type { ScreenRef } from '@ferretry/app';
import { RouterProvider } from '@ferretry/app/testing/router';
import { useRouter } from '../../../../app/shell.ts';

const setting = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Conversation's chat screen, as its manifest declares it: the page an ask's push opens. */
const SCREENS: readonly ScreenRef[] = [
  { plugin: 'conversation', id: 'chat', path: 'ferrets/:ferret/chat', label: 'Chat' },
];

const wired = setting('scene-app') !== 'none';
const held = setting('scene-hold') === '1';

/** Every in-app navigation a notification asked for, in order. */
const opens: string[] = [];
(globalThis as unknown as { __notificationOpens: string[] }).__notificationOpens = opens;

// `main.tsx`: attached before React mounts.
const inbox = wired
  ? attachNotificationOpens(new NotificationOpenInbox(window.location.origin), navigator.serviceWorker)
  : null;

function Shown() {
  const { route, navigate, entryKey } = useRouter();
  // The ask the chat focuses on arrival: the Agenda's own reader of `?ask=`, which the real chat screen mounts.
  const focus = useAskFocus();
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
        attention: focus?.target ?? null,
        entry: entryKey,
      })}
    />
  );
}

const host = document.getElementById('root');
if (host === null) throw new Error('missing #root');
const mount = (): void => {
  createRoot(host).render(
    <NotificationOpenContext.Provider value={inbox}>
      <RouterProvider screens={SCREENS}>
        <Shown />
      </RouterProvider>
    </NotificationOpenContext.Provider>,
  );
};
(globalThis as unknown as { __mountScene: () => void }).__mountScene = mount;
if (!held) setTimeout(mount, 0);
