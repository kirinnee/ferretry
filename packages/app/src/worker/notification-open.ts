/**
 * A NOTIFICATION TAP OPENS ITS PAGE INSIDE THE RUNNING APP, not by reloading it — the page's half (moved here from
 * Agenda's app half, S6: the shell owns the tap, Agenda owns nothing of it).
 *
 * The service worker used to answer a tap with `WindowClient.navigate(url)`: a cross-document load that rebooted the whole
 * app — pairings, stores, every live connection — and left Back crossing a document boundary too. Now it asks the open
 * window to route there itself, and only navigates the window when no page answers (a copy of the app too old to know this
 * message, or a page that is not the app at all).
 *
 * One message, one reply: the worker posts `{ type, url, tag? }` with a port (`openInWindow`, `notifications.ts`), and a
 * page that took it replies {@link NOTIFICATION_OPEN_ACK} on that port. The page replies as soon as it has TAKEN the open,
 * not once it has routed: the app's router mounts only after its store has loaded, and a tap that lands while the app is
 * still starting is held by {@link NotificationOpenInbox} until it can be routed, rather than lost (see `main.tsx`).
 *
 * NOTHING HERE IS TRUSTED. A message can come from any page script on this origin, so the url is reduced to a path on THIS
 * origin and the tag to the kernel's tag grammar; WHETHER the page is one the shell may open under a paired machine is the
 * shell's one route parse (`notificationTapTarget`), run by the caller.
 */

import { PUSH_TAG_PATTERN } from '@ferretry/kernel/contract/push-envelope';
import { NOTIFICATION_OPEN_ACK, NOTIFICATION_OPEN_MESSAGE } from './facts.ts';

export { NOTIFICATION_OPEN_ACK, NOTIFICATION_OPEN_MESSAGE } from './facts.ts';

/** What the worker posts to a window on a tap. */
export interface NotificationOpenMessage {
  readonly type: typeof NOTIFICATION_OPEN_MESSAGE;
  readonly url: string;
  /** The daemon's own tag of the line tapped (un-namespaced), when it had one. */
  readonly tag?: string;
}

export const notificationOpenMessage = (url: string, tag?: string): NotificationOpenMessage => ({
  type: NOTIFICATION_OPEN_MESSAGE,
  url,
  ...(tag === undefined ? {} : { tag }),
});

/** One open the worker asked for: an in-app path on this origin, and the tag of the line tapped. */
export interface NotificationOpen {
  readonly path: string;
  readonly tag?: string;
}

/**
 * The open a message asks for, or `null` for anything else — another message, a malformed one, or a URL on another origin,
 * which this page has no business opening. A tag outside the kernel's grammar is dropped (the open still stands).
 */
export const notificationOpenOf = (data: unknown, origin: string): NotificationOpen | null => {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Partial<NotificationOpenMessage>;
  if (message.type !== NOTIFICATION_OPEN_MESSAGE || typeof message.url !== 'string') return null;
  const url = URL.parse(message.url, origin);
  if (url === null || url.origin !== origin) return null;
  const tag = typeof message.tag === 'string' && PUSH_TAG_PATTERN.test(message.tag) ? message.tag : undefined;
  return { path: `${url.pathname}${url.search}${url.hash}`, ...(tag === undefined ? {} : { tag }) };
};

/** Where the worker's messages arrive: `navigator.serviceWorker` in a browser. */
export interface NotificationOpenSource {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/**
 * The page's half: every open the worker asked for, acknowledged the moment it arrives and held until the app's router
 * takes it.
 *
 * Created by the entry point BEFORE the app mounts (`main.tsx`), for the same reason the install offer is: the app's router
 * mounts only once its store has loaded, and a tap that reaches a window still starting — one the tap had just woken, or
 * opened — would otherwise find nobody listening, so the worker heard no reply and the reader was left on whatever the app
 * showed before. Only the latest unrouted open is kept: two taps before the app is up mean the reader wants the second.
 */
export class NotificationOpenInbox {
  readonly #origin: string;
  #pending: NotificationOpen | null = null;
  #route: ((open: NotificationOpen) => void) | null = null;

  constructor(origin: string) {
    this.#origin = origin;
  }

  /** The origin whose pages this inbox opens: the page's own. */
  get origin(): string {
    return this.#origin;
  }

  /** One message from a worker: an open is acknowledged and routed — or held — and anything else ignored. */
  readonly receive = (event: Pick<MessageEvent, 'data' | 'ports'>): void => {
    const open = notificationOpenOf(event.data, this.#origin);
    if (open === null) return;
    event.ports[0]?.postMessage(NOTIFICATION_OPEN_ACK);
    if (this.#route === null) this.#pending = open;
    else this.#route(open);
  };

  /**
   * Routes every open through `route` — the one held before anything subscribed first — until the answer is called. The
   * latest subscriber is the one that routes.
   */
  readonly subscribe = (route: (open: NotificationOpen) => void): (() => void) => {
    this.#route = route;
    const held = this.#pending;
    this.#pending = null;
    if (held !== null) route(held);
    return () => {
      if (this.#route === route) this.#route = null;
    };
  };
}

/**
 * The page's inbox, made from the browser: this origin's, listening on `navigator.serviceWorker` where the browser has one.
 * The entry point calls it once, before React mounts.
 */
export const browserNotificationOpens = (
  page: { readonly location: { readonly origin: string } },
  browser: { readonly serviceWorker?: NotificationOpenSource },
): NotificationOpenInbox =>
  attachNotificationOpens(new NotificationOpenInbox(page.location.origin), browser.serviceWorker ?? null);

/** Listens on `source` (the page's `navigator.serviceWorker`) when there is one. */
export const attachNotificationOpens = (
  inbox: NotificationOpenInbox,
  source: NotificationOpenSource | null,
): NotificationOpenInbox => {
  source?.addEventListener('message', inbox.receive);
  return inbox;
};
