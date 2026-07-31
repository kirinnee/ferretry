import { afterEach, describe, it } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
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
    should(actual).deepEqual({ accountCount: 1, operationCount: 4, manifestPath, prunedWrappers: [] });
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

  it('should force a copied asset writable so the harness can rewrite what it owns', async () => {
    // Arrange — a template linked out of a read-only store arrives as 0444.
    const root = await temporaryDirectory();
    const source = path.join(root, 'template.json');
    const copied = path.join(root, 'fleet', 'homes', 'one', 'template.json');
    await Bun.write(source, '{}\n');
    await chmod(source, 0o444);
    const subject = new FileFleetProvisioner([root]);

    // Act
    await subject.apply({
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: copied }],
    });

    // Assert
    should((await stat(copied)).mode & 0o777).equal(0o644);
  });

  describe('settings operations', () => {
    it('should merge file and inline layers left to right into the destination', async () => {
      // Arrange
      const root = await temporaryDirectory();
      const base = path.join(root, 'base.json');
      const destination = path.join(root, 'fleet', 'homes', 'one', 'settings.json');
      await Bun.write(base, '{"model":"base","permissions":{"allow":["Read"],"deny":["Bash"]}}');
      const subject = new FileFleetProvisioner([root]);

      // Act
      await subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [
          {
            kind: 'settings',
            path: destination,
            format: 'json',
            layers: [
              { from: 'file', path: base },
              { from: 'inline', settings: { model: 'override', permissions: { deny: [] } } },
            ],
            mode: 0o600,
            preserveExisting: false,
          },
        ],
      });

      // Assert
      should(JSON.parse(await readFile(destination, 'utf8'))).deepEqual({
        model: 'override',
        permissions: { allow: ['Read'], deny: [] },
      });
      should((await stat(destination)).mode & 0o777).equal(0o600);
    });

    it('should keep runtime keys the harness wrote when preserveExisting is set', async () => {
      // Arrange — `/effort` persists effortLevel into the file apply is about to rewrite.
      const root = await temporaryDirectory();
      const destination = path.join(root, 'fleet', 'homes', 'one', 'settings.json');
      await Bun.write(destination, '{"effortLevel":"high","model":"stale"}');
      const subject = new FileFleetProvisioner([root]);

      // Act
      await subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [
          {
            kind: 'settings',
            path: destination,
            format: 'json',
            layers: [{ from: 'inline', settings: { model: 'fresh' } }],
            mode: 0o600,
            preserveExisting: true,
          },
        ],
      });

      // Assert — the runtime key survives; the declared key still wins.
      should(JSON.parse(await readFile(destination, 'utf8'))).deepEqual({ effortLevel: 'high', model: 'fresh' });
    });

    it('should ignore an unparseable existing file rather than failing the apply', async () => {
      // Arrange
      const root = await temporaryDirectory();
      const destination = path.join(root, 'fleet', 'homes', 'one', 'settings.json');
      await Bun.write(destination, 'not json at all');
      const subject = new FileFleetProvisioner([root]);

      // Act
      await subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [
          {
            kind: 'settings',
            path: destination,
            format: 'json',
            layers: [{ from: 'inline', settings: { model: 'fresh' } }],
            mode: 0o600,
            preserveExisting: true,
          },
        ],
      });

      // Assert
      should(JSON.parse(await readFile(destination, 'utf8'))).deepEqual({ model: 'fresh' });
    });

    it('should ignore a symlinked destination, which holds no runtime state to preserve', async () => {
      // Arrange
      const root = await temporaryDirectory();
      const template = path.join(root, 'template.json');
      const destination = path.join(root, 'fleet', 'homes', 'one', 'settings.json');
      await Bun.write(template, '{"fromTemplate":true}');
      await mkdir(path.dirname(destination), { recursive: true });
      await symlink(template, destination);
      const subject = new FileFleetProvisioner([root]);

      // Act
      await subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [
          {
            kind: 'settings',
            path: destination,
            format: 'json',
            layers: [{ from: 'inline', settings: { model: 'fresh' } }],
            mode: 0o600,
            preserveExisting: true,
          },
        ],
      });

      // Assert
      should(JSON.parse(await readFile(destination, 'utf8'))).deepEqual({ model: 'fresh' });
      should((await lstat(destination)).isSymbolicLink()).be.false();
    });

    it('should write TOML for a codex-shaped settings operation', async () => {
      // Arrange
      const root = await temporaryDirectory();
      const destination = path.join(root, 'fleet', 'homes', 'one', 'config.toml');
      await Bun.write(destination, 'model = "stale"\nkeep = true\n');
      const subject = new FileFleetProvisioner([root]);

      // Act
      await subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [
          {
            kind: 'settings',
            path: destination,
            format: 'toml',
            layers: [{ from: 'inline', settings: { model: 'fresh' } }],
            mode: 0o600,
            preserveExisting: true,
          },
        ],
      });

      // Assert
      const written = await readFile(destination, 'utf8');
      should(written).containEql('model = "fresh"');
      should(written).containEql('keep = true');
    });

    it('should reject a malformed settings layer rather than writing a partial file', async () => {
      // Arrange
      const root = await temporaryDirectory();
      const broken = path.join(root, 'broken.json');
      const destination = path.join(root, 'fleet', 'homes', 'one', 'settings.json');
      await Bun.write(broken, '{ not json');
      const subject = new FileFleetProvisioner([root]);

      // Act
      const promise = subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [
          {
            kind: 'settings',
            path: destination,
            format: 'json',
            layers: [{ from: 'file', path: broken }],
            mode: 0o600,
            preserveExisting: false,
          },
        ],
      });

      // Assert
      await should(promise).be.rejectedWith(/cannot parse json settings/);
      should(await Bun.file(destination).exists()).be.false();
    });
  });

  describe('prune operations', () => {
    it('should remove only marked files that nothing claims any more', async () => {
      // Arrange
      const root = await temporaryDirectory();
      const bin = path.join(root, 'fleet', 'bin');
      const marker = '# managed-by-the-test';
      await Bun.write(path.join(bin, 'keep-me'), `#!/bin/sh\n${marker}\nexec true\n`);
      await Bun.write(path.join(bin, 'stale-wrapper'), `#!/bin/sh\n${marker}\nexec true\n`);
      await Bun.write(path.join(bin, 'users-own-script'), '#!/bin/sh\nexec true\n');
      await mkdir(path.join(bin, 'a-directory'), { recursive: true });
      const subject = new FileFleetProvisioner([root]);

      // Act
      const actual = await subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [{ kind: 'prune', path: bin, marker, keep: ['keep-me'] }],
      });

      // Assert
      should([...actual.prunedWrappers]).deepEqual(['stale-wrapper']);
      should(await Bun.file(path.join(bin, 'keep-me')).exists()).be.true();
      should(await Bun.file(path.join(bin, 'users-own-script')).exists()).be.true();
      should(await Bun.file(path.join(bin, 'stale-wrapper')).exists()).be.false();
      should((await stat(path.join(bin, 'a-directory'))).isDirectory()).be.true();
    });

    it('should leave a symlink alone even when it points at marked content', async () => {
      // Arrange
      const root = await temporaryDirectory();
      const bin = path.join(root, 'fleet', 'bin');
      const marker = '# managed-by-the-test';
      const real = path.join(root, 'elsewhere');
      await Bun.write(real, `${marker}\n`);
      await mkdir(bin, { recursive: true });
      await symlink(real, path.join(bin, 'a-link'));
      const subject = new FileFleetProvisioner([root]);

      // Act
      const actual = await subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [{ kind: 'prune', path: bin, marker, keep: [] }],
      });

      // Assert
      should([...actual.prunedWrappers]).deepEqual([]);
      should((await lstat(path.join(bin, 'a-link'))).isSymbolicLink()).be.true();
    });

    it('should treat a missing directory as nothing to prune', async () => {
      // Arrange
      const root = await temporaryDirectory();
      const subject = new FileFleetProvisioner([root]);

      // Act
      const actual = await subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [{ kind: 'prune', path: path.join(root, 'fleet', 'bin'), marker: '#', keep: [] }],
      });

      // Assert
      should([...actual.prunedWrappers]).deepEqual([]);
    });
  });

  it('should refuse a prune outside the configured roots', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const other = await temporaryDirectory();
    const subject = new FileFleetProvisioner([root]);

    // Act
    const promise = subject.apply({
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'prune', path: other, marker: '#', keep: [] }],
    });

    // Assert
    await should(promise).be.rejectedWith(/outside configured fleet roots/);
  });

  it('should require at least one allowed root', () => {
    // Act
    const act = () => new FileFleetProvisioner([]);

    // Assert
    should(act).throw(/at least one allowed fleet root/);
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
