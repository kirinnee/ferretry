/**
 * A NOTIFICATION TAP OPENS ITS PAGE INSIDE THE RUNNING APP, not by reloading it.
 *
 * The service worker used to answer a tap with `WindowClient.navigate(url)`: a cross-document load
 * that rebooted the whole app — pairings, stores, every live connection — and left Back crossing a
 * document boundary too. Now it asks the open window to route there itself, and only navigates the
 * window when no page answers (a copy of the app too old to know this message, or a page that is not
 * the app at all).
 *
 * One message, one reply: the worker posts {@link NotificationOpenMessage} with a port, and a page
 * that took it replies {@link NOTIFICATION_OPEN_ACK} on that port. The page replies as soon as it has
 * TAKEN the open, not once it has routed: the app's router mounts only after its store has loaded, and
 * a tap that lands while the app is still starting is held by {@link NotificationOpenInbox} until it
 * can be routed, rather than lost (see `main.tsx`).
 *
 * WHY THE WINDOW IS NOT SIMPLY NAVIGATED WHEN THE PAGE IS SILENT. `WindowClient.navigate` succeeds only
 * for a worker that CONTROLS that window, and a machine's push worker (`/push/<daemonId>/`) controls no
 * page at all — so from the worker that shows almost every notification it always rejects. A silent
 * page therefore falls back to opening the page in a window of its own: a second window, but the right
 * conversation, where it used to leave the reader on whatever the app showed before the tap.
 */

export const NOTIFICATION_OPEN_MESSAGE = 'fy-notification-open';
export const NOTIFICATION_OPEN_ACK = 'fy-notification-opened';

/** How long the worker waits for the page to say it took the open before it navigates the window instead. */
export const NOTIFICATION_OPEN_ACK_MS = 1_000;

export interface NotificationOpenMessage {
  readonly type: typeof NOTIFICATION_OPEN_MESSAGE;
  readonly url: string;
}

export const notificationOpenMessage = (url: string): NotificationOpenMessage => ({
  type: NOTIFICATION_OPEN_MESSAGE,
  url,
});

/**
 * The in-app path a message asks for, or `null` for anything else — another message, a malformed one,
 * or a URL on another origin, which this page has no business opening.
 */
export const notificationOpenPath = (data: unknown, origin: string): string | null => {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Partial<NotificationOpenMessage>;
  if (message.type !== NOTIFICATION_OPEN_MESSAGE || typeof message.url !== 'string') return null;
  try {
    const url = new URL(message.url, origin);
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
};

/** Where the worker's messages arrive: `navigator.serviceWorker` in a browser. */
export interface NotificationOpenSource {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/**
 * The page's half: every open the worker asked for, acknowledged the moment it arrives and held until
 * the app's router takes it.
 *
 * Created by the entry point BEFORE the app mounts (`main.tsx`), for the same reason the install offer
 * is: the app's router mounts only once its store has loaded, and a tap that reaches a window still
 * starting — one the tap had just woken, or opened — would otherwise find nobody listening, so the
 * worker heard no reply and the reader was left on whatever the app showed before. Only the latest
 * unrouted open is kept: two taps before the app is up mean the reader wants the second.
 */
export class NotificationOpenInbox {
  readonly #origin: string;
  #pending: string | null = null;
  #route: ((path: string) => void) | null = null;

  constructor(origin: string) {
    this.#origin = origin;
  }

  /** One message from a worker: an open is acknowledged and routed — or held — and anything else ignored. */
  readonly receive = (event: Pick<MessageEvent, 'data' | 'ports'>): void => {
    const path = notificationOpenPath(event.data, this.#origin);
    if (path === null) return;
    event.ports[0]?.postMessage(NOTIFICATION_OPEN_ACK);
    if (this.#route === null) this.#pending = path;
    else this.#route(path);
  };

  /**
   * Routes every open through `route` — the one held before anything subscribed first — until the
   * answer is called. The latest subscriber is the one that routes.
   */
  readonly subscribe = (route: (path: string) => void): (() => void) => {
    this.#route = route;
    const held = this.#pending;
    this.#pending = null;
    if (held !== null) route(held);
    return () => {
      if (this.#route === route) this.#route = null;
    };
  };
}

/** The production inbox: this page's origin, listening on `navigator.serviceWorker` when there is one. */
export const attachNotificationOpens = (
  inbox: NotificationOpenInbox,
  source: NotificationOpenSource | null,
): NotificationOpenInbox => {
  source?.addEventListener('message', inbox.receive);
  return inbox;
};

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
 * Brings the window forward — first, while the tap still counts as the reader's own gesture — then
 * asks its page to route to `url`. When no page says it took it, navigates the window; when that is
 * refused too (this worker does not control the window), opens `url` in a window of its own.
 *
 * Bringing the window forward is best-effort: a browser that refuses it (the gesture has lapsed) still
 * gets the page routed, so the next time the reader looks at the app it shows what they tapped.
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
      window.postMessage(notificationOpenMessage(url), [channel.port2]);
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

/**
 * The app's own pages, as `public/_redirects` serves them: everything else on this site is the public
 * landing page or the setup guide, which have no router to take an open.
 */
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
 * Which open window a tap should reuse, or `undefined` to open a new one.
 *
 * The worker asks for EVERY window on this site, not only the ones it controls: a machine's push worker
 * is registered at `/push/<daemonId>/` and controls no page at all, so asking for its own clients found
 * none and every tap opened a second copy of an app that was already open. A sign-in popup is never
 * reused — routing the app inside it would strand the sign-in.
 *
 * With several windows, an APP window wins over the landing page (it is the one with a router), and
 * among those the one the reader is looking at — focused, then visible — over one in the background.
 * Ties keep the browser's own order, which `Clients.matchAll` gives most recently focused first.
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
