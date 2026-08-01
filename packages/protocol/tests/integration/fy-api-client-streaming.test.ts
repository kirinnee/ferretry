import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { WebSocketEventTransport } from '../../src/adapters/fy-api-client.ts';
import type { IFyFileLoader } from '../../src/lib/client.ts';
import type { FyEvent } from '../../src/lib/session.ts';
import { attachmentView, fyEvent, INSTANT } from '../fixtures.ts';
import { BASE_URL, connectClient } from './client-harness.ts';
import { captureError, jsonResponse, QueuedEventTransport, QueuedHttpTransport } from './fakes.ts';

const SESSION_ID = 'session-1';

const eventAt = (sequence: number): FyEvent => ({ ...fyEvent, sequence, time: INSTANT });

const pathsOf = (transport: QueuedHttpTransport): string[] =>
  transport.calls.map(call => call.url.slice(BASE_URL.length));

const filePartOf = (transport: QueuedHttpTransport, index = 0): File => {
  const form = transport.calls[index]?.init.body;
  should(form).be.instanceof(FormData);
  return (form as FormData).get('file') as File;
};

describe('FyApiClient event history paging', () => {
  it('should page until a short page arrives when no limit is given', async () => {
    // Arrange
    const firstPage = Array.from({ length: 1_000 }, (_, index) => eventAt(index + 1));
    const secondPage = [eventAt(1_001), eventAt(1_002)];
    const transport = new QueuedHttpTransport(jsonResponse(firstPage), jsonResponse(secondPage));
    const client = await connectClient(transport);

    // Act
    const actual = await client.history(SESSION_ID);

    // Assert
    should(actual).have.length(1_002);
    should(actual.at(-1)).deepEqual(eventAt(1_002));
    should(pathsOf(transport)).deepEqual([
      '/v1/sessions/session-1/events?after=0&limit=1000',
      '/v1/sessions/session-1/events?after=1000&limit=1000',
    ]);
  });

  it('should shrink the final page to the remainder of the requested limit', async () => {
    // Arrange
    const firstPage = Array.from({ length: 1_000 }, (_, index) => eventAt(index + 1));
    const transport = new QueuedHttpTransport(jsonResponse(firstPage), jsonResponse([eventAt(1_001), eventAt(1_002)]));
    const client = await connectClient(transport);

    // Act
    const actual = await client.history(SESSION_ID, 0, 1_002);

    // Assert
    should(actual).have.length(1_002);
    should(pathsOf(transport)).deepEqual([
      '/v1/sessions/session-1/events?after=0&limit=1000',
      '/v1/sessions/session-1/events?after=1000&limit=2',
    ]);
  });

  it('should stop requesting pages once the limit is filled exactly', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse([eventAt(1), eventAt(2)]), jsonResponse([eventAt(3)]));
    const client = await connectClient(transport);

    // Act
    const actual = await client.history(SESSION_ID, 0, 2);

    // Assert
    should(actual.map(event => event.sequence)).deepEqual([1, 2]);
    should(pathsOf(transport)).deepEqual(['/v1/sessions/session-1/events?after=0&limit=2']);
  });

  it('should start from the caller cursor and stop on a short first page', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse([eventAt(9)]));
    const client = await connectClient(transport);

    // Act
    const actual = await client.history(SESSION_ID, 8, 5);

    // Assert
    should(actual).deepEqual([eventAt(9)]);
    should(pathsOf(transport)).deepEqual(['/v1/sessions/session-1/events?after=8&limit=5']);
  });

  it('should refuse to loop forever when a full page does not advance the cursor', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse([eventAt(4), eventAt(3)]));
    const client = await connectClient(transport);

    // Act
    const actual = await captureError(() => client.history(SESSION_ID, 3, 2));

    // Assert
    should(actual instanceof Error).be.true();
    should((actual as Error).message).equal('event history page did not advance its cursor');
    should(transport.calls).have.length(1);
  });
});

