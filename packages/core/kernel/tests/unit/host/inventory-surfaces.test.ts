import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AdmissionPort, type InventorySurfaces } from '../../../contract/bound.ts';
import { bootHost, type RunningHost } from '../../../host/host.ts';
import { inventorySurfacesOf } from '../../../host/kernel-half.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { recordingAdmission, request } from './fixtures.ts';

/**
 * §9.6: `GET /v1/plugins` hands Gate every plugin's declared routes, sockets and agent tools, so Gate can ask a
 * device's grants about them. With an empty surface map every paired device saw only the core pieces and Access.
 */
const homes: string[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const board = definePlugin({
  id: 'board',
  title: 'Board',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  actions: {
    routes: [
      {
        key: 'list',
        method: 'GET',
        path: '/v1/board',
        minimum: 'operator',
        caller: 'any',
        capability: { capability: 'fleet' as never, axis: 'use' },
        audit: { skip: 'test' },
        guard: { none: 'test' },
      },
    ],
    sockets: [
      {
        key: 'feed',
        method: 'GET',
        path: '/v1/board/feed',
        minimum: 'operator',
        caller: 'any',
        audit: { skip: 'test' },
        guard: { none: 'test' },
      },
    ],
    agentTools: [
      {
        name: 'card',
        minimum: 'authenticated',
        caller: 'any',
        audit: { skip: 'test' },
        guard: { none: 'test' },
        input: z.string(),
      },
    ],
  },
});

test('§9.6 a plugin’s inventory surfaces are its routes, sockets and agent tools, without method or path', () => {
  const surfaces = inventorySurfacesOf(board);
  expect(surfaces).toHaveLength(3);
  expect(surfaces.map(surface => ('path' in surface ? 'has path' : surface.minimum))).toEqual([
    'operator',
    'operator',
    'authenticated',
  ]);
  expect(surfaces[0]?.capability).toEqual({ capability: 'fleet' as never, axis: 'use' });
});

test('§9.6 GET /v1/plugins passes the declared surfaces of every plugin to admission.inventory', async () => {
  const home = await mkdtemp(`${tmpdir()}/fy-inventory-surfaces-`);
  homes.push(home);
  const admission = recordingAdmission();
  const seen: InventorySurfaces[] = [];
  admission.inventory = (_request, entries, surfaces) => {
    seen.push(surfaces);
    return entries;
  };
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: realAdapters(home, () => {}, { binary: 'fy' }),
    implementations: [
      implementDaemon(
        definePlugin({
          id: 'gate',
          title: 'Gate',
          version: '5.0.0',
          api: 5,
          core: true,
          kinds: [],
          provides: { admission: AdmissionPort },
        }),
        { build: () => ({ provides: { admission } }) },
      ),
      implementDaemon(board, {
        build: () => ({ routes: { list: async () => ({ status: 200, headers: new Map(), body: '' }) } }) as never,
      }),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  hosts.push(outcome.host);
  const response = await outcome.host.dispatch(request('GET', '/v1/plugins'));
  expect(response.status).toBe(200);
  expect(seen).toHaveLength(1);
  const surfaces = seen[0];
  expect(surfaces?.get('board')).toHaveLength(3);
  expect(surfaces?.get('board')?.[0]?.capability).toEqual({ capability: 'fleet' as never, axis: 'use' });
  expect(surfaces?.has('gate')).toBe(true);
});
