import { describe, expect, test } from 'bun:test';
import type { EventDef } from '@ferretry/kernel/contract';
import type { ShellPluginClient } from '../../../src/client/daemon-client.ts';
import { DaemonLayouts, LAYOUTS_PLUGIN } from '../../../src/layout/daemon-layout.ts';
import { DeviceLayoutStore, storedOverrides } from '../../../src/layout/device-layout.ts';
import { DEFAULT_LAYOUT, layoutCandidates } from '../../../src/layout/layout.ts';
import { APP_STORAGE } from '../../../src/storage/names.ts';
import { memoryStore, writeRecord } from '../../../src/storage/records.ts';

const theme = { id: 'default', label: 'Default', style: 'studio' };
const owner = { ...DEFAULT_LAYOUT, id: 'owner', density: 'compact' as const };

/** A guarded client for the `layouts` package that answers `GET /v1/layouts/current` from `answer`. */
function layoutsClient(answer: () => unknown) {
  const calls: string[] = [];
  const listeners = new Set<(payload: unknown) => void>();
  const client: ShellPluginClient = {
    call: async <A>(route: string) => {
      calls.push(route);
      return answer() as A;
    },
    subscribe: <N extends string, P>(_event: EventDef<N, P>, listener: (payload: P) => void) => {
      listeners.add(listener as (payload: unknown) => void);
      return () => listeners.delete(listener as (payload: unknown) => void);
    },
    socket: () => {
      throw new Error('no sockets here');
    },
  };
  return {
    client,
    calls,
    listeners,
    wake: () => {
      for (const listener of listeners) listener({ layout: 'owner' });
    },
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the daemon layout channel', () => {
  test('reads the owner layout through the layouts package client and re-reads on layouts.changed', async () => {
    let current: unknown = { layout: owner, theme };
    const fake = layoutsClient(() => current);
    const asked: string[] = [];
    const layouts = new DaemonLayouts({
      client: (daemon, id) => {
        asked.push(`${daemon}/${id}`);
        return fake.client;
      },
    });
    layouts.watch('d1');
    await settle();
    expect(asked).toEqual([`d1/${LAYOUTS_PLUGIN}`]);
    expect(fake.calls).toEqual(['GET /v1/layouts/current']);
    expect(layouts.current('d1')?.layout.density).toBe('compact');
    expect(layouts.current('d1')?.theme).toMatchObject({ id: 'default', style: 'studio' });

    current = { layout: { ...owner, density: 'comfortable' }, theme };
    fake.wake();
    await settle();
    expect(layouts.current('d1')?.layout.density).toBe('comfortable');
  });

  test('sends nothing while Layouts may not run on that daemon, and drops the layout once it is blocked', async () => {
    const fake = layoutsClient(() => ({ layout: owner, theme }));
    let allowed = false;
    const layouts = new DaemonLayouts({ client: () => (allowed ? fake.client : undefined) });
    layouts.watch('d1');
    await settle();
    expect(fake.calls).toEqual([]);
    expect(layouts.current('d1')).toBeUndefined();

    allowed = true;
    layouts.watch('d1');
    await settle();
    expect(layouts.current('d1')?.layout.id).toBe('owner');

    allowed = false;
    layouts.watch('d1');
    expect(layouts.current('d1')).toBeUndefined();
    expect(fake.listeners.size).toBe(0);
  });

  test('an answer that does not parse is no layout (the shell keeps its default)', async () => {
    const fake = layoutsClient(() => ({ layout: { id: 'x' }, theme }));
    const layouts = new DaemonLayouts({ client: () => fake.client });
    layouts.watch('d1');
    await settle();
    expect(layouts.current('d1')).toBeUndefined();
  });
});

describe('this device’s layout store', () => {
  test('keeps the --device overrides under fy:app:layout and resets them', () => {
    const storage = memoryStore();
    const store = new DeviceLayoutStore(storage);
    expect(store.set(DEFAULT_LAYOUT, 'nav.side', 'bottom')).toBeUndefined();
    expect(store.snapshot()).toMatchObject({ nav: { side: 'bottom' } });
    expect(JSON.parse(storage.entries()[APP_STORAGE.layout] ?? '{}')).toMatchObject({ format: 1 });
    expect(new DeviceLayoutStore(storage).snapshot()).toEqual(store.snapshot());
    expect(store.set(DEFAULT_LAYOUT, 'nav.side', 'middle')).toBeString();
    store.reset();
    expect(store.snapshot()).toEqual({});
    expect(storage.entries()[APP_STORAGE.layout]).toBeUndefined();
  });

  const drawn = (store: DeviceLayoutStore) => layoutCandidates(undefined, store.snapshot())[0] ?? DEFAULT_LAYOUT;

  test('an unstamped record is not read and not rewritten; a change made after it is kept across a reload', () => {
    const storage = memoryStore();
    writeRecord(storage, APP_STORAGE.layout, {
      nav: { side: 'left', style: 'list' },
      side: { at: 'right', holds: 'none' },
    });
    const store = new DeviceLayoutStore(storage);
    expect(store.snapshot()).toEqual({});
    expect(storage.entries()[APP_STORAGE.layout]).toBeDefined();
    expect(store.set(DEFAULT_LAYOUT, 'side.at', 'right')).toBeUndefined();
    for (let reload = 0; reload < 2; reload += 1) {
      const again = new DeviceLayoutStore(storage);
      expect(again.snapshot()).toEqual({ side: { at: 'right' } });
      expect(drawn(again)).toMatchObject({ nav: { side: 'left' }, side: { at: 'right' } });
    }
  });

  test('a stamped record is kept as it is, and a fresh browser draws the default', () => {
    const storage = memoryStore();
    writeRecord(storage, APP_STORAGE.layout, storedOverrides({ nav: { side: 'bottom' } }));
    expect(new DeviceLayoutStore(storage).snapshot()).toEqual({ nav: { side: 'bottom' } });
    const fresh = new DeviceLayoutStore(memoryStore());
    expect(fresh.snapshot()).toEqual({});
    expect(drawn(fresh)).toMatchObject({ nav: { side: 'left', style: 'dock' }, side: { at: 'left' } });
  });
});
