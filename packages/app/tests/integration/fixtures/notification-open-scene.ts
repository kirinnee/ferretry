/**
 * The page a notification tap reaches, in real Chromium: the app's OWN tap wiring and nothing beside it.
 *
 * What is real: the entry point's inbox (`browserNotificationOpens`, listening on `navigator.serviceWorker`, created before
 * anything mounts exactly as `main.tsx` does), the shell's route table over the screens a push may name, and the shell's
 * own tap decision (`openNotificationTap`). What is stood in: the router draws no screen (the page writes the address it was
 * routed to into `#route`) and the paired machines are the two named in `PAIRED`.
 *
 * Two switches, held in localStorage by the suite before the page loads:
 *   `scene-app`  = `none`  the page wires nothing, as an app too old to know the message;
 *   `scene-hold` = `1`     the inbox exists but the router is "not mounted" until `window.__mountScene()`.
 */
import { routeTable } from '../../../src/router/routes.ts';
import { PUSH_TAP_SCREENS } from '../../../src/router/tap-target.ts';
import { openNotificationTap } from '../../../src/shell/notification-taps.tsx';
import type { ShellRuntime } from '../../../src/shell/runtime.ts';
import { browserNotificationOpens } from '../../../src/worker/notification-open.ts';

const PAIRED = new Set(['alpha', 'beta']);
const routes = routeTable(PUSH_TAP_SCREENS);
const runtime = {
  daemons: { get: (daemon: string) => (PAIRED.has(daemon) ? {} : undefined) },
  notificationOpened: (daemon: string, tap: { url: string; tag?: string }) => void heard.push({ daemon, ...tap }),
} as unknown as ShellRuntime;
const heard: { daemon: string; url: string; tag?: string }[] = [];
(globalThis as unknown as { __heard: typeof heard }).__heard = heard;

const draw = (): void => {
  const path = `${location.pathname}${location.search}`;
  const daemon = /^\/d\/([^/]+)/u.exec(location.pathname)?.[1];
  const node = document.querySelector<HTMLElement>('#route');
  if (node !== null) node.dataset.route = JSON.stringify({ path, daemon: daemon ?? null });
};

const navigate = (to: string): void => {
  history.pushState(null, '', to);
  draw();
};

const wired = localStorage.getItem('scene-app') !== 'none';
const held = localStorage.getItem('scene-hold') === '1';

if (wired) {
  // The inbox is made BEFORE the router is: a tap that lands while the app starts is held, never lost.
  const inbox = browserNotificationOpens(window, navigator);
  const subscribe = (): void => {
    inbox.subscribe(open => openNotificationTap(open, { origin: location.origin, runtime, routes, navigate }));
    draw();
  };
  (globalThis as unknown as { __mountScene: () => void }).__mountScene = subscribe;
  if (!held) subscribe();
}
