/**
 * A v4 home that itself sits beneath a `fleet/homes/...` folder (here `<root>/fleet/homes/project/v4`) is moved and
 * converted: the paths v4 wrote inside it name the ORIGINAL place, so the match that re-bases them onto `--from` must
 * be the one for the v4 home's OWN `fleet/homes/<id>` (the most specific), not the first `fleet/homes` in the spelling.
 * A runtime home that still cannot be mapped must make the conversion INCOMPLETE and be named. Temp folders, fake bytes.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convert } from '../../src/convert.ts';
import { harnessHomesStep } from '../../src/steps/harness-homes.ts';
import { rebaseV4Path } from '../../src/v4/rebase.ts';
import { agentHomesRoot } from '../../src/v5/harness-paths.ts';

const ID = '22222222-2222-4222-8222-222222222222';
let root = '';
let original = '';
let moved = '';
let to = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-nested-'));
  original = join(root, 'fleet/homes/project/v4');
  moved = join(root, 'moved');
  to = join(root, 'v5');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

/** A v4-shaped home at `original` with one account home (id `ID`) the manifest names by ABSOLUTE path `recorded`. */
async function build(recorded: string): Promise<void> {
  await mkdir(join(original, 'fleet/homes', ID), { recursive: true });
  await writeFile(join(original, 'layout-version'), '2\n');
  await writeFile(join(original, 'fleet/homes', ID, 'user-state'), 'FAKE-STATE');
  await writeFile(
    join(original, 'fleet/manifest.json'),
    JSON.stringify({ version: 1, accounts: [{ id: ID, kind: 'claude', home: recorded }] }),
  );
  await rename(original, moved);
}

const run = () =>
  convert({
    from: moved,
    to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date(),
    steps: [harnessHomesStep],
  });

test('the v4 home own folder wins: a moved home nested beneath fleet/homes keeps its runtime home', async () => {
  await build(join(original, 'fleet/homes', ID));
  const result = await run();
  expect(result.kind).toBe('done');
  if (result.kind !== 'done') return;
  expect(await readFile(join(to, agentHomesRoot('claude'), ID, 'user-state'), 'utf8')).toBe('FAKE-STATE');
  expect(result.report.complete).toBe(true);
});

test('rebaseV4Path takes the most specific match for every area, and leaves a path already under --from alone', () => {
  const orig = '/data/fleet/homes/project/v4';
  expect(rebaseV4Path(moved, `${orig}/fleet/homes/abc/x`)).toBe(join(moved, 'fleet/homes/abc/x'));
  expect(rebaseV4Path(moved, `${orig}/fleet/shared/claude/h.jsonl`)).toBe(join(moved, 'fleet/shared/claude/h.jsonl'));
  expect(rebaseV4Path(moved, `${orig}/fleet/bin/codex-work`)).toBe(join(moved, 'fleet/bin/codex-work'));
  expect(rebaseV4Path(moved, `${orig}/state/warden/reports/r.md`)).toBe(join(moved, 'state/warden/reports/r.md'));
  const home = '/tmp/review/fleet/homes/project/v4';
  expect(rebaseV4Path(home, join(home, 'fleet/homes/id'))).toBe(join(home, 'fleet/homes/id'));
});

test('a runtime home that cannot be mapped makes the conversion INCOMPLETE and is named', async () => {
  // The manifest names a place INSIDE the runtime home, not the runtime home: nothing safe maps it, and its folder is real.
  await build(join(original, 'fleet/homes', ID, 'sub'));
  const result = await run();
  expect(result.kind).toBe('done');
  if (result.kind !== 'done') return;
  expect(result.report.complete).toBe(false);
  const step = result.report.steps[0];
  expect(step?.status).toBe('failed');
  expect(step?.note ?? '').toContain(ID);
});
