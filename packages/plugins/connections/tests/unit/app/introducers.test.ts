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

  test('R88 the reconnect loop reads the machine through its held client, and has nothing to ask with none', async () => {
    const registry = new IntroducerRegistry();
    const fake = clientAnswering({ carriers: [] });

    // No client held: nothing was asked, and that is NOT an answer.
    expect(await registry.read('daemon-a')).toBe(false);
    expect(fake.calls).toEqual([]);
    registry.attach('daemon-a', fake.client);
    expect(await registry.read('daemon-a')).toBe(true);

    expect(fake.calls.map(call => call.route)).toEqual(['GET /v1/carriers']);
  });

  test('R88 a refusal from the daemon is an answer to the read; a call that got none rejects', async () => {
    const registry = new IntroducerRegistry();
    registry.attach('refusing', clientAnswering(new DaemonCallError(403, 'forbidden', 'not allowed')).client);
    registry.attach(
      'lost',
      clientAnswering(new DaemonCallError(0, 'carrier_lost', 'carrier ended', undefined, true)).client,
    );
    registry.attach('broken', clientAnswering(new Error('deadline')).client);

    expect(await registry.read('refusing')).toBe(true);
    await expect(registry.read('lost')).rejects.toThrow('carrier ended');
    await expect(registry.read('broken')).rejects.toThrow('deadline');
  });

  test('a 202 the daemon gave (a tunnel switch held for the owner) reaches the caller as a 202, not a 200', async () => {
    const registry = new IntroducerRegistry();
    const held = { held: ['the tunnel is turned on'], view: { enabled: false } };
    const calls: string[] = [];
    // As the shell's client: `call` is the body alone (the status is gone), `callWithStatus` keeps it.
    registry.attach('daemon-a', {
      call: async (route: string) => {
        calls.push(`call ${route}`);
        return held;
      },
      callWithStatus: async (route: string) => {
        calls.push(`status ${route}`);
        return { status: 202, body: held };
      },
    } as unknown as PluginClient);

    const answer = await registry.request('daemon-a')?.('/v1/tunnel', { method: 'PUT', body: '{"enabled":true}' });

    expect(answer?.status).toBe(202);
    expect(answer?.ok).toBe(true);
    expect(await answer?.json()).toEqual(held);
    expect(calls).toEqual(['status PUT /v1/tunnel']);
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
