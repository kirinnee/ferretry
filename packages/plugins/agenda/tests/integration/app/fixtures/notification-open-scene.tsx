/**
 * The browser entry for `tests/integration/notification-open.test.ts`: the app's notification-open
 * wiring and nothing else, served as `/app/index.html` of a signed release so the REAL built worker
 * answers every page load, exactly as it does for the app.
 *
 * It is wired the way `main.tsx` and `AppShell` wire it: the entry point attaches the inbox to
 * `navigator.serviceWorker` before anything mounts, the app's real `RouterProvider` mounts once its
 * "store" has loaded, and `useNotificationOpen` routes through the router's own `navigate`. What the
 * page shows is the route the app would render — parsed by the shell's real route table, given Conversation's
 * `chat` screen (`ferrets/:ferret/chat`) — and, beside it, the REAL `ferret-agenda` panel the chat mounts (built by the
 * half over a scripted daemon client), so the suite asserts what a reader would land on: the ferret's chat, on its
 * daemon, with the ask's row rung IN THE PANEL (`[data-agenda-focused]`), not a re-read of the address.
 *
 * Two switches, read from `localStorage` so that no URL the worker opens carries them:
 *
 *   `scene-hold`     `1` keeps the "store" loading, so the router does not mount, until the page calls
 *                    `__mountScene()` (default: it mounts at once);
 *   `scene-app`      `none` makes this a page with no notification wiring at all — an app too old to
 *                    know the message, or a page that is not the app.
 */

import { Suspense, createElement, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { NotificationOpenContext, useNotificationOpen } from '../../../../app/hooks/use-notification-open.ts';
import app from '../../../../app/index.ts';
import manifest from '../../../../manifest.ts';
import { projectionSnapshot } from '../../../support/app/agenda-projection.ts';
import { attachNotificationOpens, NotificationOpenInbox } from '../../../../app/lib/notification-open.ts';
import { type PanelProps, type PluginClient } from '@ferretry/kernel/manifest';
import { PUSH_TAP_SCREENS, routeTable, type ScreenRef } from '@ferretry/app';
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

/** The machines this browser has paired: a tap that names any other opens the app. */
const PAIRED = new Set(['alpha', 'beta']);
const TAP = { routes: routeTable(PUSH_TAP_SCREENS), isPaired: (daemon: string) => PAIRED.has(daemon) };

/** A daemon that answers the panel's reads for whichever ferret it is asked about: four open asks, A1 to A4. */
const daemon = {
  call: async (route: string, init?: { readonly params?: Readonly<Record<string, string>> }) => {
    if (route === 'GET /v1/ferrets/:ferretId/agenda') {
      return { ...projectionSnapshot(4, 0), sessionId: init?.params?.ferretId ?? '' };
    }
    if (route === 'GET /v1/ferrets') return [];
    throw new Error(`no route ${route}`);
  },
  subscribe: () => () => undefined,
} as unknown as PluginClient;
const half = app.build?.({ manifest, client: daemon });
const FerretAgendaPanel = half?.panels['ferret-agenda'] as never;

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
  // `AppShell`: the router's own navigate, as the app passes it.
  const open = useCallback(
    (to: string): void => {
      opens.push(to);
      navigate(to);
    },
    [navigate],
  );
  useNotificationOpen(wired ? navigator.serviceWorker : null, window.location.origin, open, TAP);
  const ferret = route.kind === 'screen' && route.screen.id === 'chat' ? route.params['ferret'] : undefined;
  return (
    <>
      <output
        id="route"
        data-route={JSON.stringify({
          ...route,
          path: `${window.location.pathname}${window.location.search}`,
          entry: entryKey,
        })}
      />
      {ferret === undefined ? null : (
        // The chat's side panel for this ferret, keyed by the navigation so a second tap is a new request.
        <Suspense fallback={null} key={entryKey}>
          {createElement(FerretAgendaPanel, { subject: ferret } satisfies PanelProps)}
        </Suspense>
      )}
    </>
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
