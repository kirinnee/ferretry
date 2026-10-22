import { describe, it } from 'bun:test';
import should from 'should';
import type { DaemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonEventTransport } from '../../src/lib/event-transport.ts';
import type { RelayStreamRequest } from '../../src/lib/relay-carrier.ts';
import type { RelayClientSession, RelayStreamClosed } from '../../src/lib/relay-session.ts';

/** A stream session as the transport sees one: frames in, a close out, and a close listener. */
class FakeStreamSession {
  readonly closes: RelayStreamClosed[] = [];
  #listener: ((closed: RelayStreamClosed) => void) | undefined;

  constructor(readonly request: RelayStreamRequest) {}

  text(text: string): void {
    this.request.onData({ kind: 'text', text });
  }

  bytes(): void {
    this.request.onData({ kind: 'bytes', bytes: new Uint8Array([1]) });
  }

  closeStream(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  onStreamClosed(listener: (closed: RelayStreamClosed) => void): void {
    this.#listener = listener;
  }

  daemonCloses(closed: RelayStreamClosed): void {
    this.#listener?.(closed);
  }
}

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon.example.test',
  deviceId: 'fy_dev_paired',
});

const streamInput = (onMessage: (value: unknown) => void) => ({
  url: 'wss://daemon.example.test/v1/events?after=12&sessionId=session-1',
  token: 'session-carried',
  onMessage,
});

/** An opener that records what it was asked for and hands back one fake session. */
const opener = (): {
  readonly opened: Array<{ readonly daemon: DaemonConnection; readonly session: FakeStreamSession }>;
  readonly open: (target: DaemonConnection, request: RelayStreamRequest) => Promise<RelayClientSession>;
} => {
  const opened: Array<{ readonly daemon: DaemonConnection; readonly session: FakeStreamSession }> = [];
  return {
    opened,
    open: async (target, request) => {
      const session = new FakeStreamSession(request);
      opened.push({ daemon: target, session });
      return session as unknown as RelayClientSession;
    },
  };
};

