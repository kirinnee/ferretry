/**
 * The MCP sign-in's network, against a real HTTP server on the loopback interface: no redirect followed, the body
 * bounded, and a failure named by its kind only, never by the address.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { FetchPort } from '@ferretry/kernel/contract';
import { FetchMcpOAuthHttp } from '../../daemon/adapters/oauth-http.ts';
import { McpOAuthUnreachable } from '../../daemon/lib/oauth/ports.ts';

let server: ReturnType<typeof Bun.serve>;
const seen: { method: string; header: string | null; body: string }[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname;
      seen.push({ method: request.method, header: request.headers.get('x-probe'), body: await request.text() });
      if (path === '/redirect') return new Response(null, { status: 302, headers: { location: '/ok' } });
      if (path === '/huge') return new Response('x'.repeat(300 * 1024));
      if (path === '/empty') return new Response(null, { status: 204 });
      if (path === '/missing') return new Response('nope', { status: 404, headers: { 'x-why': 'absent' } });
      return new Response('{"token_endpoint":"https://auth.example.test/token"}', {
        headers: { 'x-why': 'fine' },
      });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

const real: FetchPort = { request: async (url, init) => await fetch(url, init) };
const http = new FetchMcpOAuthHttp(real);
const url = (path: string): string => `http://127.0.0.1:${String(server.port)}${path}`;

describe('the MCP sign-in network on loopback', () => {
  test('a GET answers its status, headers and text', async () => {
    const answer = await http.request({ method: 'GET', url: url('/ok') });

    expect(answer.status).toBe(200);
    expect(answer.header('x-why')).toBe('fine');
    expect(answer.header('x-absent')).toBeUndefined();
    expect(answer.text).toBe('{"token_endpoint":"https://auth.example.test/token"}');
  });

  test('a POST carries its headers and body to the server', async () => {
    seen.length = 0;

    await http.request({ method: 'POST', url: url('/ok'), headers: { 'x-probe': 'p1' }, body: 'grant_type=x' });

    expect(seen).toEqual([{ method: 'POST', header: 'p1', body: 'grant_type=x' }]);
  });

  test('a redirect is answered as itself and never followed', async () => {
    seen.length = 0;

    const answer = await http.request({ method: 'GET', url: url('/redirect') });

    expect(answer.status).toBe(302);
    expect(answer.header('location')).toBe('/ok');
    expect(seen.map(entry => entry.method)).toEqual(['GET']);
  });

  test('an error status and an empty body are answers too', async () => {
    expect((await http.request({ method: 'GET', url: url('/missing') })).status).toBe(404);
    expect(await http.request({ method: 'GET', url: url('/empty') })).toMatchObject({ status: 204, text: '' });
  });

  test('a body over 256 KiB is refused by a short code', async () => {
    const failure = await http.request({ method: 'GET', url: url('/huge') }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpOAuthUnreachable);
    expect((failure as McpOAuthUnreachable).reason).toBe('RESPONSE_TOO_LARGE');
  });

  test('a host that refuses the connection is named by the runtime’s code, never by its address', async () => {
    const failure = await http
      .request({ method: 'GET', url: 'http://127.0.0.1:1/secret?code=abc' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpOAuthUnreachable);
    expect((failure as McpOAuthUnreachable).message).not.toContain('abc');
    expect((failure as McpOAuthUnreachable).message).not.toContain('127.0.0.1');
  });

  test('a request that outlives its deadline is a TIMEOUT, and an error without a code is UNKNOWN', async () => {
    const timesOut = new FetchMcpOAuthHttp({
      request: async () => {
        throw new DOMException('the operation timed out', 'TimeoutError');
      },
    });
    const strange = new FetchMcpOAuthHttp({
      request: async () => {
        throw 'not even an error';
      },
    });

    await expect(timesOut.request({ method: 'GET', url: url('/ok') })).rejects.toMatchObject({ reason: 'TIMEOUT' });
    await expect(strange.request({ method: 'GET', url: url('/ok') })).rejects.toMatchObject({ reason: 'UNKNOWN' });
  });
});
