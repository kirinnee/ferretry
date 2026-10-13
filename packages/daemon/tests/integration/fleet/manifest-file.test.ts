/**
 * The published fleet manifest, read whole through the state home's own filesystem port.
 *
 * The claims: no manifest yet is `undefined`, never an empty fleet; a manifest is handed back with its
 * runtime rows; and a file that is not a manifest throws, naming the file, because damaged evidence
 * is not evidence of no runtimes.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, describe, it } from 'bun:test';
import { buildFleetManifest } from '@ferretry/fleet';
import should from 'should';
import { readFleetManifest } from '../../../src/adapters/fleet/manifest-file.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

afterAll(cleanupTempDirectories);

const RUNTIME_ID = '4c0f3b6e-7a91-4a2f-9a7f-2b1d0f5c8e31';

async function stateHome() {
  const home = await tempDirectory('fleet-manifest-file');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.home, 0o700);
  await mkdir(dirname(paths.fleetManifest), { recursive: true });
  return { paths, files };
}

describe('readFleetManifest', () => {
  it('should answer nothing when no apply has published a manifest yet', async () => {
    // Arrange
    const { paths, files } = await stateHome();

    // Act / Assert
    should(await readFleetManifest(files, paths.fleetManifest)).be.undefined();
  });

  it('should hand back the published manifest with its runtime rows', async () => {
    // Arrange
    const { paths, files } = await stateHome();
    const manifest = buildFleetManifest({
      generatedAt: '2026-10-13T08:00:00.000Z',
      accounts: [],
      runtimes: [
        {
          id: RUNTIME_ID,
          name: 'claude-default',
          harness: 'claude',
          credential: 'claude-you',
          profile: 'default',
          agent: true,
          wrapper: `${paths.fleet}/bin/claude-default`,
          models: [{ id: 'sonnet', available: true }],
          defaultModel: 'sonnet',
        },
      ],
    });
    await writeFile(paths.fleetManifest, JSON.stringify(manifest));

    // Act
    const actual = await readFleetManifest(files, paths.fleetManifest);

    // Assert
    should(actual?.runtimes?.map(runtime => [runtime.name, runtime.credential])).deepEqual([
      ['claude-default', 'claude-you'],
    ]);
  });

  it('should refuse a file that is not JSON, naming it', async () => {
    // Arrange
    const { paths, files } = await stateHome();
    await writeFile(paths.fleetManifest, '{ not json');

    // Act
    const raised = await readFleetManifest(files, paths.fleetManifest).catch((error: unknown) => error);

    // Assert
    should((raised as Error).message).equal(`the fleet manifest at ${paths.fleetManifest} is not valid JSON`);
  });

  it('should refuse JSON that is not a fleet manifest, naming it', async () => {
    // Arrange
    const { paths, files } = await stateHome();
    await writeFile(paths.fleetManifest, JSON.stringify({ version: 1, accounts: 'none' }));

    // Act
    const raised = await readFleetManifest(files, paths.fleetManifest).catch((error: unknown) => error);

    // Assert
    should((raised as Error).message).equal(`the fleet manifest at ${paths.fleetManifest} is not a fleet manifest`);
  });
});
