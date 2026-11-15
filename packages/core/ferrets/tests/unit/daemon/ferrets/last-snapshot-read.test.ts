import { expect, test } from 'bun:test';
import { ferretId } from '../../../../contract/testing/index.ts';
import { additivesFixture } from './additives-fixture.ts';

/** What the daemon's reader answers: the stored frame, already masked again with the Vault's values now. */
const MASKED = '$ env\nTOKEN=*****\n> ';

test('C58-15 FerretsApi.lastSnapshot answers the stored last screen the reader hands it, for a stopped ferret', async () => {
  const asked: string[] = [];
  const f = additivesFixture({
    storedLastSnapshot: async ferret => {
      asked.push(ferret);
      return MASKED;
    },
  });

  expect(await f.service.lastSnapshot(f.id)).toBe(MASKED);
  expect(await f.api.lastSnapshot?.(f.id, f.id)).toBe(MASKED);
  expect(asked).toEqual([f.id, f.id]);
});

test('C58-15 a ferret caller reads its own and its helpers’ last screen, nobody else’s, and the file is never touched for a refused caller', async () => {
  const asked: string[] = [];
  const f = additivesFixture({
    storedLastSnapshot: async ferret => {
      asked.push(ferret);
      return MASKED;
    },
  });
  const lead = ferretId('lead');
  const helper = ferretId('helper');
  const other = ferretId('other');
  const base = f.registry.get(f.id)!;
  f.registry.put({ ...base, id: lead, name: 'lead' });
  f.registry.put({ ...base, id: helper, name: 'helper', parent: lead, role: 'helper' });
  f.registry.put({ ...base, id: other, name: 'other' });

  expect(await f.service.lastSnapshot(lead, lead)).toBe(MASKED);
  expect(await f.service.lastSnapshot(helper, lead)).toBe(MASKED);
  const before = asked.length;
  // Refused: a stranger, and a helper reaching its lead. The reader is not asked at all, so nothing is read.
  await expect(f.service.lastSnapshot(other, lead)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  await expect(f.service.lastSnapshot(lead, helper)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  expect(asked.length).toBe(before);
  // The owner (no caller) reaches any.
  expect(await f.service.lastSnapshot(other)).toBe(MASKED);
});

test('C58-15 a ferret this daemon does not know, a reader that is unbound and a reader that throws all answer nothing', async () => {
  const bound = additivesFixture({ storedLastSnapshot: async () => MASKED });
  const unbound = additivesFixture();
  const throwing = additivesFixture({
    storedLastSnapshot: async () => {
      throw new Error('EACCES: the file is damaged');
    },
  });

  expect(await bound.service.lastSnapshot(ferretId('nobody'))).toBeUndefined();
  expect(await unbound.service.lastSnapshot(unbound.id)).toBeUndefined();
  expect(await throwing.service.lastSnapshot(throwing.id)).toBeUndefined();
});
