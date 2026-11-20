import { describe, expect, test } from 'bun:test';
import type { EventDef } from '@ferretry/kernel/contract';
import type { ShellPluginClient } from '../../../src/client/daemon-client.ts';
import { DaemonLayouts, LAYOUTS_PLUGIN } from '../../../src/layout/daemon-layout.ts';
import { DeviceLayoutStore, storedOverrides } from '../../../src/layout/device-layout.ts';
import { DEFAULT_LAYOUT, layoutCandidates } from '../../../src/layout/layout.ts';
import { APP_STORAGE } from '../../../src/storage/names.ts';
import { memoryStore, writeRecord } from '../../../src/storage/records.ts';

const theme = { id: 'default', label: 'Default', base: 'studio' };
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
    expect(layouts.current('d1')?.theme).toMatchObject({ id: 'default', base: 'studio' });

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
    expect(store.set(DEFAULT_LAYOUT, 'nav.side', 'right')).toBeUndefined();
    expect(store.snapshot()).toMatchObject({ nav: { side: 'right' } });
    expect(JSON.parse(storage.entries()[APP_STORAGE.layout] ?? '{}')).toMatchObject({ format: 1 });
    expect(new DeviceLayoutStore(storage).snapshot()).toEqual(store.snapshot());
    expect(store.set(DEFAULT_LAYOUT, 'nav.side', 'middle')).toBeString();
    store.reset();
    expect(store.snapshot()).toEqual({});
    expect(storage.entries()[APP_STORAGE.layout]).toBeUndefined();
  });

  // The one-time move: a record saved before the v4-style default has no stamp.
  const drawn = (store: DeviceLayoutStore) => layoutCandidates(undefined, store.snapshot())[0] ?? DEFAULT_LAYOUT;
  const preV4 = { nav: { side: 'left', style: 'list' }, side: { at: 'right', holds: 'none' } };

  test('a layout saved before the v4 default is replaced by the v4 layout', () => {
    const storage = memoryStore();
    // The old shape: the overrides themselves, no stamp.
    writeRecord(storage, APP_STORAGE.layout, preV4);
    const store = new DeviceLayoutStore(storage);
    expect(store.snapshot()).toEqual({});
    expect(drawn(store)).toMatchObject({
      nav: { side: 'left', style: 'dock' },
      side: { at: 'left', holds: 'ferrets' },
    });
    expect(storage.entries()[APP_STORAGE.layout]).toBeUndefined();
  });

  test('a change made after the move is kept across a reload, and is not moved again', () => {
    const storage = memoryStore();
    writeRecord(storage, APP_STORAGE.layout, preV4);
    const store = new DeviceLayoutStore(storage);
    expect(store.set(DEFAULT_LAYOUT, 'side.at', 'right')).toBeUndefined();
    for (let reload = 0; reload < 2; reload += 1) {
      const again = new DeviceLayoutStore(storage);
      expect(again.snapshot()).toEqual({ side: { at: 'right' } });
      expect(drawn(again)).toMatchObject({ nav: { side: 'left' }, side: { at: 'right' } });
    }
  });

  test('a stamped record is kept as it is, and a fresh browser draws the v4 default', () => {
    const storage = memoryStore();
    writeRecord(storage, APP_STORAGE.layout, storedOverrides({ nav: { side: 'right' } }));
    expect(new DeviceLayoutStore(storage).snapshot()).toEqual({ nav: { side: 'right' } });
    const fresh = new DeviceLayoutStore(memoryStore());
    expect(fresh.snapshot()).toEqual({});
    expect(drawn(fresh)).toMatchObject({ nav: { side: 'left', style: 'dock' }, side: { at: 'left' } });
  });
});
