import { describe, expect, test } from 'bun:test';
import type { FerretRuntimeRename } from '../../../../contract/index.ts';
import { ferretId } from '../../../../contract/testing/index.ts';
import { ferretsPort } from '../../../../daemon/lib/ferrets/port.ts';
import { KeyedSerialExecutor } from '../../../../daemon/lib/ferrets/serial.ts';
import { type FerretSessionPort, FerretsService } from '../../../../daemon/lib/ferrets/service.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * c58-28b: Ferrets owns the session records, so a runtime rename is told to Ferrets (`repointRuntime`) and Runtimes reads
 * the records through it (`runtimeRecords`). The record's `runtime` is written through the ordinary durable write and the
 * session config through the session port's locked rewrite, each ferret on its own mutation lane.
 */

const rename: FerretRuntimeRename = {
  from: 'work',
  to: 'play',
  fromWrapper: '/fleet/bin/work',
  toWrapper: '/fleet/bin/play',
};

/** A session peer holding each ferret's config `agent` and wrapper, as the session documents do. */
function peer(configs: Record<string, { agent: string; executable?: string }>, failing: readonly string[] = []) {
  const state = { configs: { ...configs }, repoints: [] as string[], readsFail: false };
  const session = {
    runtimeFacts: async (ferret: string) => {
      if (state.readsFail) throw new Error('FIXTURE_SECRET the document is damaged');
      return state.configs[ferret];
    },
    repointRuntime: async (ferret: string, asked: FerretRuntimeRename) => {
      state.repoints.push(ferret);
      if (failing.includes(ferret)) throw new Error('FIXTURE_SECRET the document is locked');
      const config = state.configs[ferret];
      if (config?.agent !== asked.from) return false;
      state.configs[ferret] = { ...config, agent: asked.to };
      return true;
    },
  } as unknown as FerretSessionPort;
  return { state, session };
}

/** The seeded ferret `fern` plus others, each with the runtime its record names. */
function fleet(
  session?: FerretSessionPort,
  runtimes: Record<string, string | undefined> = { fern: 'work', birch: 'work', cedar: 'other', elm: undefined },
) {
  const f = additivesFixture(session === undefined ? {} : { session });
  const base = f.registry.get(f.id)!;
  for (const [name, runtime] of Object.entries(runtimes)) {
    const { runtime: _none, ...bare } = base;
    f.registry.put({ ...bare, id: ferretId(name), name, ...(runtime === undefined ? {} : { runtime }) });
  }
  return f;
}

describe('c58-28b the records a runtime change reads', () => {
  test('each ferret answers the runtime its session config says, else its record’s, with the wrapper when there is one', async () => {
    const { session } = peer({
      fern: { agent: 'work', executable: '/fleet/bin/work' },
      cedar: { agent: 'configured' },
    });
    const f = fleet(session);
    f.registry.put({ ...f.registry.get(ferretId('cedar'))!, harness: 'codex', state: 'working' });

    const rows = await f.api.runtimeRecords?.();

    // In the registry's order: creation, then id.
    expect(rows).toEqual([
      { id: ferretId('birch'), name: 'birch', harness: 'claude', agent: 'work', state: 'stopped' },
      { id: ferretId('cedar'), name: 'cedar', harness: 'codex', agent: 'configured', state: 'working' },
      {
        id: ferretId('fern'),
        name: 'fern',
        harness: 'claude',
        agent: 'work',
        executable: '/fleet/bin/work',
        state: 'stopped',
      },
    ]);
  });

  test('a ferret that says no runtime anywhere is left out, and a Ferrets with no session files answers from its records', async () => {
    const f = fleet();

    expect((await f.api.runtimeRecords?.())?.map(row => `${row.id}:${row.agent}`)).toEqual([
      'birch:work',
      'cedar:other',
      'fern:work',
    ]);
  });

  test('a session config that cannot be read still answers from the record, quoting nothing of the failure', async () => {
    const { state, session } = peer({});
    state.readsFail = true;
    const f = fleet(session);

    const rows = await f.api.runtimeRecords?.();

    expect(rows?.map(row => row.agent)).toEqual(['work', 'other', 'work']);
    expect(JSON.stringify(rows)).not.toContain('FIXTURE_SECRET');
  });
});

