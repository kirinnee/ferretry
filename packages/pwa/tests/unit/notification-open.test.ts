import { describe, expect, it } from 'bun:test';
import {
  attachNotificationOpens,
  NOTIFICATION_OPEN_ACK,
  NOTIFICATION_OPEN_ACK_MS,
  NOTIFICATION_OPEN_MESSAGE,
  type NotificationOpenEnvironment,
  NotificationOpenInbox,
  type NotificationWindow,
  notificationOpenMessage,
  notificationOpenPath,
  notificationWindow,
  openInWindow,
} from '../../src/lib/notification-open.ts';

const ORIGIN = 'https://pwa.example.test';

describe('notificationOpenMessage', () => {
  it('wraps the url in the one message type', () => {
    // Arrange
    const subject = '/d/alpha/session/one';

    // Act
    const actual = notificationOpenMessage(subject);

    // Assert
    expect(actual).toEqual({ type: NOTIFICATION_OPEN_MESSAGE, url: subject });
  });
});

describe('notificationOpenPath', () => {
  it.each([
    { name: 'a string', input: 'nope' },
    { name: 'null', input: null },
    { name: 'a number', input: 7 },
    { name: 'another message type', input: { type: 'other', url: '/x' } },
    { name: 'a non-string url', input: { type: NOTIFICATION_OPEN_MESSAGE, url: 5 } },
    { name: 'a url on another origin', input: { type: NOTIFICATION_OPEN_MESSAGE, url: 'https://evil.test/x' } },
    { name: 'a url that cannot parse', input: { type: NOTIFICATION_OPEN_MESSAGE, url: 'http://[bad' } },
  ])('refuses $name', ({ input }) => {
    // Arrange
    const expected = null;

    // Act
    const actual = notificationOpenPath(input, ORIGIN);

    // Assert
    expect(actual).toBe(expected);
  });

  it.each([
    { name: 'a relative url', url: '/d/a/session/b', expected: '/d/a/session/b' },
    { name: 'search and hash', url: '/d/a?x=1#frag', expected: '/d/a?x=1#frag' },
    { name: 'an absolute same-origin url', url: `${ORIGIN}/p?q=2`, expected: '/p?q=2' },
  ])('opens $name', ({ url, expected }) => {
    // Arrange
    const input = { type: NOTIFICATION_OPEN_MESSAGE, url };

    // Act
    const actual = notificationOpenPath(input, ORIGIN);

    // Assert
    expect(actual).toBe(expected);
  });
});

interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  closed: number;
}

interface HarnessOptions {
  readonly postMessage?: (message: unknown, transfer: Transferable[]) => void;
  /** The window refuses to come forward (the tap's gesture has lapsed). */
  readonly focusRefused?: boolean;
  /** The window refuses a navigate: the worker does not control it, as a machine's push worker never does. */
  readonly navigateRefused?: boolean;
}

const harness = ({ postMessage, focusRefused = false, navigateRefused = false }: HarnessOptions = {}) => {
  const calls: string[] = [];
  const port1: FakePort = { onmessage: null, closed: 0 };
  const port2 = {};
  let timerCallback: (() => void) | undefined;
  const cleared: unknown[] = [];
  const delays: number[] = [];
  const environment: NotificationOpenEnvironment = {
    channel: () =>
      ({
        port1: Object.assign(port1, {
          close: () => {
            port1.closed += 1;
          },
        }),
        port2,
      }) as unknown as Pick<MessageChannel, 'port1' | 'port2'>,
    setTimeout: (callback, milliseconds) => {
      timerCallback = callback;
      delays.push(milliseconds);
      return 'timer-1';
    },
    clearTimeout: handle => {
      cleared.push(handle);
    },
  };
  const posted: { message: unknown; transfer: Transferable[] }[] = [];
  const window: NotificationWindow = {
    focus: async () => {
      calls.push('focus');
      if (focusRefused) throw new Error('Not allowed to focus a window.');
    },
    navigate: async (url: string) => {
      calls.push(`navigate:${url}`);
      if (navigateRefused) throw new TypeError("This service worker is not the client's active service worker.");
    },
    postMessage: (message, transfer) => {
      calls.push('post');
      if (postMessage !== undefined) postMessage(message, transfer);
      posted.push({ message, transfer });
    },
  };
  const openWindow = async (url: string): Promise<unknown> => {
    calls.push(`open:${url}`);
    return null;
  };
  return {
    calls,
    cleared,
    delays,
    environment,
    openWindow,
    port1,
    port2,
    posted,
    window,
    fire: () => timerCallback?.(),
  };
};

