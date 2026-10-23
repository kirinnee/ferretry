import { describe, expect, it } from 'bun:test';
import {
  NOTIFICATION_OPEN_ACK,
  NOTIFICATION_OPEN_ACK_MS,
  NOTIFICATION_OPEN_MESSAGE,
  type NotificationOpenEnvironment,
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

const harness = (postMessage?: (message: unknown, transfer: Transferable[]) => void) => {
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
    },
    navigate: async (url: string) => {
      calls.push(`navigate:${url}`);
    },
    postMessage: (message, transfer) => {
      calls.push('post');
      if (postMessage !== undefined) postMessage(message, transfer);
      posted.push({ message, transfer });
    },
  };
  return { calls, cleared, delays, environment, port1, port2, posted, window, fire: () => timerCallback?.() };
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
    const pending = openInWindow(subject.window, '/x', subject.environment);
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
    const pending = openInWindow(subject.window, '/x', subject.environment);
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
    const subject = harness(() => {
      throw new Error('detached');
    });

    // Act
    const actual = await openInWindow(subject.window, '/y', subject.environment);

    // Assert
    expect(actual).toBe('navigated');
    expect(subject.calls).toEqual(['focus', 'post', 'navigate:/y']);
    expect(subject.cleared).toEqual(['timer-1']);
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
    const actual = await openInWindow(window, '/z');

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
});
