/**
 * A NOTIFICATION TAP OPENS ITS PAGE INSIDE THE RUNNING APP, not by reloading it.
 *
 * The service worker used to answer a tap with `WindowClient.navigate(url)`: a cross-document load
 * that rebooted the whole app — pairings, stores, every live connection — and left Back crossing a
 * document boundary too. Now it asks the open window to route there itself, and only navigates the
 * window when no page answers (a copy of the app too old to know this message, or one still booting).
 *
 * One message, one reply: the worker posts {@link NotificationOpenMessage} with a port, and a page
 * that took it replies {@link NOTIFICATION_OPEN_ACK} on that port.
 */

export const NOTIFICATION_OPEN_MESSAGE = 'fy-notification-open';
export const NOTIFICATION_OPEN_ACK = 'fy-notification-opened';

/** How long the worker waits for the page to say it routed before it navigates the window instead. */
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
 * asks its page to route to `url`, and navigates the window only when no page says it did.
 */
export const openInWindow = async (
  window: NotificationWindow,
  url: string,
  environment: NotificationOpenEnvironment = browserOpenEnvironment,
): Promise<'routed' | 'navigated'> => {
  await window.focus();
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
  await window.navigate(url);
  return 'navigated';
};
