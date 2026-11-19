/**
 * A fresh fleet folder has no `assets/` yet. Reading through the fleet mounts must answer "nothing there", never throw:
 * the setup import asks for the skills store and its folders before any apply has made them.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fleetMounts, rootHostFiles } from '../../../daemon/adapters/root-host-files.ts';
import { readTextFolder, skillItemsIn } from '../../../daemon/adapters/setup-files.ts';
import { cleanupWorlds, fleetWorld } from '../../unit/support/fleet-world.ts';

afterEach(cleanupWorlds);

describe('reading the fleet assets on a fresh home', () => {
  it('reads a missing assets folder as no skills, no folder files, no text and no entry', async () => {
    const world = await fleetWorld();
    const files = rootHostFiles(fleetMounts(world.roots, world.roots.root('fleet'), world.fleet));
    const assets = join(world.fleet, 'assets');

    expect(await skillItemsIn(files, join(assets, 'skills'))).toEqual([]);
    expect(await readTextFolder(files, join(assets, 'skills', 'review'))).toEqual({ files: [], skipped: [] });
    expect(await files.readText(join(assets, 'components', 'instructions', 'main.md'))).toBeUndefined();
    expect(await files.lstat(join(assets, 'skills'))).toBeUndefined();
    expect(await files.stat(join(assets, 'skills'))).toBeUndefined();
    expect(await files.list(join(assets, 'skills'))).toBeUndefined();
  });
});
