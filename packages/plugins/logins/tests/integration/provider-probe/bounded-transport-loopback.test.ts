/**
 * The bounded transport behind a keyless local read, against a real HTTP server on the loopback interface answering as
 * a misbehaving local server might. It reports facts only: a status, a payload, a size, a timeout.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import should from 'should';
import { BoundedTransport } from '../../../daemon/adapters/provider-probe/bounded-transport.ts';
import { realClock, realFetch } from '../../support/real-ports.ts';

const encoder = new TextEncoder();
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      switch (new URL(request.url).pathname) {
        case '/ok':
          return Response.json({ models: ['a'] }, { headers: { 'x-echo': await request.text() } });
        case '/bad-json':
          return new Response('not json');
        case '/limited':
          return new Response('slow', { status: 429, headers: { 'retry-after': '9' } });
        case '/broken':
          return new Response('oops', { status: 500, headers: { 'retry-after': 'soon' } });
        case '/declared-big':
          return new Response('x'.repeat(2_000), { headers: { 'content-length': '2000' } });
        case '/streamed-big':
          return new Response(
            new ReadableStream({
              start(controller) {
                for (let i = 0; i < 20; i += 1) controller.enqueue(encoder.encode('y'.repeat(100)));
                controller.close();
              },
            }),
          );
        case '/empty':
          return new Response(null, { status: 204 });
        case '/hang':
          return await new Promise<Response>(() => undefined);
        case '/stalls':
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode('{"half":'));
              },
            }),
          );
        case '/dies':
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode('{"half":'));
                setTimeout(() => controller.error(new Error('hung up')), 20);
              },
            }),
          );
        default:
          return new Response('no', { status: 404 });
      }
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

const transport = new BoundedTransport(realFetch, realClock);
const ask = (path: string, extra: { timeoutMs?: number; maxResponseBytes?: number; url?: string } = {}) => ({
  method: 'GET' as const,
  url: extra.url ?? `http://127.0.0.1:${String(server.port)}${path}`,
  headers: {},
  timeoutMs: extra.timeoutMs ?? 2_000,
  maxResponseBytes: extra.maxResponseBytes ?? 1_000,
});

describe('the bounded transport against a real local server', () => {
  it('should hand back the parsed payload of a good reply, sending the request body it was given', async () => {
    should(await transport.send({ ...ask('/ok'), method: 'POST', body: '{"q":1}' })).deepEqual({
      kind: 'completion',
      payload: { models: ['a'] },
    });
  });

  it('should call a reply that is not JSON, or has no body, unreadable', async () => {
    should(await transport.send(ask('/bad-json'))).deepEqual({ kind: 'unreadable' });
    should(await transport.send(ask('/empty'))).deepEqual({ kind: 'unreadable' });
  });

  it('should report a failing status with the wait only when the server gave a number', async () => {
    should(await transport.send(ask('/limited'))).deepEqual({ kind: 'status', status: 429, retryAfterSeconds: 9 });
    should(await transport.send(ask('/broken'))).deepEqual({ kind: 'status', status: 500 });
  });

  it('should refuse a reply over the ceiling, declared or discovered while streaming', async () => {
    should(await transport.send(ask('/declared-big'))).deepEqual({ kind: 'oversized' });
    should(await transport.send(ask('/streamed-big'))).deepEqual({ kind: 'oversized' });
  });

  it('should report a server that never answers, or stalls half way, as a timeout', async () => {
    should(await transport.send(ask('/hang', { timeoutMs: 100 }))).deepEqual({ kind: 'timeout' });
    should(await transport.send(ask('/stalls', { timeoutMs: 150 }))).deepEqual({ kind: 'timeout' });
  });

  it('should report a body that breaks half way as unreadable, and nobody listening as unreachable', async () => {
    should(await transport.send(ask('/dies'))).deepEqual({ kind: 'unreadable' });
    should(await transport.send(ask('/ok', { url: 'http://127.0.0.1:1/ok' }))).deepEqual({ kind: 'unreachable' });
  });

  it('should release a body that cannot even be cancelled without throwing', async () => {
    const hostileBody = {
      cancel: () => {
        throw new Error('no cancel');
      },
      getReader: () => ({
        read: async () => {
          throw new Error('broke');
        },
        cancel: () => {
          throw new Error('no cancel');
        },
      }),
    };
    const hostile = new BoundedTransport(
      {
        request: async (_url, init) =>
          ({
            ok: init?.method !== 'POST',
            status: 502,
            headers: new Headers(),
            body: hostileBody,
          }) as unknown as Response,
      },
      realClock,
    );

    should(await hostile.send(ask('/ok'))).deepEqual({ kind: 'unreadable' });
    should(await hostile.send({ ...ask('/ok'), method: 'POST' })).deepEqual({ kind: 'status', status: 502 });
  });
});