const tick = async (): Promise<void> => {
  await new Promise(resolve => queueMicrotask(() => resolve(undefined)));
  await new Promise(resolve => queueMicrotask(() => resolve(undefined)));
};

describe('openInWindow', () => {
  it('focuses first, then reports routed when the page acknowledges', async () => {
    // Arrange
    const subject = harness();

    // Act
    const pending = openInWindow(subject.window, '/x', subject.openWindow, subject.environment);
    await tick();
    subject.port1.onmessage?.({ data: NOTIFICATION_OPEN_ACK });
    const actual = await pending;

    // Assert
    expect(actual).toBe('routed');
    expect(subject.calls).toEqual(['focus', 'post']);
    expect(subject.posted[0]?.message).toEqual(notificationOpenMessage('/x'));
    expect(subject.posted[0]?.transfer).toEqual([subject.port2 as unknown as Transferable]);
    expect(subject.delays).toEqual([NOTIFICATION_OPEN_ACK_MS]);
    expect(subject.cleared).toEqual(['timer-1']);
    expect(subject.port1.closed).toBe(1);
    expect(subject.port1.onmessage).toBeNull();
  });

  it('ignores a message that is not the acknowledgement, then navigates on timeout', async () => {
    // Arrange
    const subject = harness();

    // Act
    const pending = openInWindow(subject.window, '/x', subject.openWindow, subject.environment);
    await tick();
    subject.port1.onmessage?.({ data: 'something else' });
    const earlyCalls = [...subject.calls];
    subject.fire();
    const actual = await pending;

    // Assert
    expect(earlyCalls).toEqual(['focus', 'post']);
    expect(actual).toBe('navigated');
    expect(subject.calls).toEqual(['focus', 'post', 'navigate:/x']);
    expect(subject.port1.closed).toBe(1);
  });

  it('navigates when posting to the window throws', async () => {
    // Arrange
    const subject = harness({
      postMessage: () => {
        throw new Error('detached');
      },
    });

    // Act
    const actual = await openInWindow(subject.window, '/y', subject.openWindow, subject.environment);

    // Assert
    expect(actual).toBe('navigated');
    expect(subject.calls).toEqual(['focus', 'post', 'navigate:/y']);
    expect(subject.cleared).toEqual(['timer-1']);
  });

  it('opens the page in a window of its own when the silent window refuses a navigate', async () => {
    // Arrange: a machine's push worker controls no page, so the browser refuses its navigate.
    const subject = harness({ navigateRefused: true });

    // Act
    const pending = openInWindow(subject.window, '/x', subject.openWindow, subject.environment);
    await tick();
    subject.fire();
    const actual = await pending;

    // Assert
    expect(actual).toBe('opened');
    expect(subject.calls).toEqual(['focus', 'post', 'navigate:/x', 'open:/x']);
  });

  it('still routes the page when the browser refuses to bring the window forward', async () => {
    // Arrange
    const subject = harness({ focusRefused: true });

    // Act
    const pending = openInWindow(subject.window, '/x', subject.openWindow, subject.environment);
    await tick();
    subject.port1.onmessage?.({ data: NOTIFICATION_OPEN_ACK });
    const actual = await pending;

    // Assert
    expect(actual).toBe('routed');
    expect(subject.calls).toEqual(['focus', 'post']);
  });
  it('uses a real channel and timers by default, and routes when the window replies on the port', async () => {
    // Arrange
    const calls: string[] = [];
    const window: NotificationWindow = {
      focus: async () => {
        calls.push('focus');
      },
      navigate: async () => {
        calls.push('navigate');
      },
      postMessage: (_message, transfer) => {
        const port = transfer[0] as MessagePort;
        port.postMessage(NOTIFICATION_OPEN_ACK);
      },
    };

    // Act
    const actual = await openInWindow(window, '/z', async () => calls.push('open'));

    // Assert
    expect(actual).toBe('routed');
    expect(calls).toEqual(['focus']);
  });
});

