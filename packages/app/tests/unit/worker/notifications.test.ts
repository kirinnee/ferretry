/**
 * The worker's own push and notification rules, copied from today's `push-scope.test.ts` and
 * `notification-open.test.ts`: which machine a registration serves, what a tap may open, and how it opens it.
 */
import { describe, expect, it } from 'bun:test';
import * as pageFacts from '@ferretry/app/worker-facts';
import {
  NOTIFICATION_BADGE,
  NOTIFICATION_ICON,
  NOTIFICATION_OPEN_ACK,
  NOTIFICATION_OPEN_ACK_MS,
  NOTIFICATION_OPEN_MESSAGE,
  type NotificationOpenEnvironment,
  type NotificationWindow,
  notificationBrand,
  notificationUrl,
  notificationWindow,
  openInWindow,
  PUSH_SCOPE_ROOT,
  pushMachineOf,
  unreadablePushTitle,
} from '../../../src/worker/notifications.ts';

const ORIGIN = 'https://ferretry.example.test';
const WORK = { daemonId: 'sha256:work/one', label: 'Work laptop' };

const tick = async (): Promise<void> => {
  await new Promise(resolve => queueMicrotask(() => resolve(undefined)));
  await new Promise(resolve => queueMicrotask(() => resolve(undefined)));
};

describe('pushMachineOf', () => {
  it('shares code-free scope, label and open-message facts with page halves', async () => {
    expect(pageFacts.PUSH_SCOPE_ROOT).toBe(PUSH_SCOPE_ROOT);
    expect(pageFacts.PUSH_LABEL_PARAMETER).toBe('machine');
    expect(pageFacts.NOTIFICATION_OPEN_MESSAGE).toBe(NOTIFICATION_OPEN_MESSAGE);
    expect(pageFacts.NOTIFICATION_OPEN_ACK).toBe(NOTIFICATION_OPEN_ACK);
    const inputs = new Set<string>();
    const result = await Bun.build({
      entrypoints: [Bun.resolveSync('@ferretry/app/worker-facts', import.meta.dir)],
      target: 'browser',
      plugins: [
        {
          name: 'trace-facts',
          setup(build) {
            build.onLoad({ filter: /.*/u }, args => {
              inputs.add(args.path);
              return undefined;
            });
          },
        },
      ],
    });
    expect(result.success).toBe(true);
    expect([...inputs]).toEqual([Bun.resolveSync('@ferretry/app/worker-facts', import.meta.dir)]);
  });
  it('reads the machine from the scope and the reader’s label from the script', () => {
    expect(PUSH_SCOPE_ROOT).toBe('/push/');
    expect(
      pushMachineOf(`${ORIGIN}/push/sha256%3Awork%2Fone/`, `${ORIGIN}/sw.verified.js?machine=Work%20laptop`),
    ).toEqual(WORK);
  });

  it('falls back to the daemon id when the script names no label', () => {
    expect(pushMachineOf(`${ORIGIN}/push/abc/`, `${ORIGIN}/sw.verified.js?machine=%20`)).toEqual({
      daemonId: 'abc',
      label: 'abc',
    });
    expect(pushMachineOf(`${ORIGIN}/push/abc/`, 'not a url')).toEqual({ daemonId: 'abc', label: 'abc' });
  });

  it('is null for the app-wide registration and anything that is not exactly one machine', () => {
    for (const scope of [
      `${ORIGIN}/`,
      `${ORIGIN}/push/`,
      `${ORIGIN}/push/a/b/`,
      `${ORIGIN}/push/%E0%A4%A/`,
      `${ORIGIN}/app/`,
      'not a url',
    ]) {
      expect(pushMachineOf(scope, `${ORIGIN}/sw.verified.js`)).toBeNull();
    }
  });

  it('titles a push nobody composed by the machine it came through, with the Ferretry mark', () => {
    expect(unreadablePushTitle(WORK)).toBe('Work laptop · Ferretry');
    expect(unreadablePushTitle(null)).toBe('Unverified · Ferretry');
    expect(notificationBrand()).toEqual({ icon: NOTIFICATION_ICON, badge: NOTIFICATION_BADGE });
  });
});

describe('notificationUrl (only this site; only this machine)', () => {
  it('opens this site’s own page, and the app for anything off this site', () => {
    expect(notificationUrl('/d/x/board', ORIGIN, null)).toBe(`${ORIGIN}/d/x/board`);
    expect(notificationUrl('https://evil.test/phish', ORIGIN, null)).toBe(`${ORIGIN}/app/`);
    expect(notificationUrl('//evil.test/phish', ORIGIN, null)).toBe(`${ORIGIN}/app/`);
    expect(notificationUrl('javascript:alert(1)', ORIGIN, null)).toBe(`${ORIGIN}/app/`);
    expect(notificationUrl(undefined, ORIGIN, null)).toBe(`${ORIGIN}/app/`);
    expect(notificationUrl(42, ORIGIN, null)).toBe(`${ORIGIN}/app/`);
  });

  it('keeps a machine inside its own pages, even through a climbing or look-alike path', () => {
    const home = `${ORIGIN}/d/sha256%3Awork%2Fone`;
    expect(notificationUrl(`${home}/board`, ORIGIN, WORK)).toBe(`${home}/board`);
    expect(notificationUrl(home, ORIGIN, WORK)).toBe(home);
    for (const elsewhere of [
      '/d/sha256%3Ahome/settings',
      `/d/sha256%3Awork%2Fone/../../d/other`,
      '/d/sha256%3Awork%2Fone-evil/x',
      '/',
      'https://evil.test/',
      undefined,
    ]) {
      expect(notificationUrl(elsewhere, ORIGIN, WORK)).toBe(home);
    }
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
    expect(subject.posted[0]?.message).toEqual({ type: NOTIFICATION_OPEN_MESSAGE, url: '/x' });
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

  it('counts /shared as an app page but never /join, so a tap cannot route a tab away mid-join', () => {
    const landing = { url: `${ORIGIN}/`, focused: true, visibilityState: 'visible' };
    const shared = { url: `${ORIGIN}/shared`, focused: false, visibilityState: 'hidden' };
    const join = { url: `${ORIGIN}/join`, focused: false, visibilityState: 'hidden' };

    expect(notificationWindow([landing, shared], ORIGIN)).toBe(shared);
    expect(notificationWindow([landing, join], ORIGIN)).toBe(landing);
  });
});

describe('notificationUrl (an ask’s push opens the ferret’s chat, AT the ask)', () => {
  const home = `${ORIGIN}/d/sha256%3Awork%2Fone`;

  it('places the daemon’s machine-relative chat path under its machine, query kept', () => {
    expect(notificationUrl('/ferrets/f1/chat?ask=A3', ORIGIN, WORK)).toBe(`${home}/ferrets/f1/chat?ask=A3`);
    expect(notificationUrl('/ferrets/a%20b/chat?ask=A12', ORIGIN, WORK)).toBe(`${home}/ferrets/a%20b/chat?ask=A12`);
  });

  it('opens the machine’s home for a machine-relative path that climbs out, and the app for a worker with no machine', () => {
    expect(notificationUrl('/ferrets/../../d/other', ORIGIN, WORK)).toBe(home);
    expect(notificationUrl('/ferrets/f1/chat?ask=A3', ORIGIN, null)).toBe(`${ORIGIN}/app/`);
  });

  it('has no /session/ alias: that path is only ever outside the machine', () => {
    expect(notificationUrl('/session/f1?ask=A3', ORIGIN, WORK)).toBe(home);
  });
});
