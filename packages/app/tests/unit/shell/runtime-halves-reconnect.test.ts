import { describe, expect, test } from 'bun:test';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import { provideToShell } from '../../../src/connect/provides.ts';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * A RECONNECT THAT CHANGED NOTHING KEEPS THE HALVES. Every client change (a transport reconnect, a
 * `kernel.plugins-changed`) used to rebuild every half, so every view got a new component type and remounted. Now the
 * halves go only when some package's standing moved.
 */

const manifest = {
  id: 'board',
  title: 'Board',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
} as unknown as Manifest;

const builds: string[] = [];
const app = provideToShell(
  implementApp(manifest, {
    build: () => {
      builds.push('board');
      return { screens: { main: () => null } };
    },
  }),
  {},
);
const board: SurfaceEntry = {
  id: 'board',
  title: 'Board',
  core: false,
  contract: 'h-board',
  consumes: [],
  manifest,
  app,
};
const surfaces: SurfaceEntry[] = [...CORE, board];

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

async function connected(overrides: { current: Record<string, { on?: boolean; contract?: string } | null> }) {
  const transport = new FakeTransport((request: TransportRequest) =>
    request.path === '/v1/plugins'
      ? json(inventoryOf(surfaces, overrides.current))
      : json({ error: 'none', code: 'not_found' }, 404),
  );
  const daemons = new DaemonList({ storage: memoryStore(), now: () => 1 });
  daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const runtime = new ShellRuntime({ appVersion: '5.0.0', surfaces, daemons, connect: async () => transport });
  runtime.connection('d1');
  await settle();
  const reread = async (): Promise<void> => {
    const held = runtime.connection('d1');
    if (held.kind !== 'connected') throw new Error('not connected');
    await held.client.refresh();
    await settle();
  };
  return { runtime, reread };
}

describe('a reconnect that changed no standing', () => {
  test('keeps the same built half, so no view remounts, and builds nothing again', async () => {
    builds.length = 0;
    const { runtime, reread } = await connected({ current: {} });
    const before = runtime.half('d1', 'board');
    expect(before?.kind).toBe('built');
    expect(builds).toEqual(['board']);
    await reread();
    await reread();
    expect(runtime.half('d1', 'board')).toBe(before);
    expect(builds).toEqual(['board']);
  });

  test('still rebuilds the halves once a package standing moves, and again when it moves back', async () => {
    builds.length = 0;
    const overrides: { current: Record<string, { on?: boolean; contract?: string } | null> } = { current: {} };
    const { runtime, reread } = await connected(overrides);
    const before = runtime.half('d1', 'board');
    expect(before?.kind).toBe('built');

    overrides.current = { board: { contract: 'h-board-next' } };
    await reread();
    expect(runtime.half('d1', 'board')).toBeUndefined();

    overrides.current = {};
    await reread();
    const after = runtime.half('d1', 'board');
    expect(after?.kind).toBe('built');
    expect(after).not.toBe(before);
    expect(builds).toEqual(['board', 'board']);
  });
});