describe('c58-28b a runtime rename re-points the ferrets on it', () => {
  test('moves the record and the config of each ferret on the old runtime, and only those', async () => {
    const { state, session } = peer({
      fern: { agent: 'work' },
      birch: { agent: 'work' },
      cedar: { agent: 'other' },
    });
    const f = fleet(session);
    const before = { cedar: f.registry.get(ferretId('cedar')), elm: f.registry.get(ferretId('elm')) };

    expect(await f.api.repointRuntime?.(rename)).toBe(2);

    expect(f.registry.get(ferretId('fern'))?.runtime).toBe('play');
    expect(f.registry.get(ferretId('birch'))?.runtime).toBe('play');
    expect(f.registry.get(ferretId('cedar'))).toBe(before.cedar!);
    expect(f.registry.get(ferretId('elm'))).toBe(before.elm!);
    expect(state.configs.fern?.agent).toBe('play');
    expect(state.configs.cedar?.agent).toBe('other');
  });

  test('keeps every other field of the record it moves', async () => {
    const f = fleet(peer({}).session);
    const before = f.registry.get(ferretId('fern'))!;

    await f.api.repointRuntime?.(rename);

    expect(f.registry.get(ferretId('fern'))).toEqual({ ...before, runtime: 'play' });
  });

  test('a ferret whose config alone names the old runtime still moves, and counts once when both do', async () => {
    const { state, session } = peer({ fern: { agent: 'work' }, elm: { agent: 'work' } });
    const f = fleet(session);

    expect(await f.api.repointRuntime?.(rename)).toBe(3);

    expect(state.configs.elm?.agent).toBe('play');
    expect(f.registry.get(ferretId('elm'))?.runtime).toBeUndefined();
  });

  test('an unknown runtime moves nothing: 0, and no record is written', async () => {
    const { state, session } = peer({ fern: { agent: 'work' } });
    const f = fleet(session);
    const before = f.registry.generation();

    expect(await f.api.repointRuntime?.({ ...rename, from: 'nobody', fromWrapper: '/fleet/bin/nobody' })).toBe(0);

    expect(f.registry.generation()).toBe(before);
    expect(state.configs.fern?.agent).toBe('work');
  });

  test('a running ferret is re-pointed too, as v4 did, and keeps its state', async () => {
    const f = fleet(peer({}).session);
    f.registry.put({ ...f.registry.get(ferretId('fern'))!, state: 'working' });

    await f.api.repointRuntime?.(rename);

    expect(f.registry.get(ferretId('fern'))).toMatchObject({ runtime: 'play', state: 'working' });
  });

  test('a ferret that cannot be rewritten is skipped, and the rest still move', async () => {
    const { session } = peer({}, ['fern']);
    const f = fleet(session);

    expect(await f.api.repointRuntime?.(rename)).toBe(1);

    expect(f.registry.get(ferretId('birch'))?.runtime).toBe('play');
  });

  test('a ferret’s own mutation lane is respected: the re-point waits for a start, stop or resume in flight', async () => {
    const serial = new KeyedSerialExecutor();
    const f = fleet(peer({}).session);
    const queued = new FerretsService(f.registry, f.tokens, { ...f.ports, serial });
    let release: () => void = () => undefined;
    const held = serial.run(
      'fern',
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    );

    const repointing = queued.repointRuntime(rename);
    await Bun.sleep(20);
    expect(f.registry.get(ferretId('fern'))?.runtime).toBe('work');

    release();
    await held;
    expect(await repointing).toBe(2);
    expect(f.registry.get(ferretId('fern'))?.runtime).toBe('play');
  });
});

describe('c58-28b only Runtimes tells Ferrets a runtime was renamed', () => {
  test('the Runtimes plugin’s port moves the ferrets, reading only the four names of the rename', async () => {
    const { state, session } = peer({ fern: { agent: 'work' } });
    const f = fleet(session);
    const port = ferretsPort(f.service, 'runtimes');

    expect(await port.repointRuntime?.({ ...rename, extra: 'never forwarded' } as FerretRuntimeRename)).toBe(2);

    expect(state.configs.fern?.agent).toBe('play');
    expect((await port.runtimeRecords?.())?.map(row => row.agent)).toEqual(['play', 'other', 'play']);
  });

  test('any other plugin is refused 403 in a fixed sentence and nothing is written', async () => {
    const { state, session } = peer({ fern: { agent: 'work' } });
    const f = fleet(session);
    const before = f.registry.generation();

    for (const consumer of ['conversation', 'warden', 'packs'])
      await expect(ferretsPort(f.service, consumer).repointRuntime?.(rename)).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });

    expect(f.registry.generation()).toBe(before);
    expect(state.repoints).toEqual([]);
  });
});
