import { useEffect } from 'react';
import type { NotificationOpen, NotificationOpenInbox } from '../worker/notification-open.ts';
import type { RouteTable } from '../router/routes.ts';
import { useRouter } from '../router/router.tsx';
import { notificationTapTarget } from '../router/tap-target.ts';
import { useShell } from './context.tsx';
import type { ShellRuntime } from './runtime.ts';

/**
 * WHERE A NOTIFICATION TAP LANDS, decided by the shell's own route parse (S6). The worker has already limited a tap to one
 * machine's accepted pages; this is the page's own check against the full table of screens and the machines THIS BROWSER
 * has paired (the worker holds no pairings), so it can never disagree with what the shell then renders. TOTAL and CLOSED:
 * whatever page a push named, nothing off this origin and nothing under a machine this browser never paired opens; it
 * lands on the machine's home, or on the app's.
 *
 * `daemon` is the machine the tap landed under (a paired one), or `undefined` for the app's home or a device page; `url` is
 * the routed address (path, query and fragment) — NEVER the push body, which this page never sees.
 */
export function tapLanding(
  open: NotificationOpen,
  origin: string,
  routes: Pick<RouteTable, 'parse'>,
  isPaired: (daemon: string) => boolean,
): { readonly url: string; readonly daemon?: string } {
  const target = new URL(notificationTapTarget(open.path, origin, routes, isPaired), origin);
  const route = routes.parse(target.pathname);
  // The target above is already home unless the machine is paired, so a daemon here is always a paired one.
  const daemon = 'daemon' in route ? route.daemon : undefined;
  return { url: `${target.pathname}${target.search}${target.hash}`, ...(daemon === undefined ? {} : { daemon }) };
}

/**
 * Routes every tap the entry point's inbox holds or receives in the app, then tells the plugins of the machine it landed
 * under (`ShellProvides.notificationOpened`). The inbox is created BEFORE React mounts, so a tap that arrived while the
 * app was starting is routed the moment the router is up rather than lost.
 */
export function openNotificationTap(
  open: NotificationOpen,
  input: {
    readonly origin: string;
    readonly runtime: ShellRuntime;
    readonly routes: Pick<RouteTable, 'parse'>;
    readonly navigate: (to: string) => void;
  },
): void {
  const landing = tapLanding(
    open,
    input.origin,
    input.routes,
    daemon => input.runtime.daemons.get(daemon) !== undefined,
  );
  input.navigate(landing.url);
  if (landing.daemon !== undefined) {
    input.runtime.notificationOpened(landing.daemon, {
      url: landing.url,
      ...(open.tag === undefined ? {} : { tag: open.tag }),
    });
  }
}

/** Mounts the tap routing for the app's life; draws nothing. */
export function NotificationTaps({ inbox }: { readonly inbox: NotificationOpenInbox }) {
  const { runtime, routes } = useShell();
  const origin = inbox.origin;
  const { navigate } = useRouter();
  useEffect(
    () => inbox.subscribe(open => openNotificationTap(open, { origin, runtime, routes, navigate })),
    [inbox, origin, runtime, routes, navigate],
  );
  return null;
}
