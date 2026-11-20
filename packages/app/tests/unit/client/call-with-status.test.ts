/**
 * THE SHELL'S CALL THAT KEEPS THE STATUS (`PluginClient.callWithStatus`). `call` hands back the body alone, so a half
 * could never tell a `202` (a change held for the owner) from a `200`; this one answers `{ status, body }` through the
 * same guard, and a refusal rejects exactly as a call's does.
 */
import { describe, expect, test } from 'bun:test';
import { DaemonClient } from '../../../src/client/daemon-client.ts';
import { DaemonCallError, type TransportAnswer, type TransportRequest } from '../../../src/client/transport.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from './fixtures.ts';

const tunnel = surface('connections', { routes: ['PUT /v1/tunnel'] });
const compiled = [...CORE, tunnel];

async function started(answer: (request: TransportRequest) => TransportAnswer) {
  const transport = new FakeTransport(request => {
    if (request.path === '/v1/plugins') return json(inventoryOf(compiled));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    return answer(request);
  });
  const client = new DaemonClient({ transport, surfaces: compiled });
  await client.start();
  return client.forPackage('connections');
}

describe('the shell client offers a call that keeps the status', () => {
  test('a 202 is told as a 202, with its body; call still hands back the body alone', async () => {
    const held = { held: ['the tunnel is turned on'], view: { enabled: false } };
    const connections = await started(() => json(held, 202));
    expect(await connections.callWithStatus?.('PUT /v1/tunnel', { body: { enabled: true } })).toEqual({
      status: 202,
      body: held,
    });
    expect(await connections.call('PUT /v1/tunnel', { body: { enabled: true } })).toEqual(held);
  });

  test('a 200 is told as a 200', async () => {
    const connections = await started(() => json({ enabled: true }));
    expect(await connections.callWithStatus?.('PUT /v1/tunnel')).toEqual({ status: 200, body: { enabled: true } });
  });

  test('a refusal rejects as a call’s does', async () => {
    const connections = await started(() => json({ error: 'no', code: 'grant_forbidden' }, 403));
    const failure = await connections.callWithStatus?.('PUT /v1/tunnel').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DaemonCallError);
    expect((failure as DaemonCallError).status).toBe(403);
  });
});
