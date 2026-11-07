import { expect, test } from 'bun:test';
import { FerretSummarySchema } from '../../../../contract/index.ts';
import { additivesFixture } from './additives-fixture.ts';

test('reflex times: the summary shows the nudge and kill times the ferret was started with', async () => {
  const f = additivesFixture({ empty: true });
  await f.service.start({
    folder: '/repo',
    by: 'owner',
    options: { nudgeAfterSeconds: 300, killAfterSeconds: 1800 },
  });
  const summary = (await f.service.get(f.id))!;
  expect(summary.nudgeAfterSeconds).toBe(300);
  expect(summary.killAfterSeconds).toBe(1800);
  expect(FerretSummarySchema.safeParse(summary).success).toBe(true);
});

test('reflex times: zero is kept (the reflex is off); absent options show neither', async () => {
  const f = additivesFixture({ empty: true });
  await f.service.start({ folder: '/repo', by: 'owner', options: { nudgeAfterSeconds: 0 } });
  const off = (await f.service.get(f.id))!;
  expect(off.nudgeAfterSeconds).toBe(0);
  expect('killAfterSeconds' in off).toBe(false);
  const g = additivesFixture({ empty: true });
  await g.service.start({ folder: '/repo', by: 'owner' });
  const plain = (await g.service.get(g.id))!;
  expect('nudgeAfterSeconds' in plain).toBe(false);
  expect('killAfterSeconds' in plain).toBe(false);
});
