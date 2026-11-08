import type { ScreenRef } from '../layout/engine.ts';
import { daemonHomeHref, HOME_HREF, type RouteTable } from './routes.ts';

/**
 * THE SCREENS A PUSH MAY NAME, declared once for the worker (which holds no plugin manifests). Each is the same path a
 * plugin's manifest declares for its screen, and a unit test beside each manifest pins that they agree
 * (`conversation` `chat`, `agenda` `agenda`): a rename there fails there, not on a phone.
 */
export const PUSH_TAP_SCREENS: readonly ScreenRef[] = [
  { plugin: 'conversation', id: 'chat', path: 'ferrets/:ferret/chat', label: 'Chat' },
  { plugin: 'agenda', id: 'agenda', path: 'agenda', label: 'Agenda' },
];

/**
 * WHERE A TAP LANDS WHEN A PAGE (not the worker) opens it, decided by the app's own route table. The worker has already
 * limited a tap to one machine's accepted pages (`notificationUrl`); this is the page's own check against the full
 * table of screens, so it can never disagree with what the shell then renders. A push names its page (an ask's push is
 * the ferret's chat AT the ask: `/d/<daemon>/ferrets/<ferret>/chat?ask=A3`), so a tap needs no rewriting.
 *
 * TOTAL, and CLOSED: it never throws, and never opens an address off this origin, whatever it is given.
 *
 * - an address on this origin that the router draws under a PAIRED machine → that address, query and fragment kept
 *   (`?ask=` is how the chat knows which ask to focus);
 * - an address the router does not know, under a paired machine (`/d/<daemon>/…`) → that machine's home;
 * - anything else — a foreign origin, a string that is no address, the landing page `/`, a daemon-less screen such as
 *   `/join#…`, a machine this browser has not paired, an unknown page outside a machine → the app's home.
 */
export const notificationTapTarget = (
  allowed: string,
  origin: string,
  routes: Pick<RouteTable, 'parse'>,
  isPaired: (daemon: string) => boolean,
): string => {
  const home = new URL(HOME_HREF, origin).href;
  const url = URL.parse(allowed, origin);
  if (url === null || url.origin !== origin) return home;
  try {
    const route = routes.parse(url.pathname);
    if (route.kind === 'home') return home;
    if (route.kind === 'device-settings') return url.href;
    if (route.kind === 'not-found') {
      const daemon = daemonOf(url.pathname, routes);
      return daemon !== undefined && isPaired(daemon) ? new URL(daemonHomeHref(daemon), origin).href : home;
    }
    return route.daemon !== undefined && isPaired(route.daemon) ? url.href : home;
  } catch {
    return home;
  }
};

/** The machine an unknown `/d/<daemon>/…` address sits under, as the router reads its first two segments. */
const daemonOf = (pathname: string, routes: Pick<RouteTable, 'parse'>): string | undefined => {
  const parts = pathname.split('/').filter(part => part.length > 0);
  if (parts[0] === 'app') parts.shift();
  const machine = parts[0] === 'd' && parts[1] !== undefined ? routes.parse(`/d/${parts[1]}`) : undefined;
  return machine?.kind === 'daemon-home' ? machine.daemon : undefined;
};
