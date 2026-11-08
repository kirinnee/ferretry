/**
 * THE WORKER'S OWN PUSH AND NOTIFICATION RULES, copied from today's PWA (`lib/push-scope.ts`, `lib/notification-open.ts`,
 * `lib/notify.ts`): the parts the service worker itself runs. Pure — the worker binds the browser objects — so it is
 * tested without a worker.
 *
 * ONE PUSH WORKER PER MACHINE. A browser holds one push subscription per service-worker registration, bound to the
 * VAPID key of the daemon that made it. So each machine gets its own registration of the SAME signed worker file at
 * `/push/<daemonId>/`, and the worker learns which machine it serves from its own registration scope — which this
 * browser chose, never a push. It then titles every notification with the reader's own label for that machine (carried
 * in the worker script's query), and a tap opens only that machine's own pages (`/d/<daemonId>`), whatever URL a
 * notification named. A push that reaches the app-wide registration (`/`) is titled "Unverified" and opens only the app.
 *
 * NO PLUGIN CODE RUNS IN THIS WORKER. Every byte here is the shell's own and part of the signed release. A plugin that
 * needs worker behaviour (Agenda's notification kinds, a `clear` push, this device's notification filter) asks for it as
 * declarative data the worker interprets — later, in that plugin's contract. Until a push payload is in a contract, every
 * push is shown the way today's worker shows a payload it cannot read: plainly, so a subscription that received a push
 * is never left showing nothing (the browser penalises that and eventually revokes it).
 */

import { daemonHomeHref, HOME_HREF } from '../router/routes.ts';
import { NOTIFICATION_OPEN_ACK, NOTIFICATION_OPEN_MESSAGE, PUSH_LABEL_PARAMETER, PUSH_SCOPE_ROOT } from './facts.ts';

export { NOTIFICATION_OPEN_ACK, NOTIFICATION_OPEN_MESSAGE, PUSH_SCOPE_ROOT } from './facts.ts';

/**
 * The Ferretry mark every notification carries, from the app's own committed icons. Same-origin paths, so a push never
 * names an image service. Platforms without one of them (iOS has no badge) simply ignore it.
 */
export const NOTIFICATION_ICON = '/icons/icon-any-192.png';
export const NOTIFICATION_BADGE = '/icons/badge-96.png';

/** The mark, as notification options. */
export const notificationBrand = (): { readonly icon: string; readonly badge: string } => ({
  icon: NOTIFICATION_ICON,
  badge: NOTIFICATION_BADGE,
});

/** The machine one push registration serves, as this browser registered it. */
export interface PushMachine {
  readonly daemonId: string;
  /** The reader's label for it; the daemon id when the script named none. */
  readonly label: string;
}

/**
 * Which machine a registration serves, from its scope URL and its script URL — or `null` for the app's own
 * registration (scope `/`) and anything else that is not a per-machine push scope.
 */
