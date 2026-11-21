import { expect, test } from 'bun:test';
import type { FerretDetails } from '../../../../contract/index.ts';
import { additivesFixture } from './additives-fixture.ts';

/** A fixture that remembers what `saveDetails` wrote, as the state port would. */
const fixture = () => {
  const f = additivesFixture();
  const saved: FerretDetails[] = [];
  f.ports.saveDetails = async (_ferret, details) => {
    saved.push(details);
  };
  return { ...f, saved };
};

test('an untitled ferret adopts a title offered from its conversation, recorded as auto', async () => {
  const f = fixture();
  expect(await f.service.adoptTitle(f.id, 'Fix Flaky Login Test')).toBe('adopted');
  expect(f.saved.at(-1)).toMatchObject({ title: 'Fix Flaky Login Test', titleSource: 'auto' });
  const summary = await f.service.get(f.id);
  expect(summary?.title).toBe('Fix Flaky Login Test');
  expect(summary?.titleSource).toBe('auto');
});

test('an auto title is replaced by a better one, and the same one is kept', async () => {
  const f = fixture();
  await f.service.adoptTitle(f.id, 'First Guess');
  expect(await f.service.adoptTitle(f.id, 'First Guess')).toBe('kept');
  expect(await f.service.adoptTitle(f.id, 'A Better Title')).toBe('adopted');
  expect((await f.service.get(f.id))?.title).toBe('A Better Title');
});

test("an owner's title is never replaced, whatever source stored it", async () => {
  const f = fixture();
  const renamed = await f.service.rename(f.id, { title: 'Mine' });
  expect(renamed.ok).toBe(true);
  expect(f.saved.at(-1)).toMatchObject({ title: 'Mine', titleSource: 'owner' });
  expect(await f.service.adoptTitle(f.id, 'Auto Title')).toBe('kept');
  const summary = await f.service.get(f.id);
  expect(summary?.title).toBe('Mine');
  expect(summary?.titleSource).toBe('owner');
  // A title stored before `titleSource` existed is the owner's too.
  f.registry.putDetails(f.id, { title: 'Old' });
  expect(await f.service.adoptTitle(f.id, 'Auto Title')).toBe('kept');
  expect((await f.service.get(f.id))?.titleSource).toBe('owner');
});

test('a rename after an auto title makes it the owner’s; an emptied title clears it', async () => {
  const f = fixture();
  await f.service.adoptTitle(f.id, 'Auto Title');
  await f.service.rename(f.id, { title: 'Mine' });
  expect(await f.service.adoptTitle(f.id, 'Newer Auto')).toBe('kept');
  await f.service.rename(f.id, { title: '' });
  const cleared = await f.service.get(f.id);
  expect(cleared?.title).toBeUndefined();
  expect(cleared?.titleSource).toBeUndefined();
  expect(await f.service.adoptTitle(f.id, 'Newer Auto')).toBe('adopted');
});

test('an offer is stripped of control characters and bounded; an empty one and an unknown ferret are kept', async () => {
  const f = fixture();
  expect(await f.service.adoptTitle(f.id, '   \n\t ')).toBe('kept');
  expect(await f.service.adoptTitle(f.id, `Line one\nline\ttwo ${'x'.repeat(300)}`)).toBe('adopted');
  const title = (await f.service.get(f.id))?.title ?? '';
  expect(title.startsWith('Line one line two')).toBe(true);
  expect(title.length).toBeLessThanOrEqual(120);
  expect(/\p{Cc}/u.test(title)).toBe(false);
  expect(await f.service.adoptTitle('ghost' as never, 'Anything')).toBe('kept');
});
