import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { LIMITED_DEVICE_GRANTS } from '../../../contract/policy.ts';
import { request, world } from '../../unit/daemon/support.ts';
import { AdmissionPort, defineEvent, jsonResponse } from '@ferretry/kernel/contract';
import { bootHost, inventorySurfacesOf, realAdapters } from '@ferretry/kernel/host';
import { definePlugin, implementDaemon, route } from '@ferretry/kernel/manifest';

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
  const gate = world();
  gate.enrol('limited', LIMITED_DEVICE_GRANTS);
  const admission = gate.gate;
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
    expect((await boot.host.dispatch(request({ device: 'limited', path: '/v1/connector' }))).status).toBe(403);
    const response = await boot.host.dispatch(request({ device: 'limited', path: '/v1/plugins' }));
    expect(response.status).toBe(200);
    const feed = await boot.host.dispatcher.upgrade(request({ device: 'limited', path: '/v1/bus' }));
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
