import { describe, it } from 'bun:test';
import should from 'should';
import { FetchEnhancementTransport, PerformanceStopwatch } from '../../../src/adapters/index.ts';
import type { EnhancementHttpRequest } from '../../../src/lib/index.ts';

const request: EnhancementHttpRequest = {
  method: 'POST',
  url: 'https://provider.invalid/v1/chat/completions',
  headers: { authorization: 'Bearer sk-test-secret', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'stub', messages: [] }),
  timeoutMs: 500,
  maxResponseBytes: 68_096,
};

/** A real HTTP server on an ephemeral port; never a fixed or known port. */
async function withServer(
  handler: (request: Request) => Response | Promise<Response>,
  act: (url: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  try {
    await act(server.url.href);
  } finally {
    await server.stop(true);
  }
}

describe('fetch enhancement transport', () => {
  it('should return the parsed completion payload for a 2xx reply', async () => {
    // Arrange
    const transport = new FetchEnhancementTransport();
    const seen: { authorization?: string; body?: string } = {};

    // Act
    await withServer(
      async incoming => {
        seen.authorization = incoming.headers.get('authorization') ?? undefined;
        seen.body = await incoming.text();
        return Response.json({ choices: [{ message: { content: 'cleaned text' } }] });
      },
      async url => {
        const actual = await transport.send({ ...request, url });

        // Assert
        should(actual).deepEqual({
          kind: 'completion',
          payload: { choices: [{ message: { content: 'cleaned text' } }] },
        });
        should(seen.authorization).equal('Bearer sk-test-secret');
        should(seen.body).equal(request.body);
      },
    );
  });

  it('should report the status without reading the body, and carry retry-after through', async () => {
    // Arrange
    const transport = new FetchEnhancementTransport();

    // Act
    await withServer(
      () => new Response('the provider echoed the transcript here', { status: 429, headers: { 'retry-after': '2' } }),
      async url => {
        const actual = await transport.send({ ...request, url });

        // Assert
        should(actual).deepEqual({ kind: 'status', status: 429, retryAfterSeconds: 2 });
      },
    );
  });

  it('should ignore a retry-after header that is not a count of seconds', async () => {
    // Arrange
    const transport = new FetchEnhancementTransport();

    // Act
    await withServer(
      () => new Response('nope', { status: 500, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } }),
      async url => {
        const actual = await transport.send({ ...request, url });

        // Assert
        should(actual).deepEqual({ kind: 'status', status: 500 });
      },
    );
  });

  it('should report an unreadable body when a 2xx reply is not JSON', async () => {
    // Arrange
    const transport = new FetchEnhancementTransport();

    // Act
    await withServer(
      () => new Response('<html>not json</html>', { headers: { 'content-type': 'application/json' } }),
      async url => {
        const actual = await transport.send({ ...request, url });

        // Assert
        should(actual).deepEqual({ kind: 'unreadable' });
      },
    );
  });

  it('should report a timeout when the provider never answers within the budget', async () => {
    // Arrange
    const transport = new FetchEnhancementTransport();

    // Act
    await withServer(
      () => new Promise<Response>(() => undefined),
      async url => {
        const actual = await transport.send({ ...request, url, timeoutMs: 50 });

        // Assert
        should(actual).deepEqual({ kind: 'timeout' });
      },
    );
  });

  it('should report a timeout when the body stalls after the headers arrive', async () => {
    // Arrange
    const transport = new FetchEnhancementTransport();

    // Act
    await withServer(
      () =>
        new Response(
          new ReadableStream({
            async pull(controller) {
              controller.enqueue(new TextEncoder().encode('{"choices":'));
              await new Promise<never>(() => undefined);
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      async url => {
        const actual = await transport.send({ ...request, url, timeoutMs: 100 });

        // Assert
        should(actual).deepEqual({ kind: 'timeout' });
      },
    );
  });

  it('should refuse a reply that declares more bytes than the cap allows', async () => {
    // Arrange
    let bodyWasRead = false;
    const transport = new FetchEnhancementTransport(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json', 'content-length': '268435456' }),
          body: {
            getReader: () => ({
              read: async () => {
                bodyWasRead = true;
                return { done: true };
              },
              cancel: async () => undefined,
            }),
            cancel: async () => undefined,
          },
        }) as unknown as Response,
    );

    // Act
    const actual = await transport.send(request);

    // Assert
    should(actual).deepEqual({ kind: 'oversized' });
    should(bodyWasRead).be.false();
  });

  it('should stop reading a hostile reply at the cap instead of buffering it', async () => {
    // Arrange — an endless reply with no declared length, the OOM shape
    let sent = 0;
    const transport = new FetchEnhancementTransport(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              sent += 64 * 1_024;
              controller.enqueue(new Uint8Array(64 * 1_024));
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );

    // Act
    const actual = await transport.send({ ...request, maxResponseBytes: 4_096, timeoutMs: 10_000 });

    // Assert
    should(actual).deepEqual({ kind: 'oversized' });
    // The daemon never holds more than a bounded multiple of the cap
    should(sent).be.below(8 * 1_024 * 1_024);
  });

  it('should report an unreadable body when the reply has no body at all', async () => {
    // Arrange
    const transport = new FetchEnhancementTransport(
      async () => ({ ok: true, status: 200, headers: new Headers(), body: null }) as unknown as Response,
    );

    // Act
    const actual = await transport.send(request);

    // Assert
    should(actual).deepEqual({ kind: 'unreadable' });
  });

  it('should report an unreachable provider when the connection fails', async () => {
    // Arrange
    const transport = new FetchEnhancementTransport();

    // Act — port 1 on loopback refuses connections; nothing is ever bound here
    const actual = await transport.send({ ...request, url: 'http://127.0.0.1:1/v1/chat/completions' });

    // Assert
    should(actual.kind).equal('unreachable');
    should(actual.kind === 'unreachable' && actual.cause).be.ok();
  });

  it('should tolerate a response whose body cannot be cancelled', async () => {
    // Arrange
    const transport = new FetchEnhancementTransport(
      async () =>
        ({
          ok: false,
          status: 502,
          headers: new Headers(),
          body: {
            cancel: () => {
              throw new Error('already detached');
            },
          },
        }) as unknown as Response,
    );

    // Act
    const actual = await transport.send(request);

    // Assert
    should(actual).deepEqual({ kind: 'status', status: 502 });
  });

  it('should still answer oversized when the stream it cut off cannot be cancelled', async () => {
    // Arrange — a reader whose cancel throws as soon as it is called, after it has sent too much
    let cancelAttempts = 0;
    const transport = new FetchEnhancementTransport(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          body: {
            getReader: () => ({
              read: async () => ({ done: false, value: new Uint8Array(64) }),
              cancel: () => {
                cancelAttempts += 1;
                throw new Error('already detached');
              },
            }),
          },
        }) as unknown as Response,
    );

    // Act
    const actual = await transport.send({ ...request, maxResponseBytes: 16 });

    // Assert
    should(actual).deepEqual({ kind: 'oversized' });
    should(cancelAttempts).equal(1);
  });

  it('should report a bodiless error response without attempting a cancel', async () => {
    // Arrange
    const transport = new FetchEnhancementTransport();

    // Act
    await withServer(
      () => new Response(null, { status: 401 }),
      async url => {
        const actual = await transport.send({ ...request, url });

        // Assert
        should(actual).deepEqual({ kind: 'status', status: 401 });
      },
    );
  });
});

describe('fetch enhancement transport verbs', () => {
  it('should send a GET with no body when the request carries none', async () => {
    // Arrange
    const transport = new FetchEnhancementTransport();
    const seen: { method: string; body: string }[] = [];
    const { body: _body, ...bodiless } = request;

    // Act
    await withServer(
      async incoming => {
        seen.push({ method: incoming.method, body: await incoming.text() });
        return Response.json({ data: [] });
      },
      async url => {
        const actual = await transport.send({ ...bodiless, method: 'GET', url });

        // Assert
        should(actual).deepEqual({ kind: 'completion', payload: { data: [] } });
      },
    );

    // Assert
    should(seen).deepEqual([{ method: 'GET', body: '' }]);
  });
});

describe('performance stopwatch', () => {
  it('should report monotonically non-decreasing milliseconds', async () => {
    // Arrange
    const stopwatch = new PerformanceStopwatch();

    // Act
    const first = stopwatch.monotonicMs();
    const second = stopwatch.monotonicMs();

    // Assert
    should(second).be.aboveOrEqual(first);
    should(new PerformanceStopwatch(() => 42).monotonicMs()).equal(42);
  });
});