describe('FyApiClient attachment upload', () => {
  it('should upload a blob under a generated filename', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse(attachmentView));
    const client = await connectClient(transport);
    const input = new Blob(['note'], { type: 'text/plain' });

    // Act
    const actual = await client.upload(SESSION_ID, input);

    // Assert
    should(actual).deepEqual(attachmentView);
    should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/sessions/session-1/attachments`);
    should(transport.calls[0]?.init.method).equal('POST');
    should(filePartOf(transport).name).equal('attachment');
    should(filePartOf(transport).type).equal(input.type);
    should(await filePartOf(transport).text()).equal('note');
  });

  it('should prefer a File name and honour an explicit filename override', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse(attachmentView), jsonResponse(attachmentView));
    const client = await connectClient(transport);

    // Act
    await client.upload(SESSION_ID, new File(['note'], 'from-file.txt', { type: 'text/plain' }));
    await client.upload(SESSION_ID, new File(['note'], 'from-file.txt'), 'override.txt');

    // Assert
    should(filePartOf(transport, 0).name).equal('from-file.txt');
    should(filePartOf(transport, 1).name).equal('override.txt');
  });

  it('should load a path through the injected file loader', async () => {
    // Arrange
    const loaded: string[] = [];
    const fileLoader: IFyFileLoader = {
      load: async path => {
        loaded.push(path);
        return { blob: new Blob(['from disk']), filename: 'loaded.txt' };
      },
    };
    const transport = new QueuedHttpTransport(jsonResponse(attachmentView), jsonResponse(attachmentView));
    const client = await connectClient(transport, { fileLoader });

    // Act
    await client.upload(SESSION_ID, '/tmp/loaded.txt');
    await client.upload(SESSION_ID, '/tmp/loaded.txt', 'renamed.txt');

    // Assert
    should(loaded).deepEqual(['/tmp/loaded.txt', '/tmp/loaded.txt']);
    should(filePartOf(transport, 0).name).equal('loaded.txt');
    should(filePartOf(transport, 1).name).equal('renamed.txt');
    should(await filePartOf(transport, 0).text()).equal('from disk');
  });

  it('should refuse a path upload when no file loader is installed', async () => {
    // Arrange
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);

    // Act
    const actual = await captureError(() => client.upload(SESSION_ID, '/tmp/loaded.txt'));

    // Assert
    should(actual instanceof Error).be.true();
    should((actual as Error).message).equal('uploading a path requires a file loader');
    should(transport.calls).have.length(0);
  });

  it('should refuse a blank resolved filename', async () => {
    // Arrange
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);

    // Act
    const actual = await captureError(() => client.upload(SESSION_ID, new Blob(['note']), '   '));

    // Assert
    should(actual instanceof z.ZodError).be.true();
    should(transport.calls).have.length(0);
  });
});

const eventFrame = (sequence: number): unknown => ({ kind: 'event', event: eventAt(sequence) });

describe('FyApiClient event streaming', () => {
  it('should open a ws stream scoped to one session and unwrap every event frame', async () => {
    // Arrange
    const eventTransport = new QueuedEventTransport(eventFrame(4), eventFrame(5));
    const client = await connectClient(new QueuedHttpTransport(), { eventTransport });
    const received: FyEvent[] = [];

    // Act
    await client.stream(SESSION_ID, 3, event => received.push(event));

    // Assert — the wrapper is a transport detail; the consumer still sees plain protocol events.
    should(received).deepEqual([eventAt(4), eventAt(5)]);
    should(eventTransport.calls).deepEqual([
      { url: `ws://daemon.test/api/v1/events?after=3&sessionId=session-1`, token: 'secret-token' },
    ]);
  });

  it('should upgrade an https base URL to a wss fleet-wide stream', async () => {
    // Arrange
    const eventTransport = new QueuedEventTransport();
    const client = await connectClient(new QueuedHttpTransport(), {
      baseUrl: 'https://daemon.test/api/',
      eventTransport,
    });

    // Act
    await client.stream(undefined, 0, () => undefined);

    // Assert
    should(eventTransport.calls[0]?.url).equal('wss://daemon.test/api/v1/events?after=0');
  });

  it('should route idle proofs to the idle handler and never to the event handler', async () => {
    // Arrange — one quiet stretch per scope, interleaved with a real event.
    const eventTransport = new QueuedEventTransport(
      { kind: 'idle', idleSeconds: 30, scope: { kind: 'session', sessionId: SESSION_ID, after: 3 } },
      eventFrame(4),
      { kind: 'idle', idleSeconds: 45, scope: { kind: 'fleet', followedSessions: 2 } },
    );
    const client = await connectClient(new QueuedHttpTransport(), { eventTransport });
    const received: FyEvent[] = [];
    const idles: unknown[] = [];

    // Act
    await client.stream(
      SESSION_ID,
      3,
      event => received.push(event),
      undefined,
      idle => idles.push(idle),
    );

    // Assert — a heartbeat that reached onEvent would be indistinguishable from a session event.
    should(received).deepEqual([eventAt(4)]);
    should(idles).deepEqual([
      { kind: 'idle', idleSeconds: 30, scope: { kind: 'session', sessionId: SESSION_ID, after: 3 } },
      { kind: 'idle', idleSeconds: 45, scope: { kind: 'fleet', followedSessions: 2 } },
    ]);
  });

  it('should still validate an idle frame a caller declined to observe', async () => {
    // Arrange
    const eventTransport = new QueuedEventTransport(
      { kind: 'idle', idleSeconds: 30, scope: { kind: 'fleet', followedSessions: 0 } },
      eventFrame(4),
    );
    const client = await connectClient(new QueuedHttpTransport(), { eventTransport });
    const received: FyEvent[] = [];

    // Act — no onIdle is supplied, so the frame is parsed and then deliberately dropped.
    await client.stream(undefined, 0, event => received.push(event));

    // Assert
    should(received).deepEqual([eventAt(4)]);
  });

  it('should hand the caller cancellation straight to the socket transport', async () => {
    // Arrange
    const eventTransport = new QueuedEventTransport(eventFrame(4), eventFrame(5));
    const client = await connectClient(new QueuedHttpTransport(), { eventTransport });
    const controller = new AbortController();
    const received: FyEvent[] = [];
    controller.abort();

    // Act
    await client.stream(SESSION_ID, 3, event => received.push(event), controller.signal);

    // Assert — the signal is the socket's, not a post-hoc filter over delivered events.
    should(eventTransport.signals).deepEqual([controller.signal]);
    should(received).be.empty();
  });

  it('should reject a malformed streamed frame and invalid stream arguments', async () => {
    // Arrange — a bare event is exactly the pre-wrapper shape that must no longer be accepted.
    const eventTransport = new QueuedEventTransport(eventAt(4));
    const client = await connectClient(new QueuedHttpTransport(), { eventTransport });

    // Act
    const malformedFrame = await captureError(() => client.stream(SESSION_ID, 0, () => undefined));
    const negativeCursor = await captureError(() => client.stream(SESSION_ID, -1, () => undefined));
    const blankSessionId = await captureError(() => client.stream('   ', 0, () => undefined));

    // Assert
    should(malformedFrame instanceof z.ZodError).be.true();
    should(negativeCursor instanceof z.ZodError).be.true();
    should(blankSessionId instanceof z.ZodError).be.true();
    should(eventTransport.calls).have.length(1);
  });
});

