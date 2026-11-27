import { expect, test } from 'bun:test';
import { RELOCATE_MAX_FILE_BYTES } from '../../contract/index.ts';
import { plan } from '../../daemon/lib/snapshot.ts';
import { fakeSource, FERRET, summaryOf } from '../support/fake-ferrets.ts';
import { world } from '../support/world.ts';

test('R2 an oversized untracked total refuses using metadata before any content, bundle or diff read', async () => {
  const calls: string[] = [];
  const files = Array.from({ length: 12 }, (_, i) => `file-${String(i)}.bin`);
  const found = await plan({
    summary: summaryOf('idle'),
    source: fakeSource(),
    tree: {
      head: async () => ({ head: 'a'.repeat(40) }),
      ignoredTopLevel: async () => [],
      untracked: async () => files,
      size: async path => {
        calls.push(`stat:${path}`);
        return RELOCATE_MAX_FILE_BYTES;
      },
      read: async path => {
        calls.push(`read:${path}`);
        return new Uint8Array(RELOCATE_MAX_FILE_BYTES);
      },
      commits: async () => {
        calls.push('bundle');
        return undefined;
      },
      changes: async () => {
        calls.push('diff');
        return new Uint8Array();
      },
    },
  });
  expect(found.refusals.join(' ')).toContain('MB');
  expect(calls.filter(call => !call.startsWith('stat:'))).toEqual([]);
  expect(calls).toHaveLength(8);
});

test('R2 an oversized session estimate refuses before touching the working tree', async () => {
  let heads = 0;
  const w = await world({ size: () => RELOCATE_MAX_FILE_BYTES + 1 });
  const found = await plan({
    source: w.source,
    summary: summaryOf('idle'),
    tree: {
      head: async () => {
        heads++;
        return undefined;
      },
      size: async () => undefined,
      ignoredTopLevel: async () => [],
      untracked: async () => [],
      read: async () => undefined,
      commits: async () => undefined,
      changes: async () => new Uint8Array(),
    },
  });
  expect(found.refusals.length).toBeGreaterThan(0);
  expect(heads).toBe(0);
  expect(w.source.reads).toEqual([]);
});

test('R4 expiry recovers a source during a stalled preparation and rejects late publication', async () => {
  const w = await world({ noTree: true });
  let release!: (bytes: Uint8Array) => void;
  let started!: () => void;
  const stalled = new Promise<Uint8Array>(resolve => {
    release = resolve;
  });
  const reading = new Promise<void>(resolve => {
    started = resolve;
  });
  const read = w.source.read;
  w.source.read = async () => {
    started();
    return await stalled;
  };
  const pending = w.relocation.export(FERRET, (await w.offer()).offer);
  const outcome = pending.then(
    () => 'published',
    (error: Error) => error.message,
  );
  await reading;
  expect(w.ferrets.state).toBe('stopped');
  w.now += 20 * 60_000;
  await w.relocation.expire();
  const recovered = w.ferrets.state;
  release(new Uint8Array());
  const result = await outcome;
  expect(recovered).toBe('idle');
  expect(result).toContain('deadline');
  expect(w.ferrets.calls.filter(call => call === 'resume')).toHaveLength(1);
  w.source.read = read;
  await expect(w.relocation.export(FERRET, (await w.offer()).offer)).resolves.toHaveProperty('exportId');
});

test('R4 a read returning beyond the deadline refuses before another operation even before the expiry sweep', async () => {
  const w = await world({ noTree: true });
  let reads = 0;
  w.source.read = async () => {
    reads++;
    w.now += 61_000;
    return new Uint8Array();
  };
  await expect(w.relocation.export(FERRET, (await w.offer()).offer)).rejects.toThrow('deadline');
  expect(reads).toBe(1);
  expect(w.ferrets.state).toBe('idle');
});
