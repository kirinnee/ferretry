/**
 * V-B28 / E-270: a folder Ferretry copied into a runtime home is replaced whole only while it is still exactly what
 * Ferretry copied. A file the person added inside it (a hooks folder is the case that was hit) is theirs, so the folder
 * is left as it is and named, instead of being erased with the tree. All fixtures are synthetic.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FleetApplyPlan } from '../../../daemon/lib/provisioning.ts';
import type { FleetManifest } from '../../../daemon/lib/manifest.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../../unit/support/fleet-world.ts';

afterEach(cleanupWorlds);

const manifest = (): FleetManifest => ({
  version: 1,
  generatedAt: '2027-01-15T08:00:00.000Z',
  runtimes: [],
  accounts: [],
});

/** One apply: copy the `hooks` asset folder into a runtime home under a record, as the account materialiser plans it. */
async function applyHooks(world: FleetWorld, bytes: string) {
  const source = join(world.fleet, 'assets', 'hooks');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'pre.sh'), bytes);
  const home = join(world.fleet, 'homes', 'one');
  const record = join(home, '.fy', 'materialised.json');
  const plan: FleetApplyPlan = {
    manifest: manifest(),
    manifestPath: join(world.fleet, 'manifest.json'),
    operations: [
      { kind: 'directory', path: join(home, '.fy'), mode: 0o700 },
      { kind: 'copy', source, path: join(home, 'hooks'), unlessUnrecorded: { record, key: 'hooks' } },
      {
        kind: 'file',
        path: record,
        content: `${JSON.stringify({ version: 1, entries: ['hooks'], hashes: {}, links: {}, dirs: [], members: {} })}\n`,
        mode: 0o600,
        recordsMaterialised: true,
      },
    ],
  };
  const outcome = await world.provisioner().apply(plan);
  return { hooks: join(home, 'hooks'), outcome };
}

describe('a copied folder in a runtime home', () => {
  it('E-270 is replaced when untouched, and kept with its added file when the person added one', async () => {
    const world = await fleetWorld();
    const first = await applyHooks(world, 'v1\n');
    expect(await readFile(join(first.hooks, 'pre.sh'), 'utf8')).toBe('v1\n');

    // Untouched since Ferretry copied it: the next copy replaces it whole.
    await applyHooks(world, 'v2\n');
    expect(await readFile(join(first.hooks, 'pre.sh'), 'utf8')).toBe('v2\n');

    // The person adds a hook of their own beside Ferretry's.
    await writeFile(join(first.hooks, 'mine.sh'), 'my own hook\n');
    const third = await applyHooks(world, 'v3\n');

    expect(await readFile(join(first.hooks, 'mine.sh'), 'utf8')).toBe('my own hook\n');
    expect(await readFile(join(first.hooks, 'pre.sh'), 'utf8')).toBe('v2\n');
    expect(third.outcome.skipped?.map(entry => entry.path)).toContain(first.hooks);
  });
});
