import { expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import { PERSON_ORIGIN, type StartDecideInput } from '../../../../contract/index.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * `start.decide` is told the directory the launch will REALLY be in (the kernel's bound identity), beside the folder as
 * it was spelled, so a taker that judges WHERE (Packs' temporary-folder check) is not fooled by a link either way.
 */
test('a start carries the bound directory’s real path as `realFolder`, and the spelling stays `folder`', async () => {
  const f = additivesFixture({ empty: true });
  const seen: StartDecideInput[] = [];
  f.ports.decide = async input => {
    seen.push(input);
    return { allow: true };
  };
  f.ports.bindFolder = async () =>
    ok({ insideStateHome: false, realPath: '/home/x/project', verify: async () => ok(undefined) });
  expect((await f.service.start({ folder: '/tmp/project-link', by: 'owner' }, PERSON_ORIGIN)).ok).toBe(true);
  expect(seen[0]).toMatchObject({ folder: '/tmp/project-link', realFolder: '/home/x/project' });
});

test('with no bound directory there is no `realFolder` to claim', async () => {
  const f = additivesFixture({ empty: true });
  const seen: StartDecideInput[] = [];
  f.ports.decide = async input => {
    seen.push(input);
    return { allow: true };
  };
  await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
  expect(seen[0]).not.toHaveProperty('realFolder');
});
