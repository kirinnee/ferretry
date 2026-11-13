/**
 * The transport under `kernel.secrets.send`, against a real HTTP server on the loopback interface. It reports facts
 * only (a status, a payload, a size, a timeout): never the request, an error or its message. The server here answers as
 * a provider might misbehave; no name or key leaves this machine.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Clock, FetchPort } from '../../../contract/ports.ts';
import type { OutboundSecretRequest } from '../../../contract/secrets.ts';
import { outboundSecretTransport } from '../../../host/adapters/outbound-secret.ts';

const encoder = new TextEncoder();
let server: ReturnType<typeof Bun.serve>;
const seen: { auth?: string | null; method?: string; body?: string; redirectFollowed?: boolean }[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname;
      seen.push({ auth: request.headers.get('authorization'), method: request.method, body: await request.text() });
      switch (path) {
        case '/ok':
          return Response.json({ answer: 42 });
        case '/bad-json':
          return new Response('this is not json');
        case '/limited':
          return new Response('slow down', { status: 429, headers: { 'retry-after': ' 7 ' } });
        case '/broken':
          return new Response('oops', { status: 500 });
        case '/odd-retry':
          return new Response('later', { status: 503, headers: { 'retry-after': 'next tuesday' } });
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
          await new Promise(resolve => setTimeout(resolve, 3_000));
          return new Response('too late');
        case '/stalls-mid-body':
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode('{"half":'));
              },
            }),
          );
        case '/dies-mid-body':
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode('{"half":'));
                setTimeout(() => controller.error(new Error('the provider hung up')), 20);
              },
            }),
          );
        case '/redirects':
          return new Response(null, { status: 302, headers: { location: '/ok' } });
        default:
          return new Response('no such path', { status: 404 });
      }
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

const real: FetchPort = { request: async (url, init) => await fetch(url, init) };
const clock = {
  after: (delay: number, fn: () => void) => {
    const handle = setTimeout(fn, delay);
    return () => clearTimeout(handle);
  },
} as unknown as Clock;
const transport = outboundSecretTransport(real, clock);

const ask = (path: string, extra: Partial<OutboundSecretRequest> = {}): OutboundSecretRequest => ({
  method: 'GET',
  url: `http://127.0.0.1:${String(server.port)}${path}`,
  headers: {},
  timeoutMs: 2_000,
  maxResponseBytes: 1_000,
  ...extra,
});

describe('the outbound secret transport against a real loopback server', () => {
  test('a good reply is the status and the parsed payload, and the request carries its headers and body', async () => {
    seen.length = 0;
    const outcome = await transport.send(
      ask('/ok', { method: 'POST', body: '{"q":1}', headers: { authorization: 'Bearer loopback-fixture' } }),
    );

    expect(outcome).toEqual({ kind: 'completion', status: 200, payload: { answer: 42 } });
    expect(seen[0]).toEqual({ auth: 'Bearer loopback-fixture', method: 'POST', body: '{"q":1}' });
  });

  test('a reply that is not JSON is unreadable, never an error carrying its text', async () => {
    expect(await transport.send(ask('/bad-json'))).toEqual({ kind: 'unreadable' });
  });

  test('a failing status is a status, with the provider’s wait when it gave a number and none when it gave words', async () => {
    expect(await transport.send(ask('/limited'))).toEqual({ kind: 'status', status: 429, retryAfterSeconds: 7 });
    expect(await transport.send(ask('/broken'))).toEqual({ kind: 'status', status: 500 });
    expect(await transport.send(ask('/odd-retry'))).toEqual({ kind: 'status', status: 503 });
  });

  test('a redirect is not followed: it is a status, so a key is never re-sent to where it points', async () => {
    expect(await transport.send(ask('/redirects'))).toEqual({ kind: 'status', status: 302 });
  });

  test('a reply that declares itself larger than the ceiling is refused without being read', async () => {
    expect(await transport.send(ask('/declared-big'))).toEqual({ kind: 'too_large' });
  });

  test('a reply that crosses the ceiling while streaming is cut off', async () => {
    expect(await transport.send(ask('/streamed-big'))).toEqual({ kind: 'too_large' });
  });

  test('a reply with no body is unreadable', async () => {
    expect(await transport.send(ask('/empty'))).toEqual({ kind: 'unreadable' });
  });

  test('a provider that never answers is a timeout, and the request is aborted', async () => {
    expect(await transport.send(ask('/hang', { timeoutMs: 100 }))).toEqual({ kind: 'timeout' });
  });

  test('a body that stalls half way is a timeout, and one that breaks half way is unreadable', async () => {
    expect(await transport.send(ask('/stalls-mid-body', { timeoutMs: 150 }))).toEqual({ kind: 'timeout' });
    expect(await transport.send(ask('/dies-mid-body'))).toEqual({ kind: 'unreadable' });
  });

  test('a body that cannot even be released is still released without a throw', async () => {
    // A hostile provider's stream whose cancel throws at once: the transport still answers, and never waits on it.
    const hostileBody = {
      cancel: () => {
        throw new Error('cancel is not available');
      },
      getReader: () => ({
        read: async () => {
          throw new Error('the stream broke');
        },
        cancel: () => {
          throw new Error('cancel is not available');
        },
      }),
    };
    const hostile = outboundSecretTransport(
      {
        request: async (_url, init) =>
          init?.method === 'POST'
            ? ({ ok: false, status: 502, headers: new Headers(), body: hostileBody } as unknown as Response)
            : ({ ok: true, status: 200, headers: new Headers(), body: hostileBody } as unknown as Response),
      },
      clock,
    );

    const broken = await hostile.send(ask('/ok'));
    const refused = await hostile.send(ask('/ok', { method: 'POST' }));

    expect(broken).toEqual({ kind: 'unreadable' });
    expect(refused).toEqual({ kind: 'status', status: 502 });
  });

  test('a host that cannot be reached is a network failure, carrying nothing of the error', async () => {
    const outcome = await transport.send(ask('/ok', { url: 'http://127.0.0.1:1/ok' }));

    expect(outcome).toEqual({ kind: 'network' });
  });
});
