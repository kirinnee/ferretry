/**
 * A runtime v4 RECORDED whose home the step cannot map to a folder it carries must make the conversion INCOMPLETE,
 * be named in the step's note, and leave no `home.json` claiming done. Recorded runtimes and on-disk homes are matched
 * on the SAME key (the runtime id). Temp folders, fake bytes, no real home.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convert } from '../../src/convert.ts';
import { harnessHomesStep } from '../../src/steps/harness-homes.ts';

const ID = '22222222-2222-4222-8222-222222222222';
let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-unmapped-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

/** A v4 home with one recorded account home (`recorded`, relative to fleet/homes) and an optional real folder on disk. */
async function mappingCase(actualFolder: string | undefined, recorded: string) {
  const original = join(root, 'v4');
  const moved = join(root, 'moved');
  const to = join(root, 'v5');
  await mkdir(join(original, 'fleet'), { recursive: true });
  await writeFile(join(original, 'layout-version'), '2\n');
  await writeFile(
    join(original, 'fleet/manifest.json'),
    JSON.stringify({
      version: 1,
      accounts: [{ id: ID, kind: 'claude', home: join(original, 'fleet/homes', recorded) }],
    }),
  );
  if (actualFolder !== undefined) {
    await mkdir(join(original, 'fleet/homes', actualFolder), { recursive: true });
    await writeFile(join(original, 'fleet/homes', actualFolder, 'user-state'), 'FAKE-STATE');
  }
  await rename(original, moved);
  const result = await convert({
    from: moved,
    to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date(),
    steps: [harnessHomesStep],
  });
  const marker = await lstat(join(to, 'home.json')).then(
    () => true,
    () => false,
  );
  return { result, marker };
}

test('a recorded runtime whose internal home is missing is incomplete, named, and writes no home.json', async () => {
  const { result, marker } = await mappingCase(undefined, ID);
  expect(result.kind).toBe('done');
  if (result.kind !== 'done') return;
  expect(result.report.complete).toBe(false);
  expect(result.report.steps[0]?.status).toBe('failed');
  expect(result.report.steps[0]?.note ?? '').toContain(ID);
  expect(marker).toBe(false);
});

test('a recorded runtime with an unmapped legacy-name folder on disk is incomplete, named, and writes no home.json', async () => {
  const { result, marker } = await mappingCase('legacy-folder/sub', 'legacy-folder/sub');
  expect(result.kind).toBe('done');
  if (result.kind !== 'done') return;
  expect(result.report.complete).toBe(false);
  expect(result.report.steps[0]?.status).toBe('failed');
  expect(result.report.steps[0]?.note ?? '').toContain('legacy-folder');
  expect(marker).toBe(false);
});

test('a recorded runtime whose home is its own folder on disk is carried and complete', async () => {
  const { result, marker } = await mappingCase(ID, ID);
  expect(result.kind).toBe('done');
  if (result.kind !== 'done') return;
  expect(result.report.complete).toBe(true);
  expect(result.report.steps[0]?.status).toBe('converted');
  expect(marker).toBe(true);
});
