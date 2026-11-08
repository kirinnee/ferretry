import { describe, expect, it } from 'bun:test';
import { type DaemonlessPorts, registeredDaemonless, type SurfaceEntry } from '@ferretry/app';
import { CAPABILITY_NAMES } from '@ferretry/core-gate/contract';
import { z } from 'zod';
import app from '../../../app/index.ts';
import { pairPhoneCommands, pairPhoneRequests } from '../../../app/pair-phone-host.tsx';
import { routeRequestClient } from '../../../app/lib/route-request.ts';
import manifest from '../../../manifest.ts';

/** D2 #26: what Access contributes so a person can pair another device, and where each piece is mounted. */

describe('what Access contributes for pairing', () => {
  it('declares one daemon-less /pair screen, the new-devices status panel and the Devices tab', () => {
    const pair = manifest.ui?.screens?.find(screen => screen.id === 'pair');
    expect(pair).toMatchObject({ path: '/pair', daemonless: true });
    expect(manifest.ui?.panels?.some(p => p.id === 'new-devices' && p.slot === 'daemon.status')).toBe(true);
    expect(manifest.ui?.settings?.some(tab => tab.id === 'devices')).toBe(true);
  });

  it('the shell registers /pair from the daemon-less factory and only that', () => {
    const entry = {
      id: 'access',
      title: 'Access',
      core: false,
      contract: 'h',
      consumes: [],
      manifest,
      app,
    } as SurfaceEntry;
    const registered = registeredDaemonless([entry], {
      crypto: {} as never,
      indexedDB: null,
      daemons: { snapshot: () => ({ daemons: [], selected: null }), subscribe: () => () => {} } as never,
      pairDirect: async () => {
        throw new Error('unused');
      },
    } as unknown as DaemonlessPorts);
    expect(registered.failures).toEqual([]);
    expect([...registered.views.keys()]).toEqual(['access.pair']);
  });

  it('builds a half per machine whose panels and tab are drawn from its own client', () => {
    const built = (
      app as { build: (context: { manifest: unknown; client: unknown }) => Record<string, Record<string, unknown>> }
    ).build({
      manifest,
      client: { call: async () => ({}) },
    });
    expect(Object.keys(built.panels ?? {})).toContain('new-devices');
    expect(Object.keys(built.settings ?? {})).toEqual(['devices']);
    expect(Object.keys(built.screens ?? {})).toEqual(['pair']);
  });
});

describe('"Pair a phone" in the command bar', () => {
  const none = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, { use: false, configure: false }]));
  const devices = (hostLocal: boolean) => ({ devices: [], hostLocal, mayWiden: none });
  const sourceFor = (view: unknown, calls: string[], changed: () => void) =>
    pairPhoneCommands({
      client: {
        call: async (route: string) => {
          calls.push(route);
          if (view instanceof Error) throw view;
          return view;
        },
      } as never,
      daemon: 'd1',
      navigate: () => {},
      screenHref: (() => '') as never,
      changed,
    });

  it('offers nothing until the machine’s own device list says this caller may mint, then asks the sheet to open', async () => {
    const calls: string[] = [];
    let changes = 0;
    const source = sourceFor(devices(true), calls, () => (changes += 1));
    expect(await Promise.resolve(source(''))).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 0));
    const entries = await Promise.resolve(source(''));
    expect(calls).toEqual(['GET /v1/pair/devices']);
    expect(changes).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe('Pair a phone with this machine');
    const seen: (string | null)[] = [];
    pairPhoneRequests.subscribe(() => seen.push(pairPhoneRequests.snapshot()));
    entries[0]?.run();
    expect(seen).toEqual(['d1']);
    pairPhoneRequests.close();
  });

  it('offers nothing when the read fails (Settings › Devices explains)', async () => {
    const source = sourceFor(new Error('offline'), [], () => {});
    await Promise.resolve(source(''));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await Promise.resolve(source(''))).toEqual([]);
  });
});

describe('Access’s own routes with parameters', () => {
  it('matches a literal path to its template and passes the parameter, never the path', async () => {
    const calls: { route: string; init: unknown }[] = [];
    const client = routeRequestClient(
      {
        call: async <A,>(route: string, init?: unknown): Promise<A> => {
          calls.push({ route, init });
          return { ok: true } as A;
        },
      },
      ['DELETE /v1/pair/devices/:deviceId', 'GET /v1/pair/devices'],
    );
    await client.request('/v1/pair/devices/fy_device_x%20y', z.object({ ok: z.boolean() }), { method: 'DELETE' });
    expect(calls).toEqual([
      { route: 'DELETE /v1/pair/devices/:deviceId', init: { params: { deviceId: 'fy_device_x y' } } },
    ]);
  });
});