const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe('DaemonEventTransport', () => {
  it('should open the event feed as a stream session naming the path and query, and carry no credential', async () => {
    // Arrange
    const received: unknown[] = [];
    const abort = new AbortController();
    const streams = opener();
    const transport = new DaemonEventTransport(daemon, streams.open);

    // Act
    const streaming = transport.stream({ ...streamInput(value => received.push(value)), signal: abort.signal });
    await settle();
    const session = streams.opened[0]?.session as FakeStreamSession;
    session.text('{"sequence":12}');
    abort.abort();
    await streaming;

    // Assert
    should(streams.opened[0]?.daemon).equal(daemon);
    should(session.request.path).equal('/v1/events');
    should(session.request.query).deepEqual([
      ['after', '12'],
      ['sessionId', 'session-1'],
    ]);
    should(JSON.stringify(session.request)).not.containEql('fy_dev_paired');
    should(received).deepEqual([{ sequence: 12 }]);
    should(session.closes).deepEqual([{ code: 1000, reason: 'the viewer left this stream' }]);
  });

  it('should name no query at all when the feed URL has none', async () => {
    // Arrange
    const streams = opener();
    const transport = new DaemonEventTransport(daemon, streams.open);

    // Act
    const streaming = transport.stream({ ...streamInput(() => undefined), url: 'wss://daemon.example.test/v1/events' });
    await settle();
    const session = streams.opened[0]?.session as FakeStreamSession;
    session.daemonCloses({ code: 1000, reason: 'done' });
    await streaming;

    // Assert
    should(session.request).not.have.property('query');
  });

  it('should resolve when the daemon ends the stream with 1000', async () => {
    // Arrange
    const streams = opener();
    const transport = new DaemonEventTransport(daemon, streams.open);

    // Act
    const streaming = transport.stream(streamInput(() => undefined));
    await settle();
    streams.opened[0]?.session.daemonCloses({ code: 1000, reason: 'the daemon is done' });
    const outcome = await streaming;

    // Assert
    should(outcome).be.undefined();
  });

  it('should reject with the sealed code when the daemon ends the stream for a reason', async () => {
    // Arrange
    const streams = opener();
    const transport = new DaemonEventTransport(daemon, streams.open);

    // Act
    const streaming = transport.stream(streamInput(() => undefined));
    await settle();
    const session = streams.opened[0]?.session as FakeStreamSession;
    session.daemonCloses({ code: 1013, reason: 'the reader fell behind' });
    session.daemonCloses({ code: 1000, reason: 'a second close changes nothing' });
    const outcome = await streaming.then(
      () => undefined,
      error => error,
    );

    // Assert
    should(outcome).be.instanceOf(Error);
    should((outcome as Error).message).equal('daemon event stream closed: 1013 the reader fell behind');
  });

  it('should ignore a bytes record, which the event feed never sends', async () => {
    // Arrange
    const received: unknown[] = [];
    const streams = opener();
    const transport = new DaemonEventTransport(daemon, streams.open);

    // Act
    const streaming = transport.stream(streamInput(value => received.push(value)));
    await settle();
    const session = streams.opened[0]?.session as FakeStreamSession;
    session.bytes();
    session.daemonCloses({ code: 1000, reason: 'done' });
    await streaming;

    // Assert
    should(received).deepEqual([]);
  });

  it('should reject a stream URL outside the paired daemon before opening a session', async () => {
    // Arrange
    const streams = opener();
    const transport = new DaemonEventTransport(daemon, streams.open);

    // Act
    const outcome = await transport
      .stream({ ...streamInput(() => undefined), url: 'wss://other.example.test/v1/events?after=0' })
      .then(
        () => undefined,
        error => error,
      );

    // Assert
    should(outcome).be.instanceOf(Error);
    should((outcome as Error).message).equal('event stream must remain on the paired daemon');
    should(streams.opened).be.empty();
  });

  it('should carry the live-readout flag a session stream asks for, and nothing else new', async () => {
    // Arrange
    const streams = opener();
    const transport = new DaemonEventTransport(daemon, streams.open);

    // Act
    const streaming = transport.stream({
      ...streamInput(() => undefined),
      url: 'wss://daemon.example.test/v1/events?after=3&sessionId=session-1&live=1',
    });
    await settle();
    const session = streams.opened[0]?.session as FakeStreamSession;
    session.daemonCloses({ code: 1000, reason: 'done' });
    await streaming;

    // Assert
    should(session.request.query).deepEqual([
      ['after', '3'],
      ['sessionId', 'session-1'],
      ['live', '1'],
    ]);
  });

  it('should carry the fleet feed’s replay tail', async () => {
    // Arrange
    const streams = opener();
    const transport = new DaemonEventTransport(daemon, streams.open);

    // Act
    const streaming = transport.stream({
      ...streamInput(() => undefined),
      url: 'wss://daemon.example.test/v1/events?tail=0',
    });
    await settle();
    const session = streams.opened[0]?.session as FakeStreamSession;
    session.daemonCloses({ code: 1000, reason: 'done' });
    await streaming;

    // Assert
    should(session.request.query).deepEqual([['tail', '0']]);
  });

  it('should refuse a query parameter the feed does not have, and so can never carry a ticket or token', async () => {
    // Arrange
    const streams = opener();
    const transport = new DaemonEventTransport(daemon, streams.open);

    // Act
    const outcome = await transport
      .stream({ ...streamInput(() => undefined), url: 'wss://daemon.example.test/v1/events?token=abc' })
      .then(
        () => undefined,
        error => error,
      );

    // Assert
    should((outcome as Error).message).equal('unsupported event stream parameter: token');
    should(streams.opened).be.empty();
  });

  it('should close the stream and reject when a received frame is not JSON', async () => {
    // Arrange
    const received: unknown[] = [];
    const streams = opener();
    const transport = new DaemonEventTransport(daemon, streams.open);

    // Act
    const streaming = transport.stream(streamInput(value => received.push(value)));
    await settle();
    const session = streams.opened[0]?.session as FakeStreamSession;
    session.text('not-json');
    session.text('{"sequence":13}');
    const outcome = await streaming.then(
      () => undefined,
      error => error,
    );

    // Assert — nothing after the damaged frame is delivered as if the feed were still whole.
    should((outcome as Error).message).equal('daemon event stream sent a frame that is not JSON');
    should(session.closes).deepEqual([{ code: 1003, reason: 'the viewer could not read this stream' }]);
    should(received).deepEqual([]);
  });

  it('should refuse a damaged frame that arrived before the session was handed back', async () => {
    // Arrange
    let session: FakeStreamSession | undefined;
    const transport = new DaemonEventTransport(daemon, async (_target, request) => {
      session = new FakeStreamSession(request);
      session.text('not-json');
      return session as unknown as RelayClientSession;
    });

    // Act
    const outcome = await transport.stream(streamInput(() => undefined)).then(
      () => undefined,
      error => error,
    );

    // Assert
    should((outcome as Error).message).equal('daemon event stream sent a frame that is not JSON');
    should(session?.closes).deepEqual([{ code: 1003, reason: 'the viewer could not read this stream' }]);
  });

  it('should not open a session when already cancelled', async () => {
    // Arrange
    const abort = new AbortController();
    abort.abort();
    const streams = opener();
    const transport = new DaemonEventTransport(daemon, streams.open);

    // Act
    await transport.stream({ ...streamInput(() => undefined), signal: abort.signal });

    // Assert
    should(streams.opened).be.empty();
  });

  it('should leave at once when cancellation arrives while the session is opening', async () => {
    // Arrange
    const abort = new AbortController();
    let release: (() => void) | undefined;
    let session: FakeStreamSession | undefined;
    const transport = new DaemonEventTransport(
      daemon,
      async (_target, request) =>
        await new Promise<RelayClientSession>(resolve => {
          release = () => {
            session = new FakeStreamSession(request);
            resolve(session as unknown as RelayClientSession);
          };
        }),
    );

    // Act
    const streaming = transport.stream({ ...streamInput(() => undefined), signal: abort.signal });
    await settle();
    abort.abort();
    release?.();
    await streaming;

    // Assert — the session that opened too late is told the viewer left, never left dangling.
    should(session?.closes).deepEqual([{ code: 1000, reason: 'the viewer left this stream' }]);
  });
});
