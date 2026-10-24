import { afterEach, describe, expect, it } from 'bun:test';
import {
  NotificationOpenContext,
  type NotificationOpenSource,
  useNotificationOpen,
} from '../../src/hooks/use-notification-open.ts';
import {
  NOTIFICATION_OPEN_ACK,
  NOTIFICATION_OPEN_MESSAGE,
  NotificationOpenInbox,
} from '../../src/lib/notification-open.ts';
import { type Mounted, mount } from '../support/dom.ts';

const ORIGIN = 'https://pwa.example.test';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const fakeSource = () => {
  const listeners = new Set<(event: MessageEvent) => void>();
  const source: NotificationOpenSource = {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  const emit = (data: unknown, ports: readonly unknown[] = []): void => {
    for (const listener of [...listeners]) listener({ data, ports } as unknown as MessageEvent);
  };
  return { source, listeners, emit };
};

function Probe(props: { source: NotificationOpenSource | null; navigate: (to: string) => void }) {
  useNotificationOpen(props.source, ORIGIN, props.navigate);
  return null;
}

const message = (url: string) => ({ type: NOTIFICATION_OPEN_MESSAGE, url });

describe('useNotificationOpen', () => {
  it('does nothing without a source', async () => {
    // Arrange
    const navigated: string[] = [];

    // Act
    mounted = await mount(<Probe source={null} navigate={to => navigated.push(to)} />);

    // Assert
    expect(navigated).toEqual([]);
  });

  it('navigates in the app and acknowledges on the transferred port', async () => {
    // Arrange
    const { source, emit } = fakeSource();
    const navigated: string[] = [];
    const acks: unknown[] = [];
    mounted = await mount(<Probe source={source} navigate={to => navigated.push(to)} />);

    // Act
    emit(message('/d/a/session/b?x=1#h'), [{ postMessage: (value: unknown) => acks.push(value) }]);

    // Assert
    expect(navigated).toEqual(['/d/a/session/b?x=1#h']);
    expect(acks).toEqual([NOTIFICATION_OPEN_ACK]);
  });

  it('still navigates when the message carries no port', async () => {
    // Arrange
    const { source, emit } = fakeSource();
    const navigated: string[] = [];
    mounted = await mount(<Probe source={source} navigate={to => navigated.push(to)} />);

    // Act
    emit(message('/p'));

    // Assert
    expect(navigated).toEqual(['/p']);
  });

  it('ignores an invalid message and acknowledges nothing', async () => {
    // Arrange
    const { source, emit } = fakeSource();
    const navigated: string[] = [];
    const acks: unknown[] = [];
    mounted = await mount(<Probe source={source} navigate={to => navigated.push(to)} />);

    // Act
    emit(message('https://evil.test/x'), [{ postMessage: (value: unknown) => acks.push(value) }]);

    // Assert
    expect(navigated).toEqual([]);
    expect(acks).toEqual([]);
  });

  it('removes its listener on unmount', async () => {
    // Arrange
    const { source, listeners } = fakeSource();
    mounted = await mount(<Probe source={source} navigate={() => undefined} />);
    const before = listeners.size;

    // Act
    await mounted.unmount();
    mounted = null;

    // Assert
    expect(before).toBe(1);
    expect(listeners.size).toBe(0);
  });

  it('routes from the entry point’s inbox when one is provided — the open that arrived first included', async () => {
    // Arrange: a tap reached the page before the app mounted.
    const inbox = new NotificationOpenInbox(ORIGIN);
    const acks: unknown[] = [];
    inbox.receive({
      data: message('/d/b/session/s2?attention=A3'),
      ports: [{ postMessage: (value: unknown) => acks.push(value) }] as unknown as readonly MessagePort[],
    });
    const { source, listeners } = fakeSource();
    const navigated: string[] = [];

    // Act
    mounted = await mount(
      <NotificationOpenContext.Provider value={inbox}>
        <Probe source={source} navigate={to => navigated.push(to)} />
      </NotificationOpenContext.Provider>,
    );
    inbox.receive({ data: message('/later'), ports: [] });
    await mounted.unmount();
    mounted = null;
    inbox.receive({ data: message('/after-unmount'), ports: [] });

    // Assert
    expect(acks).toEqual([NOTIFICATION_OPEN_ACK]);
    expect(navigated).toEqual(['/d/b/session/s2?attention=A3', '/later']);
    // The inbox already listens; the hook adds no second listener of its own.
    expect(listeners.size).toBe(0);
  });
});