interface FakeSocketEvent {
  readonly data?: string;
  readonly code?: number;
  readonly reason?: string;
}

interface FakeSocketClose {
  readonly code: number | undefined;
  readonly reason: string | undefined;
}

/**
 * A socket that records its listener bookkeeping.
 *
 * `listenerCount` exists because a long-lived stream that settles must let go of everything it
 * registered — a leaked listener on a closed socket is the shape that used to keep a cancelled
 * follow alive.
 */
class FakeWebSocket {
  static latest: FakeWebSocket | undefined;
  readonly #listeners = new Map<string, Array<(event: FakeSocketEvent) => void>>();
  readonly closeCalls: FakeSocketClose[] = [];

  constructor(
    readonly url: string | URL,
    readonly options: { headers: RequestInit['headers'] },
  ) {
    FakeWebSocket.latest = this;
  }

  get closes(): number {
    return this.closeCalls.length;
  }

  addEventListener(type: string, listener: (event: FakeSocketEvent) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: FakeSocketEvent) => void): void {
    this.#listeners.set(
      type,
      (this.#listeners.get(type) ?? []).filter(entry => entry !== listener),
    );
  }

  listenerCount(): number {
    return [...this.#listeners.values()].reduce((total, listeners) => total + listeners.length, 0);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  emit(type: string, event: FakeSocketEvent = {}): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
  }
}

const withFakeWebSocket = async (
  scenario: (socket: () => FakeWebSocket, stream: Promise<void>) => Promise<void>,
  onMessage: (value: unknown) => void = () => undefined,
  signal?: AbortSignal,
): Promise<void> => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const stream = new WebSocketEventTransport().stream({
      url: 'ws://daemon.test/api/v1/events?after=0',
      token: 'secret-token',
      onMessage,
      ...(signal === undefined ? {} : { signal }),
    });
    await scenario(() => FakeWebSocket.latest as FakeWebSocket, stream);
  } finally {
    globalThis.WebSocket = original;
    FakeWebSocket.latest = undefined;
  }
};

