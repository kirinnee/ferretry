import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { LIMITED_DEVICE_GRANTS } from '../../../../gate/contract/policy.ts';
import { projectInventory } from '../../../../gate/contract/inventory.ts';
import { AdmissionPort, type Admission } from '../../../contract/bound.ts';
import { defineEvent } from '../../../contract/define.ts';
import { jsonResponse } from '../../../contract/http.ts';
import { bootHost } from '../../../host/host.ts';
import { inventorySurfacesOf } from '../../../host/kernel-half.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, route } from '../../../manifest/index.ts';
import { recordingAdmission, request } from '../../unit/host/fixtures.ts';

const changed = defineEvent('connector.changed', z.strictObject({ enabled: z.boolean() }));
const connector = definePlugin({
  id: 'connector',
  title: 'Connector',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  actions: {
    routes: [
      route('GET /oauth/authorize', {
        door: 'public',
        minimum: 'none',
        caller: 'any',
        audit: { skip: 'fixture' },
        guard: { none: 'fixture' },
      }),
      route('GET /v1/connector', {
        minimum: 'operator',
        caller: 'any',
        capability: { capability: 'pairing' as never, axis: 'configure' },
        audit: { skip: 'fixture' },
        guard: { none: 'fixture' },
      }),
    ],
  },
  data: { publishes: [changed] },
});

test('public-only descriptors never enter the API or bus inventory projection', () => {
  const surfaces = inventorySurfacesOf(connector);
  expect(surfaces).toHaveLength(1);
  expect(surfaces.some(surface => 'door' in surface)).toBe(false);
});

test('a device denied private connector routes sees no new inventory entry or bus events', async () => {
  const home = await mkdtemp(`${tmpdir()}/fy-door-inventory-`);
  let publish = () => {};
  const admission: Admission = {
    ...recordingAdmission(),
    inventory: (_request, entries, surfaces) => {
      const result = projectInventory(
        { protocol: 1, plugins: [...entries] },
        { kind: 'device', grants: LIMITED_DEVICE_GRANTS },
        surfaces,
      );
      if (result.outcome !== 'shown') return [];
      return entries.filter(entry => result.inventory.plugins.some(shown => shown.id === entry.id));
    },
  };
  const boot = await bootHost({
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
      implementDaemon(connector, {
        build: ({ kernel }) => {
          publish = () => kernel.events.publish(changed, { enabled: true });
          return {
            routes: {
              'GET /oauth/authorize': async () => jsonResponse({ ok: true }),
              'GET /v1/connector': async () => jsonResponse({ enabled: true }),
            },
          };
        },
      }),
    ],
  });
  if (boot.kind !== 'running') throw new Error(boot.sentence);
  try {
    const response = await boot.host.dispatch(request('GET', '/v1/plugins'));
    const feed = await boot.host.dispatcher.upgrade(request('GET', '/v1/bus'));
    if (feed.outcome !== 'accepted') throw new Error('bus not accepted');
    const sent: string[] = [];
    const handler = await feed.attach({
      send: frame => {
        sent.push(String(frame));
        return String(frame).length;
      },
      close: () => {},
      bufferedBytes: () => 0,
    });
    await handler.open();
    publish();
    await Bun.sleep(5);
    expect(sent).toEqual([]);
    expect(JSON.parse(response.body).plugins.some((entry: { id: string }) => entry.id === 'connector')).toBe(false);
    handler.close();
  } finally {
    await boot.host.stop();
    await rm(home, { recursive: true, force: true });
  }
});
