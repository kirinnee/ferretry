import { daemonHomeHref, HOME_HREF, type RouteTable } from './routes.ts';

/**
 * WHERE A NOTIFICATION TAP LANDS, decided by the app's own route table. A push names its page already (an ask's push is
 * the ferret's chat AT the ask: `/d/<daemon>/ferrets/<ferret>/chat?ask=A3`), so a tap needs no rewriting — only a
 * check that the page is one the app can draw. The check is the router's own `parse`, so it can never disagree with
 * what the shell then renders.
 *
 * TOTAL, and CLOSED: a tap never throws, and never opens an address off this origin, whatever the push said.
 *
 * - an address on this origin that the router draws → that address, query and fragment kept (`?ask=` is how the chat
 *   knows which ask to focus);
 * - an address the router does not know, under a machine (`/d/<daemon>/…`) → that machine's home;
 * - anything else — a foreign origin, a string that is no address, an unknown page outside a machine → the app's home.
 */
export const notificationTapTarget = (allowed: string, origin: string, routes: Pick<RouteTable, 'parse'>): string => {
  const home = new URL(HOME_HREF, origin).href;
  const url = URL.parse(allowed, origin);
  if (url === null || url.origin !== origin) return home;
  try {
    const route = routes.parse(url.pathname);
    if (route.kind !== 'not-found') return url.href;
    const parts = url.pathname.split('/').filter(part => part.length > 0);
    if (parts[0] === 'app') parts.shift();
    const machine = parts[0] === 'd' && parts[1] !== undefined ? routes.parse(`/d/${parts[1]}`) : undefined;
    return machine?.kind === 'daemon-home' ? new URL(daemonHomeHref(machine.daemon), origin).href : home;
  } catch {
    return home;
  }
};
