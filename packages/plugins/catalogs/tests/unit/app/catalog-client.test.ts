import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import {
  catalogClientOf,
  machineCatalogClient,
  NO_MACHINE_SENTENCE,
  routeFor,
} from '../../../app/lib/catalog-client.ts';
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

describe('N2 the client refuses what it cannot carry instead of dropping it', () => {
  it('throws on a header other than content-type and on a body that is not a string, sending nothing', async () => {
    calls.length = 0;
    const client = catalogClientOf(recording({}));
    await expect(
      client.request('/v1/catalogs/cat_1', z.unknown(), { method: 'PATCH', headers: { 'if-match': 'v1' }, body: '{}' }),
    ).rejects.toThrow('cannot carry the request header if-match');
    await expect(
      client.request('/v1/catalogs/cat_1', z.unknown(), { method: 'PATCH', body: new Uint8Array([1]) }),
    ).rejects.toThrow('only a JSON string body');
    await client.request('/v1/catalogs/cat_1', z.unknown(), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(calls).toHaveLength(1);
  });
});

describe('the catalog client of any paired machine', () => {
  const own = catalogClientOf(recording({ own: true }));
  const elsewhere = recording({ elsewhere: true }) as PluginClient;
  const clientOf = machineCatalogClient(own, 'd1', new Map([['d2', elsewhere]]));

  it('answers the half’s own client for its machine and Catalogs’ row client for another', async () => {
    expect(await clientOf({ daemonId: 'd1' })).toBe(own);
    calls.length = 0;
    const other = await clientOf({ daemonId: 'd2' });
    await other.request('/v1/catalogs', z.unknown());
    expect(calls.map(call => call.route)).toEqual(['GET /v1/catalogs']);
  });

  it('refuses, saying so, for a machine with no Catalogs row', async () => {
    await expect(clientOf({ daemonId: 'd3' })).rejects.toThrow(NO_MACHINE_SENTENCE);
  });

  it('m2 an install on a machine still connecting waits for its row; an off Catalogs says its own sentence', async () => {
    const rows = new Map<string, PluginClient>();
    const waiting = machineCatalogClient(own, 'd1', {
      clients: () => rows,
      whyNone: () => ({ waiting: true, line: 'Checking what this daemon offers…' }),
    });
    const pending = waiting({ daemonId: 'd2' });
    setTimeout(() => rows.set('d2', elsewhere), 150);
    await pending;
    const off = machineCatalogClient(own, 'd1', {
      clients: () => new Map(),
      whyNone: () => ({ waiting: false, line: 'Catalogs is off on this daemon.' }),
    });
    await expect(off({ daemonId: 'd3' })).rejects.toThrow('Catalogs is off on this daemon.');
  });

  it('R2-n1 a row the shell allows before the row map has caught up is one more loop, not an end', async () => {
    const rows = new Map<string, PluginClient>();
    const client = machineCatalogClient(own, 'd1', { clients: () => rows, whyNone: () => undefined });
    const pending = client({ daemonId: 'd2' });
    setTimeout(() => rows.set('d2', elsewhere), 150);
    await pending;
  });
});
