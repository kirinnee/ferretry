import { describe, it } from 'bun:test';
import should from 'should';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { DaemonEventSocket } from '../../src/lib/event-transport.ts';
import { daemonEventTicket, DaemonEventTransport } from '../../src/lib/event-transport.ts';

class FakeSocket implements DaemonEventSocket {
  static latest: FakeSocket | undefined;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  closes = 0;

  constructor(readonly url: string) {
    FakeSocket.latest = this;
  }

  close(): void {
    this.closes += 1;
    this.onclose?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon.example.test',
  deviceToken: 'durable-device-token',
});

const streamInput = (onMessage: (value: unknown) => void) => ({
  url: 'wss://daemon.example.test/v1/events?after=12&sessionId=session-1',
  token: 'durable-device-token',
  onMessage,
});

describe('DaemonEventTransport', () => {
  it('should open a paired-daemon event URL with a short-lived ticket and no device token', async () => {
    // Arrange
    const received: unknown[] = [];
    const abort = new AbortController();
    const transport = new DaemonEventTransport(
      daemon,
      async actual => {
        should(actual).equal(daemon);
        return 'one-time-ticket';
      },
      url => new FakeSocket(url),
    );

    // Act
    const streaming = transport.stream({
      ...streamInput(value => received.push(value)),
      signal: abort.signal,
    });
    await Promise.resolve();
    const socket = FakeSocket.latest as FakeSocket;
    socket.message('{"sequence":12}');
    abort.abort();
    await streaming;

    // Assert
    should(socket.url).equal('wss://daemon.example.test/v1/events?ticket=one-time-ticket&after=12&sessionId=session-1');
    should(socket.url).not.containEql('durable-device-token');
    should(received).deepEqual([{ sequence: 12 }]);
  });

  it('should reject when the peer closes a stream that was not cancelled', async () => {
    // Arrange
    const transport = new DaemonEventTransport(
      daemon,
      async () => 'one-time-ticket',
      url => new FakeSocket(url),
    );

    // Act
    const streaming = transport.stream(streamInput(() => undefined));
    await Promise.resolve();
    const socket = FakeSocket.latest as FakeSocket;
    socket.close();
    const outcome = await streaming.then(
      () => undefined,
      error => error,
    );

    // Assert
    should(outcome).be.instanceOf(Error);
    should((outcome as Error).message).equal('daemon event stream closed unexpectedly');
  });

  it('should reject a stream URL outside the paired daemon before opening a socket', async () => {
    // Arrange
    let opened = false;
    const transport = new DaemonEventTransport(
      daemon,
      async () => 'one-time-ticket',
      () => {
        opened = true;
        return new FakeSocket('unused');
      },
    );

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
    should(opened).be.false();
  });

  it('should close and reject when a received frame is not JSON', async () => {
    // Arrange
    const transport = new DaemonEventTransport(
      daemon,
      async () => 'one-time-ticket',
      url => new FakeSocket(url),
    );

    // Act
    const streaming = transport.stream(streamInput(() => undefined));
    await Promise.resolve();
    const socket = FakeSocket.latest as FakeSocket;
    socket.message('not-json');
    const outcome = await streaming.then(
      () => undefined,
      error => error,
    );

    // Assert
    should(outcome).be.instanceOf(Error);
    should(socket.closes).equal(1);
  });

  it('should close the socket, clear listeners, and resolve when cancelled', async () => {
    // Arrange
    const abort = new AbortController();
    const transport = new DaemonEventTransport(
      daemon,
      async () => 'one-time-ticket',
      url => new FakeSocket(url),
    );

    // Act
    const streaming = transport.stream({ ...streamInput(() => undefined), signal: abort.signal });
    await Promise.resolve();
    const socket = FakeSocket.latest as FakeSocket;
    abort.abort();
    await streaming;

    // Assert
    should(socket.closes).equal(1);
    should(socket.onmessage).be.null();
    should(socket.onclose).be.null();
    should(socket.onerror).be.null();
  });

  it('should not issue a ticket or open a socket when already cancelled', async () => {
    // Arrange
    const abort = new AbortController();
    abort.abort();
    let issued = 0;
    let opened = 0;
    const transport = new DaemonEventTransport(
      daemon,
      async () => {
        issued += 1;
        return 'unused';
      },
      url => {
        opened += 1;
        return new FakeSocket(url);
      },
    );

    // Act
    await transport.stream({ ...streamInput(() => undefined), signal: abort.signal });

    // Assert
    should(issued).equal(0);
    should(opened).equal(0);
  });

  it('should not open a socket when cancellation arrives during ticket issuance', async () => {
    // Arrange
    const abort = new AbortController();
    let release: ((ticket: string) => void) | undefined;
    let opened = 0;
    const transport = new DaemonEventTransport(
      daemon,
      async () =>
        await new Promise<string>(resolve => {
          release = resolve;
        }),
      url => {
        opened += 1;
        return new FakeSocket(url);
      },
    );

    // Act
    const streaming = transport.stream({ ...streamInput(() => undefined), signal: abort.signal });
    await Promise.resolve();
    abort.abort();
    release?.('too-late-ticket');
    await streaming;

    // Assert
    should(opened).equal(0);
  });
});

describe('daemonEventTicket', () => {
  const ticket = `fy_ticket_${'t'.repeat(43)}`;

  it('should buy a ticket with the device token on the one request that can carry a header', async () => {
    // Arrange
    const seen: Array<readonly [string, RequestInit]> = [];

    // Act
    const issued = await daemonEventTicket(daemon, async (url, init) => {
      seen.push([url, init]);
      return new Response(JSON.stringify({ ticket, ttlSeconds: 30, expiresAt: '2026-08-03T12:00:30.000Z' }), {
        status: 201,
      });
    });

    // Assert — the durable credential travels in a header, and only the disposable one may reach a URL.
    should(issued).equal(ticket);
    should(seen[0]?.[0]).equal('https://daemon.example.test/v1/events/ticket');
    should(seen[0]?.[1].method).equal('POST');
    should(new Headers(seen[0]?.[1].headers).get('authorization')).equal('Bearer durable-device-token');
  });

  it('should refuse rather than hand back a ticket the daemon would not sell', async () => {
    // Arrange / Act / Assert — a stream that silently never opens tells a viewer nothing at all.
    await should(daemonEventTicket(daemon, async () => new Response('nope', { status: 403 }))).be.rejectedWith(/403/u);
  });

  it('should refuse a response that is not a ticket', async () => {
    // Arrange / Act / Assert — a body that parses as something else is damaged evidence, not a ticket.
    await should(
      daemonEventTicket(
        daemon,
        async () => new Response(JSON.stringify({ ticket: 'plain', ttlSeconds: 30 }), { status: 201 }),
      ),
    ).be.rejected();
  });
});
