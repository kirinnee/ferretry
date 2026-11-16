/**
 * THE SHELL'S CONDITIONAL GET (`PluginClient.conditional`). The page sends the etag it holds as `If-None-Match`, a `304`
 * is told as one (the caller holds the body), a `200` carries the etag the daemon named it by, and the guard, the
 * allow-listed headers and the refusals are the call's own. Without it the app re-read every polled document whole.
 */
import { describe, expect, test } from 'bun:test';
import { DaemonClient } from '../../../src/client/daemon-client.ts';
import { DaemonCallError, type TransportAnswer, type TransportRequest } from '../../../src/client/transport.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from './fixtures.ts';

const sends = surface('conversation', { routes: ['GET /v1/ferrets/:ferretId/sends'] });
const compiled = [...CORE, sends];

const answer = (status: number, headers: Record<string, string>, body: unknown): TransportAnswer => ({
  status,
  headers,
  body,
});

async function started(read: (request: TransportRequest) => TransportAnswer) {
  const transport = new FakeTransport(request => {
    if (request.path === '/v1/plugins') return json(inventoryOf(compiled));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    return read(request);
  });
  const client = new DaemonClient({ transport, surfaces: compiled });
  await client.start();
  const package_ = client.forPackage('conversation');
  const conditional = package_.conditional;
  if (conditional === undefined) throw new Error('the shell client offers no conditional read');
  return { transport, conditional: conditional.bind(package_) };
}

const ROUTE = 'GET /v1/ferrets/:ferretId/sends';

describe('the shell client offers a conditional read', () => {
  test('sends the held etag as If-None-Match and tells a 304 without a body', async () => {
    const { transport, conditional } = await started(() => answer(304, { etag: '"abc"' }, ''));
    const read = await conditional(ROUTE, { ferretId: 'f1' }, { ifNoneMatch: '"abc"' });
    expect(read).toEqual({ status: 304, etag: '"abc"' });
    expect(transport.requests.at(-1)).toMatchObject({
      method: 'GET',
      path: '/v1/ferrets/f1/sends',
      headers: { 'if-none-match': '"abc"' },
    });
  });

  test('tells a 200 with the etag the daemon named it by, and sends no If-None-Match when it holds none', async () => {
    const { transport, conditional } = await started(() => answer(200, { ETag: '"v2"' }, { sends: [] }));
    expect(await conditional(ROUTE, { ferretId: 'f1' })).toEqual({ status: 200, etag: '"v2"', body: { sends: [] } });
    expect(transport.requests.at(-1)?.headers).toBeUndefined();
  });

  test('tells a 200 that named no etag, and a 304 that named none, as they are', async () => {
    const { conditional } = await started(request =>
      request.headers?.['if-none-match'] === undefined ? answer(200, {}, { sends: [] }) : answer(304, {}, ''),
    );
    expect(await conditional(ROUTE, { ferretId: 'f1' })).toEqual({ status: 200, body: { sends: [] } });
    expect(await conditional(ROUTE, { ferretId: 'f1' }, { ifNoneMatch: '"x"' })).toEqual({ status: 304 });
  });

  test('carries the query and the allow-listed headers, and only those', async () => {
    const { transport, conditional } = await started(() => answer(200, {}, {}));
    await conditional(
      ROUTE,
      { ferretId: 'f1' },
      {
        ifNoneMatch: '"x"',
        query: { limit: '1' },
        headers: { 'x-fy-agenda-channel': '2', 'x-evil': 'no' } as never,
      },
    );
    expect(transport.requests.at(-1)).toMatchObject({
      query: { limit: '1' },
      headers: { 'if-none-match': '"x"', 'x-fy-agenda-channel': '2' },
    });
    expect(transport.requests.at(-1)?.headers).not.toHaveProperty('x-evil');
  });

  test('a refusal is the call’s own refusal, and a route no manifest declares is refused unsent', async () => {
    const { transport, conditional } = await started(() =>
      answer(404, {}, { error: 'No such ferret.', code: 'not_found' }),
    );
    const refusal = await conditional(ROUTE, { ferretId: 'f1' }).catch(error => error);
    expect(refusal).toBeInstanceOf(DaemonCallError);
    expect(refusal).toMatchObject({ status: 404, code: 'not_found' });

    const sent = transport.requests.length;
    await expect(conditional('GET /v1/nothing', {})).rejects.toThrow('which no compiled manifest declares');
    expect(transport.requests.length).toBe(sent);
  });
});
