/**
 * The check's transports against fake MCP servers on this machine: a command speaking stdio, a
 * Streamable HTTP endpoint (JSON and event-stream answers, a session id, paged tools), a legacy SSE
 * server, and the failures a person must be able to tell apart — a 401, a server that never answers,
 * a command that is not there, and one that dies saying why.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { TransportMcpProbe } from '../../../src/adapters/mcp-inventory/index.ts';
import { McpProbeFailure } from '../../../src/lib/mcp-inventory/index.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const probe = new TransportMcpProbe();
const deadline = (ms = 5_000) => AbortSignal.timeout(ms);

async function failureOf(work: Promise<unknown>): Promise<McpProbeFailure> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof McpProbeFailure)) throw new Error(`expected a probe failure, got ${String(error)}`);
  return error;
}

type Rpc = { id?: number; method: string; params?: { cursor?: string } };

/** What a tiny MCP server answers, shared by every transport below. */
function answer(message: Rpc): unknown {
  if (message.method === 'initialize')
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake' }, capabilities: {} },
    };
  if (message.method === 'tools/list')
    return message.params?.cursor === 'p2'
      ? { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'third' }] } }
      : {
          jsonrpc: '2.0',
          id: message.id,
          result: { tools: [{ name: 'first' }, { name: 'second' }], nextCursor: 'p2' },
        };
  return undefined;
}

async function script(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-mcp-probe-'));
  cleanups.push(async () => await rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'server.ts');
  await writeFile(file, source);
  return file;
}