export const pushMachineOf = (scope: string, scriptUrl: string): PushMachine | null => {
  const path = URL.parse(scope)?.pathname ?? '';
  if (!path.startsWith(PUSH_SCOPE_ROOT)) return null;
  const segment = path.slice(PUSH_SCOPE_ROOT.length).replace(/\/$/u, '');
  if (segment === '' || segment.includes('/')) return null;
  let daemonId: string;
  try {
    daemonId = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const label = URL.parse(scriptUrl)?.searchParams.get(PUSH_LABEL_PARAMETER)?.trim() ?? '';
  return { daemonId, label: label === '' ? daemonId : label };
};

/** What a push that reached the app-wide registration says it is: from no machine this browser can name. */
const UNVERIFIED = 'Unverified';

/** What a push nobody composed is shown as, so a subscription is never punished for a silent push. */
export const unreadablePushTitle = (machine: PushMachine | null): string =>
  machine === null ? `${UNVERIFIED} · Ferretry` : `${machine.label} · Ferretry`;

/** The body of that notification. */
export const UNREADABLE_PUSH_BODY = 'Something is waiting in your Agenda.';

const withinMachine = (pathname: string, machine: PushMachine): boolean => {
  const root = daemonHomeHref(machine.daemonId);
  return pathname === root || pathname.startsWith(`${root}/`);
};

/**
 * Where a notification tap may go: only this site, and — for a machine's own worker — only that machine's pages.
 * Anything else opens that machine's home, or — when the notification belongs to no machine — the app itself.
 */
export const notificationUrl = (raw: unknown, origin: string, machine: PushMachine | null): string => {
  const fallback = new URL(machine === null ? HOME_HREF : daemonHomeHref(machine.daemonId), origin);
  const target = typeof raw === 'string' ? URL.parse(raw, origin) : null;
  if (target === null || target.origin !== origin) return fallback.href;
  if (machine !== null && !withinMachine(target.pathname, machine)) return fallback.href;
  return target.href;
};

// ─── a tap opens its page inside the running app, not by reloading it ─────────────────────────────────────────────

/** How long the worker waits for the page to say it took the open before it navigates the window instead. */
export const NOTIFICATION_OPEN_ACK_MS = 1_000;

interface NotificationOpenMessage {
  readonly type: typeof NOTIFICATION_OPEN_MESSAGE;
  readonly url: string;
}

/** The open window, as the worker sees it. */
export interface NotificationWindow {
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/** What the worker needs to wait for a reply; the real channel and timers unless a suite fixes them. */
export interface NotificationOpenEnvironment {
  readonly channel: () => Pick<MessageChannel, 'port1' | 'port2'>;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const browserOpenEnvironment: NotificationOpenEnvironment = {
  channel: () => new MessageChannel(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/**
 * Brings the window forward — first, while the tap still counts as the reader's own gesture — then asks its page to
 * route to `url`. When no page says it took it, navigates the window; when that is refused too (this worker does not
 * control the window: a machine's push worker controls no page), opens `url` in a window of its own.
 */
export const openInWindow = async (
  window: NotificationWindow,
  url: string,
  openWindow: (url: string) => Promise<unknown>,
  environment: NotificationOpenEnvironment = browserOpenEnvironment,
): Promise<'routed' | 'navigated' | 'opened'> => {
  await window.focus().catch(() => undefined);
  const routed = await new Promise<boolean>(resolve => {
    const channel = environment.channel();
    const settle = (answer: boolean): void => {
      environment.clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(answer);
    };
    const timer = environment.setTimeout(() => settle(false), NOTIFICATION_OPEN_ACK_MS);
    channel.port1.onmessage = event => {
      if (event.data === NOTIFICATION_OPEN_ACK) settle(true);
    };
    try {
      const message: NotificationOpenMessage = { type: NOTIFICATION_OPEN_MESSAGE, url };
      window.postMessage(message, [channel.port2]);
    } catch {
      settle(false);
    }
  });
  if (routed) return 'routed';
  try {
    await window.navigate(url);
    return 'navigated';
  } catch {
    await openWindow(url);
    return 'opened';
  }
};

/** Pages on this site that are not the app: a popup a sign-in opened, a push worker's own scope. */
const NOT_THE_APP = ['/oauth/', '/push/'];

/** The app's own pages, as `public/_redirects` serves them; everything else is the landing page or the setup guide. */
const isAppPage = (pathname: string): boolean =>
  pathname === '/app' ||
  pathname.startsWith('/app/') ||
  pathname.startsWith('/d/') ||
  pathname === '/setup' ||
  // `/join` is left out on purpose: a notification tap must not route a tab away mid-join and drop the code.
  pathname === '/shared' ||
  pathname === '/pair' ||
  pathname.startsWith('/pair/');

/** The slice of a `WindowClient` the choice reads; `focused` and `visibilityState` are optional for tests. */
export interface NotificationWindowCandidate {
  readonly url: string;
  readonly focused?: boolean;
  readonly visibilityState?: string;
}

/**
 * Which open window a tap should reuse, or `undefined` to open a new one. Only this site's windows, never a sign-in
 * popup or a push scope; an APP window wins over the landing page, and among those the focused, then the visible one.
 * Ties keep the browser's own order (most recently focused first).
 */
export const notificationWindow = <T extends NotificationWindowCandidate>(
  windows: readonly T[],
  origin: string,
): T | undefined => {
  const score = (candidate: T): number => {
    const url = URL.parse(candidate.url);
    if (url === null || url.origin !== origin || NOT_THE_APP.some(prefix => url.pathname.startsWith(prefix))) return -1;
    return (
      (isAppPage(url.pathname) ? 4 : 0) +
      (candidate.focused === true ? 2 : 0) +
      (candidate.visibilityState === 'visible' ? 1 : 0)
    );
  };
  let best: T | undefined;
  let bestScore = -1;
  for (const candidate of windows) {
    const value = score(candidate);
    if (value > bestScore) {
      best = candidate;
      bestScore = value;
    }
  }
  return best;
};
