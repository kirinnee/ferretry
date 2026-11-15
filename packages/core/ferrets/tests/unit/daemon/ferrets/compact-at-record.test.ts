import { describe, expect, test } from 'bun:test';
import { ferretId } from '../../../../contract/testing/index.ts';
import type { FerretSessionPort } from '../../../../daemon/lib/ferrets/service.ts';
import { ferretsPort } from '../../../../daemon/lib/ferrets/port.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * `FerretsApi.compactAt` / `setCompactAt` (c58-16): Conversation's compact-at setting records the ferret's OWN value in its
 * session config, the field every launch already reads. The service parses it (floor included), fails closed on anything
 * else, and holds the same `mayTouch` rule as the other writes.
 */

/** A session peer holding one ferret's `compactAt`, as the session config does. */
function peer(initial?: 'auto' | number) {
  const state = { value: initial, writes: [] as (number | 'auto' | undefined)[], readFails: false };
  // Only the two members under test: the service reads every other one optionally here.
  const session = {
    compactAt: async () => {
      if (state.readFails) throw new Error('FIXTURE_SECRET the document is damaged');
      return state.value;
    },
    setCompactAt: async (_ferret: string, value: 'auto' | number | undefined) => {
      state.writes.push(value);
      state.value = value;
    },
  } as unknown as FerretSessionPort;
  return { state, session };
}

describe('c58-16 a ferret’s own compact-at is recorded through Ferrets', () => {
  test('a number or auto is parsed and written, undefined drops it, and the read sees each', async () => {
    const { state, session } = peer();
    const f = additivesFixture({ session });

    await f.api.setCompactAt?.(f.id, 250_000);
    expect(await f.api.compactAt?.(f.id)).toBe(250_000);
    await f.api.setCompactAt?.(f.id, 'auto');
    expect(await f.api.compactAt?.(f.id)).toBe('auto');
    await f.api.setCompactAt?.(f.id, undefined);

    expect(state.writes).toEqual([250_000, 'auto', undefined]);
    expect(await f.api.compactAt?.(f.id)).toBeUndefined();
  });

  test('a value the schema cannot parse is refused 400 before anything is written, and so is one under the floor', async () => {
    const { state, session } = peer(300_000);
    const f = additivesFixture({ session });

    for (const bad of [99_999, 250.5, 'soon', -1, null, Number.NaN] as never[])
      await expect(f.api.setCompactAt?.(f.id, bad)).rejects.toMatchObject({ status: 400, code: 'invalid_compact_at' });

    expect(state.writes).toEqual([]);
    expect(state.value).toBe(300_000);
  });

  test('a ferret nobody knows is 404 to write and has no value to read', async () => {
    const { state, session } = peer();
    const f = additivesFixture({ session });

    await expect(f.api.setCompactAt?.(ferretId('nobody'), 200_000)).rejects.toMatchObject({
      status: 404,
      code: 'not-found',
    });
    expect(await f.api.compactAt?.(ferretId('nobody'))).toBeUndefined();
    expect(state.writes).toEqual([]);
  });

  test('a ferret caller reaches its own and its helpers’, and is refused 403 anyone else’s, for the write and the read', async () => {
    const { state, session } = peer();
    const f = additivesFixture({ session });
    const lead = ferretId('lead');
    const helper = ferretId('helper');
    const other = ferretId('other');
    const base = f.registry.get(f.id)!;
    f.registry.put({ ...base, id: lead, name: 'lead' });
    f.registry.put({ ...base, id: helper, name: 'helper', parent: lead, role: 'helper' });
    f.registry.put({ ...base, id: other, name: 'other' });

    await f.api.setCompactAt?.(lead, 200_000, lead);
    await f.api.setCompactAt?.(helper, 400_000, lead);
    expect(await f.api.compactAt?.(helper, lead)).toBe(400_000);
    const writes = [...state.writes];

    for (const refused of [
      () => f.api.setCompactAt?.(lead, 250_000, other),
      () => f.api.setCompactAt?.(lead, 250_000, helper),
      () => f.api.compactAt?.(lead, other),
    ])
      await expect(refused()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(state.writes).toEqual(writes);
  });

  test('a Ferrets with no session files cannot record one (503), and a damaged document reads as none', async () => {
    const bare = additivesFixture();
    await expect(bare.api.setCompactAt?.(bare.id, 200_000)).rejects.toMatchObject({
      status: 503,
      code: 'plugin_unavailable',
    });
    expect(await bare.api.compactAt?.(bare.id)).toBeUndefined();

    const { state, session } = peer(200_000);
    state.readFails = true;
    const damaged = additivesFixture({ session });
    expect(await damaged.api.compactAt?.(damaged.id)).toBeUndefined();
  });

  test('the port hands both to a consumer, the caller rule included', async () => {
    const { session } = peer();
    const f = additivesFixture({ session });
    const port = ferretsPort(f.service, 'conversation');

    await port.setCompactAt?.(f.id, 200_000, f.id);
    expect(await port.compactAt?.(f.id, f.id)).toBe(200_000);
    await expect(port.setCompactAt?.(f.id, 200_000, ferretId('stranger'))).rejects.toMatchObject({ status: 403 });
  });
});
