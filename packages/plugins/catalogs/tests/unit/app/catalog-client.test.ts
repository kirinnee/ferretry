import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import { catalogClientOf, routeFor } from '../../../app/lib/catalog-client.ts';
import manifest from '../../../manifest.ts';

const calls: { route: string; init: unknown }[] = [];
const recording = (answer: unknown): Pick<PluginClient, 'call'> => ({
  call: (async (route: string, init?: unknown) => {
    calls.push({ route, init });
    return answer;
  }) as PluginClient['call'],
});

describe('the Catalogs client by route key', () => {
  it('addresses every route the manifest declares by its own key', () => {
    for (const declared of manifest.actions.routes) {
      const space = declared.key.indexOf(' ');
      const path = declared.key.slice(space + 1).replace(/:([A-Za-z]+)/gu, (_all, name: string) => `${name}-1`);
      expect(routeFor(declared.key.slice(0, space), path)?.key).toBe(declared.key);
    }
  });

  it('prefers a literal segment over a placeholder (`/store` is not a link id)', () => {
    expect(routeFor('GET', '/v1/catalog-links/store')?.key).toBe('GET /v1/catalog-links/store');
    expect(routeFor('GET', '/v1/catalog-links/lnk_x')?.key).toBe('GET /v1/catalog-links/:linkId');
  });

  it('sends params, query and a JSON body through the route key', async () => {
    calls.length = 0;
    const client = catalogClientOf(recording({ ok: true }));
    await client.request('/v1/catalogs/cat_1?sourceState=1', z.object({ ok: z.boolean() }), {
      method: 'PATCH',
      body: JSON.stringify({ name: 'x' }),
    });
    expect(calls).toEqual([
      {
        route: 'PATCH /v1/catalogs/:id',
        init: { params: { id: 'cat_1' }, query: { sourceState: '1' }, body: { name: 'x' } },
      },
    ]);
  });

  it('refuses a path no declared route matches, before anything is sent', async () => {
    calls.length = 0;
    const client = catalogClientOf(recording({}));
    await expect(client.request('/v1/terminals', z.unknown())).rejects.toThrow('declares no route');
    await expect(client.request('/v1/catalogs/cat_1/unknown', z.unknown())).rejects.toThrow('declares no route');
    expect(calls).toEqual([]);
  });

  it('reads the NAMES of secrets (a value is never listed) and nothing else beyond its own routes', async () => {
    calls.length = 0;
    const client = catalogClientOf(recording({ health: 'ready', secrets: [{ name: 'ACME' }] }));
    await client.request('/v1/secrets', z.unknown());
    expect(calls.map(call => call.route)).toEqual(['GET /v1/secrets']);
    await expect(client.request('/v1/secrets', z.unknown(), { method: 'POST', body: '{}' })).rejects.toThrow(
      'declares no route',
    );
  });
});
