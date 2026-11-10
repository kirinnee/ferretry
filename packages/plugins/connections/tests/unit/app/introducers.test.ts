/**
 * The router's one way of asking a machine anything (`app/lib/introducers.ts`): three carrier-control routes through the
 * client a half of Connections holds, answered as the daemon answered, and nothing else.
 */
import { describe, expect, test } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { IntroducerRegistry } from '../../../app/lib/introducers.ts';

interface Call {
  readonly route: string;
  readonly init: { readonly body?: unknown; readonly signal?: AbortSignal } | undefined;
}

function clientAnswering(answer: unknown | Error) {
  const calls: Call[] = [];
  const client = {
    call: async (route: string, init?: Call['init']) => {
      calls.push({ route, init });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as PluginClient;
  return { client, calls };
}

describe('the clients the router asks through', () => {
  test('R636 a client is held per daemon until released, and a later one for the same daemon replaces it', () => {
    const registry = new IntroducerRegistry();
    const first = clientAnswering({}).client;
    const second = clientAnswering({}).client;

    expect(registry.request('daemon-a')).toBeUndefined();
    const releaseFirst = registry.attach('daemon-a', first);
    expect(registry.request('daemon-a')).toBeDefined();
    const releaseSecond = registry.attach('daemon-a', second);
    // Releasing the replaced client leaves the one that replaced it in place.
    releaseFirst();
    expect(registry.request('daemon-a')).toBeDefined();
    releaseSecond();
    expect(registry.request('daemon-a')).toBeUndefined();
  });

  test('R636 the tunnel read and the WebRTC offer are the daemon’s answers, carried as a response', async () => {
    const registry = new IntroducerRegistry();
    const fake = clientAnswering({ state: 'up' });
    registry.attach('daemon-a', fake.client);
    const abort = new AbortController();

    const read = await registry.request('daemon-a')?.('/v1/tunnel', { cache: 'no-store', signal: abort.signal });
    const offer = await registry.request('daemon-a')?.('/v1/webrtc/offer', {
      method: 'post',
      body: JSON.stringify({ sdp: 'offer' }),
    });

    expect(read?.status).toBe(200);
    expect(await read?.json()).toEqual({ state: 'up' });
    expect(offer?.status).toBe(200);
    expect(fake.calls.map(call => call.route)).toEqual(['GET /v1/tunnel', 'POST /v1/webrtc/offer']);
    expect(fake.calls[0]?.init?.signal).toBe(abort.signal);
    expect(fake.calls[0]?.init?.body).toBeUndefined();
    expect(fake.calls[1]?.init?.body).toEqual({ sdp: 'offer' });
  });

  test('R636 a refusal is the daemon’s answer with its status and sentence; a call that got no answer rejects', async () => {
    const registry = new IntroducerRegistry();
    registry.attach('refusing', clientAnswering(new DaemonCallError(409, 'webrtc_busy', 'WebRTC is busy')).client);
    registry.attach(
      'outage',
      clientAnswering(new DaemonCallError(0, 'carrier_outage', 'carrier ended', undefined, true)).client,
    );
    registry.attach('broken', clientAnswering(new Error('boom')).client);

    const refused = await registry.request('refusing')?.('/v1/webrtc/offer', { method: 'POST', body: '{}' });
    expect(refused?.status).toBe(409);
    expect(await refused?.json()).toEqual({ error: 'WebRTC is busy', code: 'webrtc_busy' });
    await expect(registry.request('outage')?.('/v1/tunnel')).rejects.toThrow('carrier ended');
    await expect(registry.request('broken')?.('/v1/tunnel')).rejects.toThrow('boom');
  });

  test('R636 only carrier-control routes can be asked: no other path or method becomes a way around the session', async () => {
    const registry = new IntroducerRegistry();
    const fake = clientAnswering({});
    registry.attach('daemon-a', fake.client);
    const ask = registry.request('daemon-a');

    await expect(ask?.('/v1/carriers')).rejects.toThrow('only carrier-control routes');
    await expect(ask?.('/v1/webrtc/offer')).rejects.toThrow('only carrier-control routes');
    await expect(ask?.('/v1/tunnel', { method: 'DELETE' })).rejects.toThrow('only carrier-control routes');
    await expect(ask?.('/v1/projects', { method: 'POST', body: '{}' })).rejects.toThrow('only carrier-control routes');
    expect(fake.calls).toEqual([]);
  });
});