function serve(handler: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  cleanups.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

describe('the MCP check transports', () => {
  it('should open a session with a command over stdio and list every page of its tools', async () => {
    // Arrange — the server reads its greeting from the environment the check hands it.
    const file = await script(`
      const answer = ${answer.toString()};
      let buffer = '';
      process.stdin.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split('\\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.trim() === '') continue;
          const message = JSON.parse(line);
          const reply = answer(message);
          if (reply !== undefined) {
            if (message.method === 'initialize') reply.result.serverInfo.name = process.env.GREETING;
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message' }) + '\\n');
            process.stdout.write(JSON.stringify(reply) + '\\n');
          }
        }
      });
    `);

    // Act
    const result = await probe.probe(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [file],
        env: { PATH: process.env.PATH ?? '', GREETING: 'from-env' },
      },
      deadline(),
    );

    // Assert
    should(result).deepEqual({ serverName: 'from-env', tools: ['first', 'second', 'third'] });
  });

  it('should say a command that is not installed could not be started', async () => {
    // Act
    const failure = await failureOf(
      probe.probe({ transport: 'stdio', command: 'fy-no-such-mcp-server', args: [], env: {} }, deadline()),
    );

    // Assert
    should(failure.kind).equal('unreachable');
    should(failure.message).match(/could not be started/u);
  });

  it('should say a command stopped before it answered, with the last thing it printed', async () => {
    // Arrange
    const file = await script(`console.error('loading config'); console.error('API_KEY is not set'); process.exit(3);`);

    // Act
    const failure = await failureOf(
      probe.probe(
        { transport: 'stdio', command: process.execPath, args: [file], env: { PATH: process.env.PATH ?? '' } },
        deadline(),
      ),
    );

    // Assert
    should(failure.kind).equal('unreachable');
    should(failure.message).match(/stopped \(exit code 3\) before it answered\. It said: “API_KEY is not set”/u);
  });

  it('should time out a command that never answers, and stop it', async () => {
    // Arrange
    const file = await script(`setInterval(() => {}, 1000);`);

    // Act
    const failure = await failureOf(
      probe.probe(
        { transport: 'stdio', command: process.execPath, args: [file], env: { PATH: process.env.PATH ?? '' } },
        deadline(400),
      ),
    );

    // Assert
    should(failure.kind).equal('timeout');
  });

  it('should open a Streamable HTTP session, carrying its session id and the headers it was given', async () => {
    // Arrange — the first answer is JSON, the later ones an event stream, as a server may choose.
    const seen: { session: string | null; authorization: string | null; method: string }[] = [];
    const origin = serve(async request => {
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      const message = (await request.json()) as Rpc;
      seen.push({
        session: request.headers.get('mcp-session-id'),
        authorization: request.headers.get('authorization'),
        method: message.method,
      });
      const reply = answer(message);
      if (reply === undefined) return new Response(null, { status: 202 });
      if (message.method === 'initialize') return Response.json(reply, { headers: { 'mcp-session-id': 'sess-1' } });
      return new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    // Act
    const result = await probe.probe(
      { transport: 'http', url: `${origin}/mcp`, headers: { Authorization: 'Bearer test-token' } },
      deadline(),
    );

    // Assert
    should(result).deepEqual({ serverName: 'fake', tools: ['first', 'second', 'third'] });
    should(seen.map(entry => entry.method)).deepEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/list',
    ]);
    should(seen.slice(1).every(entry => entry.session === 'sess-1')).be.true();
    should(seen.every(entry => entry.authorization === 'Bearer test-token')).be.true();
  });

  it('should read a 401 as needing a sign-in, and a 404 as the wrong address', async () => {
    // Arrange
    const locked = serve(() => new Response('no', { status: 401, headers: { 'www-authenticate': 'Bearer' } }));
    const missing = serve(() => new Response('no', { status: 404 }));

    // Act
    const unauthorized = await failureOf(
      probe.probe({ transport: 'http', url: `${locked}/mcp`, headers: {} }, deadline()),
    );
    const notFound = await failureOf(
      probe.probe({ transport: 'http', url: `${missing}/mcp`, headers: {} }, deadline()),
    );

    // Assert
    should(unauthorized).containEql({ kind: 'unauthorized', message: 'It answered 401.' });
    should(notFound.kind).equal('protocol');
    should(notFound.message).match(/HTTP 404 — is this the MCP endpoint/u);
  });

  it('should say an endpoint that redirects moved, rather than follow it', async () => {
    // Arrange
    const origin = serve(
      () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/elsewhere' } }),
    );

    // Act
    const failure = await failureOf(probe.probe({ transport: 'http', url: `${origin}/mcp`, headers: {} }, deadline()));

    // Assert
    should(failure.kind).equal('protocol');
    should(failure.message).equal('It redirected (HTTP 302); use the address it moved to.');
  });

  it('should say nothing answered at a host with no server', async () => {
    // Arrange — a port that was just free.
    const origin = serve(() => new Response());
    const closed = cleanups.pop();
    await closed?.();

    // Act
    const failure = await failureOf(probe.probe({ transport: 'http', url: `${origin}/mcp`, headers: {} }, deadline()));

    // Assert
    should(failure.kind).equal('unreachable');
    should(failure.message).startWith('Nothing answered at 127.0.0.1:');
  });

  it('should time out an HTTP server that never answers', async () => {
    // Arrange
    // Answers only once the prober has given up, so it is "never answers" however fast the machine is.
    const origin = serve(async request => {
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
      return new Response();
    });

    // Act
    const failure = await failureOf(
      probe.probe({ transport: 'http', url: `${origin}/mcp`, headers: {} }, deadline(300)),
    );

    // Assert
    should(failure.kind).equal('timeout');
  });

  it('should open a legacy SSE session: the endpoint event, posts there, answers on the stream', async () => {
    // Arrange
    let push: ((text: string) => void) | undefined;
    const origin = serve(async request => {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/sse') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            push = text => controller.enqueue(encoder.encode(text));
            push('event: endpoint\ndata: /messages?session=abc\n\n');
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      const reply = answer((await request.json()) as Rpc);
      if (reply !== undefined) queueMicrotask(() => push?.(`event: message\ndata: ${JSON.stringify(reply)}\n\n`));
      return new Response('Accepted', { status: 202 });
    });

    // Act
    const result = await probe.probe({ transport: 'sse', url: `${origin}/sse`, headers: {} }, deadline());

    // Assert
    should(result).deepEqual({ serverName: 'fake', tools: ['first', 'second', 'third'] });
  });

  it('should read an SSE stream refused with 401 as needing a sign-in', async () => {
    // Arrange
    const origin = serve(() => new Response('no', { status: 401 }));

    // Act
    const failure = await failureOf(probe.probe({ transport: 'sse', url: `${origin}/sse`, headers: {} }, deadline()));

    // Assert
    should(failure.kind).equal('unauthorized');
  });

  it('should refuse an SSE endpoint on another host, so the headers stay with the server they were for', async () => {
    // Arrange
    const origin = serve(
      () =>
        new Response('event: endpoint\ndata: https://elsewhere.example/messages\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    // Act
    const failure = await failureOf(probe.probe({ transport: 'sse', url: `${origin}/sse`, headers: {} }, deadline()));

    // Assert
    should(failure.message).match(/another host/u);
  });
});
