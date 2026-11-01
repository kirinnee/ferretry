/**
 * A PAGE CLOSING WHILE ONE OF ITS EVENTS IS STILL IN FLIGHT, driven through Playwright's own client
 * `Connection` — the object whose `dispatch` threw `Cannot find object to "loadstate": frame@…` from a
 * bare `setImmediate` and failed the whole integration job after every test had passed
 * (see `support/late-protocol-events.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';
import { type ClientConnection, ignoreLateProtocolEvents, isLateEventError } from './support/late-protocol-events.ts';

interface Message {
  id?: number;
  guid?: string;
  method?: string;
  params?: Record<string, unknown>;
}

/** A connection whose `dispatch` throws Playwright's own message for a guid it does not hold. */
const fakeConnection = (): ClientConnection & { dispatched: Message[] } => {
  const objects = new Map<string, true>();
  const dispatched: Message[] = [];
  return {
    dispatched,
    _objects: objects,
    dispatch(message: Message) {
      dispatched.push(message);
      if (message.method === '__create__' && typeof message.params?.guid === 'string') {
        objects.set(message.params.guid, true);
        return;
      }
      if (message.method === '__dispose__' && message.guid !== undefined) {
        objects.delete(message.guid);
        return;
      }
      if (message.guid !== undefined && !objects.has(message.guid))
        throw new Error(`Cannot find object to "${message.method}": ${message.guid}`);
    },
  };
};

const create = (guid: string): Message => ({ guid: 'root@0', method: '__create__', params: { guid } });

describe('the error that is swallowed', () => {
  test('is exactly Playwright’s "Cannot find object" for an event', () => {
    expect(isLateEventError(new Error('Cannot find object to "loadstate": frame@0123abcd'))).toBe(true);
    expect(isLateEventError(new Error('Cannot find object to "previewUpdated": handle@ff00'))).toBe(true);
  });

  test('is nothing else', () => {
    expect(isLateEventError(new Error('Cannot find object to "loadstate": frame@0123abcd and more'))).toBe(false);
    expect(isLateEventError(new Error('Cannot find command to respond: 4'))).toBe(false);
    expect(isLateEventError(new Error('Unknown new child: frame@1'))).toBe(false);
    expect(isLateEventError('Cannot find object to "loadstate": frame@0123abcd')).toBe(false);
  });
});

describe('an event for a target this connection created and has dropped', () => {
  test('is ignored', () => {
    const connection = fakeConnection();
    ignoreLateProtocolEvents(connection);
    connection.dispatch(create('frame@a1'));
    connection.dispatch({ guid: 'frame@a1', method: '__dispose__' });

    expect(() => connection.dispatch({ guid: 'frame@a1', method: 'loadstate', params: {} })).not.toThrow();
  });

  test('is delivered while the target is still alive', () => {
    const connection = fakeConnection();
    ignoreLateProtocolEvents(connection);
    connection.dispatch(create('frame@a1'));
    connection.dispatch({ guid: 'frame@a1', method: 'loadstate', params: {} });

    expect(connection.dispatched.at(-1)?.method).toBe('loadstate');
  });
});

describe('what is still a failure', () => {
  test('an event for a guid this connection never created', () => {
    const connection = fakeConnection();
    ignoreLateProtocolEvents(connection);

    expect(() => connection.dispatch({ guid: 'frame@never', method: 'loadstate', params: {} })).toThrow(
      'Cannot find object to "loadstate": frame@never',
    );
  });

  test('a reply to a command, which belongs to its awaiting caller', () => {
    const connection = fakeConnection();
    ignoreLateProtocolEvents(connection);
    connection.dispatch(create('frame@a1'));
    connection.dispatch({ guid: 'frame@a1', method: '__dispose__' });

    expect(() => connection.dispatch({ id: 7, guid: 'frame@a1', method: 'loadstate' })).toThrow(
      'Cannot find object to "loadstate": frame@a1',
    );
  });

  test('any other error dispatch raises', () => {
    const connection = fakeConnection();
    const boom = new Error('Unknown new child: frame@2');
    connection.dispatch = message => {
      if (message.method === '__adopt__') throw boom;
    };
    ignoreLateProtocolEvents(connection);

    expect(() => connection.dispatch({ guid: 'frame@a1', method: '__adopt__' })).toThrow(boom);
  });

  test('wrapping twice does not wrap twice', () => {
    const connection = fakeConnection();
    ignoreLateProtocolEvents(connection);
    const once = connection.dispatch;
    ignoreLateProtocolEvents(connection);

    expect(connection.dispatch).toBe(once);
  });
});

describe('Playwright’s real client connection', () => {
  type Owner = { _guid: string };

  test('takes a late event for a closed page without an unhandled error, and still throws for a stranger', async () => {
    const browser = await sharedChromium();
    const connection = (chromium as unknown as { _connection: ClientConnection })._connection;
    const context = await browser.newContext();
    const page = await context.newPage();
    const guid = (page as unknown as Owner)._guid;
    const frame = (page.mainFrame() as unknown as Owner)._guid;
    await context.close();
    expect(connection._objects.has(guid)).toBe(false);

    // Through the real `onmessage` path: a bare `setImmediate`, as Playwright delivers a server event.
    const delivered = new Promise<void>(resolve => {
      setImmediate(() => {
        connection.dispatch({ guid: frame, method: 'loadstate', params: { add: 'load' } });
        connection.dispatch({ guid, method: 'close', params: {} });
        resolve();
      });
    });
    await delivered;
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(() => connection.dispatch({ guid: 'frame@00000000000000000000000000000000', method: 'loadstate' })).toThrow(
      'Cannot find object to "loadstate"',
    );
  });
});
