import { describe, expect, test } from 'bun:test';
import type { PluginCallHeaders } from '@ferretry/kernel/manifest';
import { DaemonClient } from '../../../src/client/daemon-client.ts';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from './fixtures.ts';

const ferrets = surface('ferrets', { core: true, routes: ['POST /v1/ferrets/:ferretId/move'] });
const runtimes = surface('runtimes', {});
const compiled = [...CORE.filter(entry => entry.id !== 'ferrets'), ferrets, runtimes];

function daemon() {
  const transport = new FakeTransport((request: TransportRequest) => {
    if (request.path === '/v1/plugins') return json(inventoryOf(compiled));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    return json({ id: 'f-1' });
  });
  return { transport, client: new DaemonClient({ transport, surfaces: compiled }) };
}

describe('the headers a plugin half may send', () => {
  test('R-0355 x-fy-request-id reaches the daemon, so a move Ferrets requires it for is not refused', async () => {
    const { transport, client } = daemon();
    await client.start();
    await client.forPackage('runtimes').call('POST /v1/ferrets/:ferretId/move', {
      params: { ferretId: 'f-1' },
      body: {},
      headers: { 'x-fy-request-id': 'req-1' },
    });
    const sent = transport.requests.find(request => request.path === '/v1/ferrets/f-1/move');
    expect(sent?.headers).toEqual({ 'x-fy-request-id': 'req-1' });
  });

  test('any header outside the allow-list is dropped, and a call with none sends none', async () => {
    const { transport, client } = daemon();
    await client.start();
    // A variable, not a literal: the type allows only x-fy-request-id, and this proves the runtime drops the rest too.
    const headers = { 'x-fy-request-id': 'req-2', authorization: 'Bearer forged', cookie: 'a=b' };
    const half = client.forPackage('runtimes');
    await half.call('POST /v1/ferrets/:ferretId/move', { params: { ferretId: 'f-2' }, body: {}, headers });
    await half.call('POST /v1/ferrets/:ferretId/move', { params: { ferretId: 'f-3' }, body: {} });
    expect(transport.requests.find(request => request.path === '/v1/ferrets/f-2/move')?.headers).toEqual({
      'x-fy-request-id': 'req-2',
    });
    expect(transport.requests.find(request => request.path === '/v1/ferrets/f-3/move')?.headers).toBeUndefined();
  });
});

describe('the agenda channel header', () => {
  test('x-fy-agenda-channel: 2 crosses, beside the request id', async () => {
    const { transport, client } = daemon();
    await client.start();
    await client.forPackage('runtimes').call('POST /v1/ferrets/:ferretId/move', {
      params: { ferretId: 'f-4' },
      body: {},
      headers: { 'x-fy-agenda-channel': '2', 'x-fy-request-id': 'req-4' },
    });
    expect(transport.requests.find(request => request.path === '/v1/ferrets/f-4/move')?.headers).toEqual({
      'x-fy-request-id': 'req-4',
      'x-fy-agenda-channel': '2',
    });
  });

  test('a channel value outside the list is dropped, and so is every unknown header', async () => {
    const { transport, client } = daemon();
    await client.start();
    // Variables, not literals: the type allows only the two names and the one value, and this proves the runtime too.
    const wrongValue = { 'x-fy-agenda-channel': '1' } as unknown as PluginCallHeaders;
    const unknown = {
      'x-fy-agenda-channel': '2',
      'x-fy-other': 'yes',
      authorization: 'Bearer forged',
    } as PluginCallHeaders;
    const half = client.forPackage('runtimes');
    await half.call('POST /v1/ferrets/:ferretId/move', { params: { ferretId: 'f-5' }, body: {}, headers: wrongValue });
    await half.call('POST /v1/ferrets/:ferretId/move', { params: { ferretId: 'f-6' }, body: {}, headers: unknown });
    expect(transport.requests.find(request => request.path === '/v1/ferrets/f-5/move')?.headers).toBeUndefined();
    expect(transport.requests.find(request => request.path === '/v1/ferrets/f-6/move')?.headers).toEqual({
      'x-fy-agenda-channel': '2',
    });
  });
});
