import { afterEach, describe, it } from 'bun:test';
import { lstat, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileFleetProvisioner } from '../../src/adapters/file-provisioner.ts';
import type { FleetManifest } from '../../src/lib/manifest.ts';
import type { FleetApplyPlan } from '../../src/lib/provisioning.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-fleet-apply-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const manifest = (): FleetManifest => ({
  version: 1,
  generatedAt: '2027-01-15T08:00:00.000Z',
  accounts: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'claude',
      mode: 'auto',
      wrapper: '/placeholder/bin/alias-with-hyphens',
      home: '/placeholder/homes/one',
      displayName: 'Placeholder Account',
      defaultModel: 'model-one',
      models: [{ id: 'model-one', displayName: 'Model One', available: true }],
      available: true,
      unavailableReason: null,
    },
  ],
});

describe('FileFleetProvisioner', () => {
  it('should materialize files, copies, links, and the manifest inside explicit temporary roots', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const source = path.join(root, 'asset.txt');
    const wrapper = path.join(root, 'fleet', 'bin', 'alias-with-hyphens');
    const copied = path.join(root, 'fleet', 'homes', 'one', 'asset.txt');
    const linked = path.join(root, 'fleet', 'homes', 'one', 'linked.txt');
    const manifestPath = path.join(root, 'fleet', 'manifest.json');
    await Bun.write(source, 'placeholder material\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath,
      operations: [
        { kind: 'directory', path: path.dirname(wrapper), mode: 0o700 },
        { kind: 'file', path: wrapper, content: '#!/bin/sh\nexec true "$@"\n', mode: 0o755 },
        { kind: 'copy', source, path: copied, mode: 0o600 },
        { kind: 'symlink', source, path: linked },
      ],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await subject.apply(plan);

    // Assert
    should(actual).deepEqual({ accountCount: 1, operationCount: 4, manifestPath });
    should(await readFile(wrapper, 'utf8')).containEql('exec true');
    should((await stat(wrapper)).mode & 0o777).equal(0o755);
    should(await readFile(copied, 'utf8')).equal('placeholder material\n');
    should((await stat(copied)).mode & 0o777).equal(0o600);
    should((await lstat(linked)).isSymbolicLink()).be.true();
    should(JSON.parse(await readFile(manifestPath, 'utf8'))).deepEqual(manifest());
    should((await stat(manifestPath)).mode & 0o777).equal(0o600);
  });

  it('should preserve the previous manifest when an operation fails', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const manifestPath = path.join(root, 'fleet', 'manifest.json');
    await Bun.write(manifestPath, '{"version":"previous"}\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath,
      operations: [
        {
          kind: 'copy',
          source: path.join(root, 'missing-source'),
          path: path.join(root, 'fleet', 'homes', 'one', 'asset.txt'),
        },
      ],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const promise = subject.apply(plan);

    // Assert
    await should(promise).be.rejected();
    should(await readFile(manifestPath, 'utf8')).equal('{"version":"previous"}\n');
  });

  it('should refuse destinations outside the configured roots', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const other = await temporaryDirectory();
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'file', path: path.join(other, 'escape'), content: 'no\n', mode: 0o600 }],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const promise = subject.apply(plan);

    // Assert
    await should(promise).be.rejectedWith(/outside configured fleet roots/);
  });
});