describe('WebSocketEventTransport', () => {
  it('should authenticate the socket and forward every parsed message', async () => {
    // Arrange
    const received: unknown[] = [];
    const controller = new AbortController();

    // Act + Assert
    await withFakeWebSocket(
      async (socket, stream) => {
        // Arrange
        const opened = socket();

        // Act
        opened.emit('message', { data: JSON.stringify({ sequence: 1 }) });
        opened.emit('message', { data: JSON.stringify({ sequence: 2 }) });
        controller.abort();
        await stream;

        // Assert
        should(opened.url).equal('ws://daemon.test/api/v1/events?after=0');
        should(opened.options).deepEqual({ headers: { authorization: 'Bearer secret-token' } });
        should(received).deepEqual([{ sequence: 1 }, { sequence: 2 }]);
      },
      value => received.push(value),
      controller.signal,
    );
  });

  it('should close the socket cleanly and drop every listener when the caller cancels', async () => {
    // Arrange
    const controller = new AbortController();

    // Act + Assert
    await withFakeWebSocket(
      async (socket, stream) => {
        // Arrange
        const opened = socket();

        // Act
        controller.abort();
        await stream;

        // Assert — a cancelled follow is a successful release: normal close, nothing left registered.
        should(opened.closeCalls).deepEqual([{ code: 1_000, reason: 'event stream cancelled' }]);
        should(opened.listenerCount()).equal(0);
      },
      () => undefined,
      controller.signal,
    );
  });

  it('should ignore a socket close that arrives after the caller already cancelled', async () => {
    // Arrange
    const controller = new AbortController();

    // Act + Assert
    await withFakeWebSocket(
      async (socket, stream) => {
        // Arrange
        const opened = socket();

        // Act
        controller.abort();
        opened.emit('close', { code: 1_006, reason: '' });
        await stream;

        // Assert — the late close must not turn a released stream into a failed one.
        should(opened.closes).equal(1);
      },
      () => undefined,
      controller.signal,
    );
  });

  it('should never open a socket when the caller signal is already aborted', async () => {
    // Arrange
    const original = globalThis.WebSocket;
    const controller = new AbortController();
    controller.abort();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    // Act
    try {
      await new WebSocketEventTransport().stream({
        url: 'ws://daemon.test/api/v1/events?after=0',
        token: 'secret-token',
        signal: controller.signal,
        onMessage: () => undefined,
      });
    } finally {
      globalThis.WebSocket = original;
    }

    // Assert — nothing was constructed, so nothing has to be torn down.
    should(FakeWebSocket.latest).be.undefined();
  });

  it('should reject with the close code when the daemon drops the socket', async () => {
    // Act + Assert
    await withFakeWebSocket(async (socket, stream) => {
      // Arrange
      const opened = socket();

      // Act
      opened.emit('close', { code: 1_006, reason: '' });
      const actual = await captureError(() => stream);

      // Assert — a silent resolve here made a dropped feed look like an ordinary end of stream.
      should((actual as Error).message).equal('WebSocket stream closed unexpectedly: code 1006');
      should(opened.listenerCount()).equal(0);
    });
  });

  it('should include the daemon reason when the close carries one', async () => {
    // Act + Assert
    await withFakeWebSocket(async (socket, stream) => {
      // Arrange
      const opened = socket();

      // Act
      opened.emit('close', { code: 1_011, reason: 'event journal unreadable' });
      const actual = await captureError(() => stream);

      // Assert
      should((actual as Error).message).equal(
        'WebSocket stream closed unexpectedly: event journal unreadable (code 1011)',
      );
    });
  });

  it('should close and reject once on an unparseable message and ignore later events', async () => {
    // Act + Assert
    await withFakeWebSocket(async (socket, stream) => {
      // Arrange
      const opened = socket();

      // Act
      opened.emit('message', { data: '{' });
      opened.emit('message', { data: '{' });
      opened.emit('close');
      const actual = await captureError(() => stream);

      // Assert
      should(actual instanceof SyntaxError).be.true();
      should(opened.closes).equal(1);
      should(opened.listenerCount()).equal(0);
    });
  });

  it('should reject with a stream failure when the socket errors', async () => {
    // Act + Assert
    await withFakeWebSocket(async (socket, stream) => {
      // Arrange
      const opened = socket();

      // Act
      opened.emit('error');
      const actual = await captureError(() => stream);

      // Assert
      should(actual instanceof Error).be.true();
      should((actual as Error).message).equal('WebSocket stream failed');
      should(opened.closes).equal(1);
    });
  });

  it('should wrap a non-Error consumer failure in a stream failure', async () => {
    // Act + Assert
    await withFakeWebSocket(
      async (socket, stream) => {
        // Arrange
        const opened = socket();

        // Act
        opened.emit('message', { data: '{"sequence":1}' });
        const actual = await captureError(() => stream);

        // Assert
        should(actual instanceof Error).be.true();
        should((actual as Error).message).equal('WebSocket stream failed');
        should(opened.closes).equal(1);
      },
      () => {
        throw 'consumer exploded';
      },
    );
  });
});