describe('notificationWindow', () => {
  it('reuses an open app window the worker does not control, never a sign-in popup or another site', () => {
    const popup = { url: `${ORIGIN}/oauth/mcp-callback.html?code=x` };
    const scope = { url: `${ORIGIN}/push/sha256%3Awork/` };
    const foreign = { url: 'https://evil.test/d/x' };
    const app = { url: `${ORIGIN}/d/sha256%3Awork/session/s1` };

    expect(notificationWindow([popup, scope, foreign, app], ORIGIN)).toBe(app);
    expect(notificationWindow([popup, scope, foreign, { url: 'not a url' }], ORIGIN)).toBeUndefined();
    expect(notificationWindow([], ORIGIN)).toBeUndefined();
  });

  it('prefers an app window over the landing page, then the one the reader is looking at', () => {
    const landing = { url: `${ORIGIN}/`, focused: true, visibilityState: 'visible' };
    const behind = { url: `${ORIGIN}/d/a/session/s1`, focused: false, visibilityState: 'hidden' };
    const visible = { url: `${ORIGIN}/app/`, focused: false, visibilityState: 'visible' };
    const focused = { url: `${ORIGIN}/d/b`, focused: true, visibilityState: 'visible' };

    // The landing page has no router to take an open, even when it is the window in front.
    expect(notificationWindow([landing, behind], ORIGIN)).toBe(behind);
    expect(notificationWindow([landing, behind, visible], ORIGIN)).toBe(visible);
    expect(notificationWindow([behind, visible, focused], ORIGIN)).toBe(focused);
    // Ties keep the browser's own order: most recently focused first.
    expect(notificationWindow([behind, { ...behind, url: `${ORIGIN}/setup` }], ORIGIN)).toBe(behind);
    // With no app window at all, the landing page is still better than a second window.
    expect(notificationWindow([landing], ORIGIN)).toBe(landing);
  });
});

describe('NotificationOpenInbox', () => {
  const event = (data: unknown, acks: unknown[] = []) => ({
    data,
    ports: [{ postMessage: (value: unknown) => acks.push(value) }] as unknown as readonly MessagePort[],
  });

  it('acknowledges an open at once and holds it until the router subscribes, keeping only the latest', () => {
    // Arrange
    const inbox = new NotificationOpenInbox(ORIGIN);
    const acks: unknown[] = [];
    const routed: string[] = [];

    // Act
    inbox.receive(event(notificationOpenMessage('/d/a/session/s1'), acks));
    inbox.receive(event(notificationOpenMessage('/d/b/session/s2?attention=A3'), acks));
    inbox.subscribe(path => routed.push(path));

    // Assert
    expect(acks).toEqual([NOTIFICATION_OPEN_ACK, NOTIFICATION_OPEN_ACK]);
    expect(routed).toEqual(['/d/b/session/s2?attention=A3']);
  });

  it('routes through the latest subscriber, and holds again once it has gone', () => {
    // Arrange
    const inbox = new NotificationOpenInbox(ORIGIN);
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = inbox.subscribe(path => first.push(path));
    const stopSecond = inbox.subscribe(path => second.push(path));

    // Act
    stopFirst();
    inbox.receive(event(notificationOpenMessage('/one')));
    stopSecond();
    inbox.receive(event(notificationOpenMessage('/two')));
    const third: string[] = [];
    inbox.subscribe(path => third.push(path));

    // Assert
    expect(first).toEqual([]);
    expect(second).toEqual(['/one']);
    expect(third).toEqual(['/two']);
  });

  it('ignores anything that is not an open on this site, and acknowledges none of it', () => {
    // Arrange
    const inbox = new NotificationOpenInbox(ORIGIN);
    const acks: unknown[] = [];
    const routed: string[] = [];
    inbox.subscribe(path => routed.push(path));

    // Act
    inbox.receive(event({ type: 'fy-release-outcome' }, acks));
    inbox.receive(event(notificationOpenMessage('https://evil.test/x'), acks));
    inbox.receive({ data: notificationOpenMessage('/no-port'), ports: [] });

    // Assert
    expect(acks).toEqual([]);
    expect(routed).toEqual(['/no-port']);
  });

  it('listens on the source it is attached to, from the moment it is attached', () => {
    // Arrange
    const listeners: ((event: MessageEvent) => void)[] = [];
    const routed: string[] = [];

    // Act
    const inbox = attachNotificationOpens(new NotificationOpenInbox(ORIGIN), {
      addEventListener: (_type, listener) => listeners.push(listener),
    });
    for (const listener of listeners) listener(event(notificationOpenMessage('/early')) as unknown as MessageEvent);
    inbox.subscribe(path => routed.push(path));

    // Assert
    expect(listeners).toHaveLength(1);
    expect(routed).toEqual(['/early']);
    expect(attachNotificationOpens(new NotificationOpenInbox(ORIGIN), null)).toBeInstanceOf(NotificationOpenInbox);
  });
});
