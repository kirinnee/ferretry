import { describe, expect, test } from 'bun:test';
import { StateCallsignCounters } from '../../../../daemon/adapters/names/state-callsign-counters.ts';

/** A state port holding the one `system-callsigns.json` document; a test sets how reads and writes fail. */
function port() {
  const world = {
    document: undefined as Record<string, number> | undefined,
    readFails: false,
    readDamaged: false,
    writeError: undefined as Error | undefined,
    writes: 0,
    port: {
      read: async () => {
        if (world.readFails) throw new Error('unreadable');
        return world.readDamaged ? { ok: false, error: { sentence: 'damaged' } } : { ok: true, value: world.document };
      },
      write: async (_file: unknown, value: Record<string, number>) => {
        world.writes += 1;
        if (world.writeError !== undefined) throw world.writeError;
        world.document = { ...value };
      },
    } as never,
  };
  return world;
}

describe('the system-callsign counters over system-callsigns.json', () => {
  test('a missing, damaged or unreadable document reads as nothing issued', async () => {
    const world = port();
    const counters = new StateCallsignCounters(world.port);
    expect(await counters.read()).toEqual({});
    world.readDamaged = true;
    expect(await counters.read()).toEqual({});
    world.readDamaged = false;
    world.readFails = true;
    expect(await counters.read()).toEqual({});
  });

  test('a write is read back, and a stored zero is kept as an issued prefix', async () => {
    const world = port();
    const counters = new StateCallsignCounters(world.port);
    await counters.write({ learning: 2, pack: 1 });
    expect(world.document).toEqual({ learning: 2, pack: 1 });
    expect(await counters.read()).toEqual({ learning: 2, pack: 1 });
    world.document = { learning: 0 };
    expect(await new StateCallsignCounters(world.port).read()).toEqual({ learning: 0 });
  });

  test('the in-memory high-water mark wins over a smaller stored value, and never goes backwards', async () => {
    const world = port();
    const counters = new StateCallsignCounters(world.port);
    await counters.write({ pack: 5 });
    world.document = { pack: 3 };
    expect(await counters.read()).toEqual({ pack: 5 });
    await counters.write({ pack: 2 });
    expect(await counters.read()).toEqual({ pack: 5 });
  });

  test('a refused write over a damaged file still advances the counter; any other fault is raised', async () => {
    const world = port();
    const counters = new StateCallsignCounters(world.port);
    world.writeError = Object.assign(new Error('damaged'), { name: 'StoreDamagedError' });
    await counters.write({ pack: 3 });
    expect(await counters.read()).toEqual({ pack: 3 });
    world.writeError = new Error('disk full');
    await expect(counters.write({ pack: 4 })).rejects.toThrow('disk full');
    expect(await counters.read()).toEqual({ pack: 4 });
  });
});
