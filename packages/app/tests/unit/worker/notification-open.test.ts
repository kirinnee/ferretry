import { describe, expect, test } from 'bun:test';
import {
  attachNotificationOpens,
  browserNotificationOpens,
  NOTIFICATION_OPEN_ACK,
  NOTIFICATION_OPEN_MESSAGE,
  type NotificationOpen,
  NotificationOpenInbox,
  notificationOpenMessage,
  notificationOpenOf,
} from '../../../src/worker/notification-open.ts';

const ORIGIN = 'https://app.test';

describe('S6 notificationOpenMessage', () => {
  test('wraps the url in the one message type, with the tag only when there is one', () => {
    expect(notificationOpenMessage('/x')).toEqual({ type: NOTIFICATION_OPEN_MESSAGE, url: '/x' });
    expect(notificationOpenMessage('/x', 'agenda-A3')).toEqual({
      type: NOTIFICATION_OPEN_MESSAGE,
      url: '/x',
      tag: 'agenda-A3',
    });
  });
});

describe('S6 notificationOpenOf (a message from any script on this origin is not trusted)', () => {
  const message = (over: Record<string, unknown> = {}) => ({ type: NOTIFICATION_OPEN_MESSAGE, url: '/d/a', ...over });

  test('reduces the url to a path on this origin and keeps a well-formed tag', () => {
    expect(notificationOpenOf(message({ url: `${ORIGIN}/d/a/x?ask=A3#h`, tag: 'agenda-A3' }), ORIGIN)).toEqual({
      path: '/d/a/x?ask=A3#h',
      tag: 'agenda-A3',
    });
    expect(notificationOpenOf(message(), ORIGIN)).toEqual({ path: '/d/a' });
  });

  test('drops a tag outside the kernel’s grammar but still opens the page', () => {
    for (const tag of ['', 'a b', '../x', '<img>', 'x'.repeat(500), 7, null, {}]) {
      expect(notificationOpenOf(message({ tag }), ORIGIN)).toEqual({ path: '/d/a' });
    }
  });

  test('refuses anything that is not an open: another message, a malformed one, or a url on another origin', () => {
    for (const data of [
      null,
      undefined,
      'text',
      7,
      {},
      { type: 'something-else', url: '/d/a' },
      { type: NOTIFICATION_OPEN_MESSAGE },
      { type: NOTIFICATION_OPEN_MESSAGE, url: 7 },
      message({ url: 'https://evil.test/d/a' }),
      message({ url: '//evil.test/d/a' }),
      message({ url: 'http://[bad' }),
    ]) {
      expect(notificationOpenOf(data, ORIGIN)).toBeNull();
    }
  });
});

const port = () => {
  const sent: unknown[] = [];
  return { sent, port: { postMessage: (value: unknown) => void sent.push(value) } as unknown as MessagePort };
};

describe('S6 NotificationOpenInbox', () => {
  test('acknowledges an open the moment it arrives, and holds it until the app routes', () => {
    const inbox = new NotificationOpenInbox(ORIGIN);
    const reply = port();
    inbox.receive({ data: notificationOpenMessage('/d/a', 'agenda-A3'), ports: [reply.port] });
    expect(reply.sent).toEqual([NOTIFICATION_OPEN_ACK]);
    const routed: NotificationOpen[] = [];
    inbox.subscribe(open => void routed.push(open));
    expect(routed).toEqual([{ path: '/d/a', tag: 'agenda-A3' }]);
    // held once only
    inbox.subscribe(open => void routed.push(open));
    expect(routed).toHaveLength(1);
  });

  test('keeps only the latest unrouted open: two taps before the app is up mean the second', () => {
    const inbox = new NotificationOpenInbox(ORIGIN);
    inbox.receive({ data: notificationOpenMessage('/d/a'), ports: [] });
    inbox.receive({ data: notificationOpenMessage('/d/b'), ports: [] });
    const routed: NotificationOpen[] = [];
    inbox.subscribe(open => void routed.push(open));
    expect(routed).toEqual([{ path: '/d/b' }]);
  });

  test('routes a live open straight through; the latest subscriber routes; unsubscribing a replaced one changes nothing', () => {
    const inbox = new NotificationOpenInbox(ORIGIN);
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = inbox.subscribe(open => void first.push(open.path));
    inbox.subscribe(open => void second.push(open.path));
    stopFirst();
    inbox.receive({ data: notificationOpenMessage('/d/a'), ports: [] });
    expect(first).toEqual([]);
    expect(second).toEqual(['/d/a']);
  });

  test('after the subscriber leaves, an open is held again', () => {
    const inbox = new NotificationOpenInbox(ORIGIN);
    const seen: string[] = [];
    const stop = inbox.subscribe(open => void seen.push(open.path));
    stop();
    inbox.receive({ data: notificationOpenMessage('/d/a'), ports: [] });
    expect(seen).toEqual([]);
    inbox.subscribe(open => void seen.push(open.path));
    expect(seen).toEqual(['/d/a']);
  });

  test('ignores, without replying, what is not an open (a page on this origin can post anything)', () => {
    const inbox = new NotificationOpenInbox(ORIGIN);
    const reply = port();
    const seen: string[] = [];
    inbox.subscribe(open => void seen.push(open.path));
    inbox.receive({ data: { type: 'other' }, ports: [reply.port] });
    inbox.receive({ data: notificationOpenMessage('https://evil.test/x'), ports: [reply.port] });
    expect(reply.sent).toEqual([]);
    expect(seen).toEqual([]);
  });

  test('knows its origin', () => {
    expect(new NotificationOpenInbox(ORIGIN).origin).toBe(ORIGIN);
  });
});

describe('S6 the inbox, made from the browser', () => {
  test('listens for the worker’s messages on navigator.serviceWorker, for this page’s own origin', () => {
    const listeners: ((event: never) => void)[] = [];
    const inbox = browserNotificationOpens(
      { location: { origin: ORIGIN } },
      { serviceWorker: { addEventListener: (_type, listener) => void listeners.push(listener as never) } },
    );
    expect(inbox.origin).toBe(ORIGIN);
    expect(listeners).toHaveLength(1);
    const routed: string[] = [];
    inbox.subscribe(open => void routed.push(open.path));
    (listeners[0] as (event: unknown) => void)({ data: notificationOpenMessage('/d/a'), ports: [] });
    expect(routed).toEqual(['/d/a']);
  });

  test('a browser with no service worker still has an inbox', () => {
    const inbox = new NotificationOpenInbox(ORIGIN);
    expect(attachNotificationOpens(inbox, null)).toBe(inbox);
    expect(browserNotificationOpens({ location: { origin: ORIGIN } }, {}).origin).toBe(ORIGIN);
  });
});
