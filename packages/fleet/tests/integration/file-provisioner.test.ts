import { afterEach, describe, it, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileFleetProvisioner } from '../../src/adapters/file-provisioner.ts';
import { FileMutationJournal, isMutationReservedName } from '../../src/adapters/mutation-journal.ts';
import type { FleetManifest } from '../../src/lib/manifest.ts';
import type { FleetApplyPlan } from '../../src/lib/provisioning.ts';
import type { SharedHistoryMigration, SharedHistoryRequest } from '../../src/lib/shared-history.ts';

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
      secretEnv: {},
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
  it('should create the fleet root itself, because a first run has nothing else to create', async () => {
    // Arrange
    const parent = await temporaryDirectory();
    const root = path.join(parent, 'fleet-root');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'manifest.json'),
      operations: [{ kind: 'directory', path: root, mode: 0o700 }],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const preview = await subject.preview(plan);
    await subject.apply(plan);

    // Assert
    should(preview.operations).deepEqual(plan.operations);
    (await stat(root)).isDirectory().should.be.true();
  });

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
    should(actual).deepEqual({
      accountCount: 1,
      operationCount: 4,
      manifestPath,
      prunedWrappers: [],
      sharedHistory: [],
    });
    should(await readFile(wrapper, 'utf8')).containEql('exec true');
    should((await stat(wrapper)).mode & 0o777).equal(0o755);
    should(await readFile(copied, 'utf8')).equal('placeholder material\n');
    should((await stat(copied)).mode & 0o777).equal(0o600);
    should((await lstat(linked)).isSymbolicLink()).be.true();
    should(JSON.parse(await readFile(manifestPath, 'utf8'))).deepEqual(manifest());
    should((await stat(manifestPath)).mode & 0o777).equal(0o600);
  });

  it("should link a folder that only this apply's own documents create, in the same apply", async () => {
    // Arrange: a skill the apply writes into the store, linked into a home by the same apply.
    const root = await temporaryDirectory();
    const skill = path.join(root, 'fleet', 'assets', 'skills', 'review');
    const linked = path.join(root, 'fleet', 'homes', 'one', 'skills', 'review');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [
        { kind: 'directory', path: path.dirname(linked), mode: 0o700 },
        { kind: 'symlink', source: skill, path: linked },
      ],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    await subject.apply(plan, [
      { path: path.join(skill, 'SKILL.md'), content: '---\nname: review\n---\n', mode: 0o600 },
    ]);

    // Assert
    should((await lstat(linked)).isSymbolicLink()).be.true();
    should(await readFile(path.join(linked, 'SKILL.md'), 'utf8')).containEql('name: review');
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

  it('should run the whole mutation inside the publishing section, with the claim already held', async () => {
    // Arrange — a manifest already published: the apply moves it aside before linking the new one in.
    const root = await temporaryDirectory();
    const manifestPath = path.join(root, 'fleet', 'manifest.json');
    const lockPath = path.join(root, 'fleet', '.fy-fleet-apply.lock');
    await Bun.write(manifestPath, '{"version":"previous"}\n');
    const plan: FleetApplyPlan = { manifest: manifest(), manifestPath, operations: [] };
    const seen: { readonly claimed: boolean; readonly manifest: string }[] = [];
    const observe = async (): Promise<void> => {
      seen.push({
        claimed: await stat(lockPath).then(
          () => true,
          () => false,
        ),
        manifest: await readFile(manifestPath, 'utf8'),
      });
    };
    const subject = new FileFleetProvisioner([root], undefined, {}, undefined, undefined, async mutate => {
      await observe();
      const result = await mutate();
      await observe();
      return result;
    });

    // Act
    const result = await subject.apply(plan);

    // Assert — entered holding the claim and before the old manifest moved; left with the new one in place.
    should(result.manifestPath).equal(manifestPath);
    should(seen.map(entry => entry.claimed)).deepEqual([true, true]);
    should(seen[0]?.manifest).equal('{"version":"previous"}\n');
    should(JSON.parse(seen[1]?.manifest ?? '{}')).deepEqual(manifest());
  });

  it('should never enter the publishing section while it waits for a claim somebody else holds', async () => {
    // Arrange — a claim left behind: a directory with a token file, as a crashed apply leaves one.
    const root = await temporaryDirectory();
    const manifestPath = path.join(root, 'fleet', 'manifest.json');
    const lockPath = path.join(root, 'fleet', '.fy-fleet-apply.lock');
    await mkdir(lockPath, { recursive: true });
    await Bun.write(
      path.join(lockPath, 'claim-left-behind.json'),
      `${JSON.stringify({ owner: 999_999, token: 'left-behind', at: 0 })}\n`,
    );
    let entered = false;
    const subject = new FileFleetProvisioner(
      [root],
      undefined,
      { waitMs: 20, pollMs: 5 },
      undefined,
      undefined,
      async mutate => {
        entered = true;
        return await mutate();
      },
    );

    // Act
    const refused = await subject
      .apply({ manifest: manifest(), manifestPath, operations: [] })
      .catch((error: unknown) => error);

    // Assert — refused for the claim, and no reader was ever held back for the wait.
    should((refused as Error).message).match(/another fleet apply holds/u);
    should(entered).be.false();
  });

  it('should publish landed ordinary operations before surfacing a shared-history failure', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const wrapper = path.join(root, 'fleet', 'bin', 'alias-with-hyphens');
    const manifestPath = path.join(root, 'fleet', 'manifest.json');
    const expectedHistory = {
      kind: 'claude' as const,
      pool: path.join(root, 'fleet', 'shared', 'claude'),
      migrated: 0,
      conflicts: 0,
      links: 0,
      changes: [],
      emptiedSourceDirectories: [],
      refusals: [],
    };
    let manifestObservedByMigration: unknown;
    let wrapperObservedByMigration: string | undefined;
    const sharedHistory = {
      preview: async () => expectedHistory,
      materialize: async () => {
        manifestObservedByMigration = JSON.parse(await readFile(manifestPath, 'utf8'));
        wrapperObservedByMigration = await readFile(wrapper, 'utf8');
        throw new Error('shared-history migration failed');
      },
    } as unknown as SharedHistoryMigration;
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath,
      operations: [{ kind: 'file', path: wrapper, content: '#!/bin/sh\nexec true "$@"\n', mode: 0o755 }],
      sharedHistoryRequests: [{ kind: 'claude', poolRoot: path.join(root, 'fleet', 'shared'), homes: [] }],
    };
    const subject = new FileFleetProvisioner([root], sharedHistory);

    // Act
    const preview = await subject.preview(plan);
    const promise = subject.apply(plan);

    // Assert — preview is prospective, but apply never returns a successful migration result.
    should(preview.sharedHistory).deepEqual([expectedHistory]);
    await should(promise).be.rejectedWith(/shared-history migration failed/u);
    should(manifestObservedByMigration).deepEqual(manifest());
    should(wrapperObservedByMigration).equal('#!/bin/sh\nexec true "$@"\n');
    should(JSON.parse(await readFile(manifestPath, 'utf8'))).deepEqual(manifest());
  });

  it('should preflight every history kind and refuse before any apply mutation', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const other = await temporaryDirectory();
    const wrapper = path.join(root, 'fleet', 'bin', 'alias-with-hyphens');
    const manifestPath = path.join(root, 'fleet', 'manifest.json');
    const clean = {
      kind: 'claude' as const,
      pool: path.join(root, 'fleet', 'shared', 'claude'),
      migrated: 0,
      conflicts: 0,
      links: 0,
      changes: [],
      emptiedSourceDirectories: [],
      refusals: [],
    };
    const refused = {
      kind: 'codex' as const,
      pool: path.join(root, 'fleet', 'shared', 'codex'),
      migrated: 0,
      conflicts: 0,
      links: 0,
      changes: [],
      emptiedSourceDirectories: [],
      refusals: [
        {
          account: 'codex-outside',
          home: other,
          path: other,
          reason: `refusing shared-history access outside configured roots: ${other}`,
        },
      ],
    };
    const previewedKinds: string[] = [];
    const materializedKinds: string[] = [];
    const sharedHistory = {
      preview: async (request: SharedHistoryRequest) => {
        previewedKinds.push(request.kind);
        return request.kind === 'claude' ? clean : refused;
      },
      materialize: async (request: SharedHistoryRequest) => {
        materializedKinds.push(request.kind);
        return request.kind === 'claude' ? clean : refused;
      },
    } as unknown as SharedHistoryMigration;
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath,
      operations: [{ kind: 'file', path: wrapper, content: '#!/bin/sh\nexec true "$@"\n', mode: 0o755 }],
      sharedHistoryRequests: [
        { kind: 'claude', poolRoot: path.join(root, 'fleet', 'shared'), homes: [] },
        { kind: 'codex', poolRoot: path.join(root, 'fleet', 'shared'), homes: [] },
      ],
    };
    const subject = new FileFleetProvisioner([root], sharedHistory);

    // Act
    const promise = subject.apply(plan);

    // Assert
    await should(promise).be.rejectedWith(
      /refusing to migrate codex history while 1 account home\(s\) cannot be read: codex-outside/u,
    );
    should(previewedKinds).deepEqual(['claude', 'codex']);
    should(materializedKinds).deepEqual([]);
    should(await Bun.file(wrapper).exists()).be.false();
    should(await Bun.file(manifestPath).exists()).be.false();
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

  it('should dereference a linked directory source so the generated account home contains no symlink', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const source = path.join(root, 'asset-source');
    const linkedSource = path.join(root, 'asset-link');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    await mkdir(source);
    await Bun.write(path.join(source, 'skill.md'), 'copied skill\n');
    await symlink(source, linkedSource, 'dir');
    const subject = new FileFleetProvisioner([root]);

    // Act
    await subject.apply({
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source: linkedSource, path: destination }],
    });

    // Assert
    should((await lstat(destination)).isSymbolicLink()).be.false();
    should((await lstat(path.join(destination, 'skill.md'))).isSymbolicLink()).be.false();
    should(await readFile(path.join(destination, 'skill.md'), 'utf8')).equal('copied skill\n');
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

    it('should refuse rather than merge over an existing file it cannot parse', async () => {
      // Arrange — this used to overwrite the damaged file with a merge computed without it, which
      // silently discarded whatever the person actually had. The keys are only preservable if the
      // file can be read; when it cannot, leaving it alone is the one answer that loses nothing.
      const root = await temporaryDirectory();
      const destination = path.join(root, 'fleet', 'homes', 'one', 'settings.json');
      await Bun.write(destination, 'not json at all');
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
            layers: [{ from: 'inline', settings: { model: 'fresh' } }],
            mode: 0o600,
            preserveExisting: true,
          },
        ],
      });

      // Assert
      await should(promise).be.rejectedWith(/could not be parsed/u);
      should(await readFile(destination, 'utf8')).equal('not json at all');
    });

    it('should refuse rather than merge over a directory where settings should be', async () => {
      // Arrange
      const root = await temporaryDirectory();
      const destination = path.join(root, 'fleet', 'homes', 'one', 'settings.json');
      await mkdir(destination, { recursive: true });
      await Bun.write(path.join(destination, 'someone-elses.txt'), 'not ours\n');
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
            layers: [{ from: 'inline', settings: { model: 'fresh' } }],
            mode: 0o600,
            preserveExisting: true,
          },
        ],
      });

      // Assert
      await should(promise).be.rejectedWith(/not a regular file/u);
      should(await readFile(path.join(destination, 'someone-elses.txt'), 'utf8')).equal('not ours\n');
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

    it('should skip every reserved prefix, including a staged replacement', async () => {
      // Arrange — a sweep that removed the machinery's own names would destroy the only copy of
      // what a rollback needs to put back. The three prefixes are one list precisely so that a
      // fourth is covered the moment it joins, rather than the moment somebody remembers to widen
      // a condition — each of these carries the managed marker and would otherwise be pruned.
      const root = await temporaryDirectory();
      const bin = path.join(root, 'fleet', 'bin');
      const marker = '# managed-by-the-test';
      const reserved = ['.fy-fleet-backup-abc', '.fy-fleet-displaced-abc', '.fy-fleet-staged-abc'];
      for (const name of reserved) await Bun.write(path.join(bin, name), `#!/bin/sh\n${marker}\nexec true\n`);
      await Bun.write(path.join(bin, 'stale-wrapper'), `#!/bin/sh\n${marker}\nexec true\n`);
      const subject = new FileFleetProvisioner([root]);

      // Act
      const actual = await subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [{ kind: 'prune', path: bin, marker, keep: [] }],
      });

      // Assert — only the genuine wrapper goes.
      should([...actual.prunedWrappers]).deepEqual(['stale-wrapper']);
      for (const name of reserved) should(await Bun.file(path.join(bin, name)).exists()).be.true();
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

  it.each(['preview', 'apply'] as const)('should reject an invalid manifest during %s preflight', async method => {
    // Arrange
    const root = await temporaryDirectory();
    const invalidManifest = { ...manifest(), generatedAt: 'not-an-instant' } as unknown as FleetManifest;
    const plan: FleetApplyPlan = {
      manifest: invalidManifest,
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const promise = method === 'preview' ? subject.preview(plan) : subject.apply(plan);

    // Assert
    await should(promise).be.rejected();
  });

  it.each(['preview', 'apply'] as const)(
    'should refuse a manifest outside the configured roots during %s preflight',
    async method => {
      // Arrange
      const root = await temporaryDirectory();
      const other = await temporaryDirectory();
      const plan: FleetApplyPlan = {
        manifest: manifest(),
        manifestPath: path.join(other, 'manifest.json'),
        operations: [],
      };
      const subject = new FileFleetProvisioner([root]);

      // Act
      const promise = method === 'preview' ? subject.preview(plan) : subject.apply(plan);

      // Assert
      await should(promise).be.rejectedWith(/outside configured fleet roots/u);
    },
  );

  it('should require at least one allowed root', () => {
    // Act
    const act = () => new FileFleetProvisioner([]);

    // Assert
    should(act).throw(/at least one allowed fleet root/);
  });

  it('should reject an out-of-root operation during preview when sharing is disabled', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const other = await temporaryDirectory();
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'directory', path: other, mode: 0o700 }],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const promise = subject.preview(plan);

    // Assert
    await should(promise).be.rejectedWith(`refusing to write outside configured fleet roots: ${other}`);
  });

  it('should keep an out-of-root account visible when its history preview refuses it', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const other = await temporaryDirectory();
    const config = path.join(other, 'config.toml');
    const refusal = {
      account: 'account-outside',
      home: other,
      path: other,
      reason: `refusing shared-history access outside configured roots: ${other}`,
    };
    const expectedHistory = {
      kind: 'codex' as const,
      pool: path.join(root, 'fleet', 'shared', 'codex'),
      migrated: 0,
      conflicts: 0,
      links: 0,
      changes: [],
      emptiedSourceDirectories: [],
      refusals: [refusal],
    };
    const sharedHistory = {
      preview: async () => expectedHistory,
      materialize: async () => expectedHistory,
    } as unknown as SharedHistoryMigration;
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [
        { kind: 'directory', path: other, mode: 0o700 },
        { kind: 'file', path: config, content: 'model = "user"\n', mode: 0o600 },
      ],
      sharedHistoryRequests: [
        {
          kind: 'codex',
          poolRoot: path.join(root, 'fleet', 'shared'),
          homes: [{ account: 'account-outside', path: other }],
        },
      ],
    };
    const subject = new FileFleetProvisioner([root], sharedHistory);

    // Act
    const actual = await subject.preview(plan);

    // Assert — preview neither reads nor hides unbounded ordinary operations; history explains why.
    should(actual.operations).deepEqual(plan.operations);
    should(actual.sharedHistory).deepEqual([expectedHistory]);
  });

  it('should not let one refused home mask an unrelated out-of-root preview operation', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const refusedHome = await temporaryDirectory();
    const unrelatedHome = await temporaryDirectory();
    const unrelatedPath = path.join(unrelatedHome, 'unrelated');
    const expectedHistory = {
      kind: 'codex' as const,
      pool: path.join(root, 'fleet', 'shared', 'codex'),
      migrated: 0,
      conflicts: 0,
      links: 0,
      changes: [],
      emptiedSourceDirectories: [],
      refusals: [
        {
          account: 'account-refused',
          home: refusedHome,
          path: refusedHome,
          reason: `refusing shared-history access outside configured roots: ${refusedHome}`,
        },
      ],
    };
    const sharedHistory = {
      preview: async () => expectedHistory,
      materialize: async () => expectedHistory,
    } as unknown as SharedHistoryMigration;
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [
        { kind: 'directory', path: refusedHome, mode: 0o700 },
        { kind: 'file', path: unrelatedPath, content: 'must refuse\n', mode: 0o600 },
      ],
      sharedHistoryRequests: [
        {
          kind: 'codex',
          poolRoot: path.join(root, 'fleet', 'shared'),
          homes: [{ account: 'account-refused', path: refusedHome }],
        },
      ],
    };
    const subject = new FileFleetProvisioner([root], sharedHistory);

    // Act
    const promise = subject.preview(plan);

    // Assert
    await should(promise).be.rejectedWith(`refusing to write outside configured fleet roots: ${unrelatedPath}`);
  });

  it('should refuse every destination outside the configured roots before apply writes anything', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const other = await temporaryDirectory();
    const first = path.join(root, 'fleet', 'first');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [
        { kind: 'file', path: first, content: 'first\n', mode: 0o600 },
        { kind: 'file', path: path.join(other, 'escape'), content: 'no\n', mode: 0o600 },
      ],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const promise = subject.apply(plan);

    // Assert
    await should(promise).be.rejectedWith(/outside configured fleet roots/u);
    should(await Bun.file(first).exists()).be.false();
  });

  it('should canonically refuse a destination whose existing ancestor links outside before apply writes', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const other = await temporaryDirectory();
    const fleet = path.join(root, 'fleet');
    const linkedAncestor = path.join(fleet, 'linked-outside');
    const first = path.join(fleet, 'first');
    const escaped = path.join(linkedAncestor, 'escaped');
    await mkdir(fleet, { recursive: true });
    await symlink(other, linkedAncestor);
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(fleet, 'manifest.json'),
      operations: [
        { kind: 'file', path: first, content: 'first\n', mode: 0o600 },
        { kind: 'file', path: escaped, content: 'escaped\n', mode: 0o600 },
      ],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const promise = subject.apply(plan);

    // Assert
    await should(promise).be.rejectedWith(/outside configured fleet roots/u);
    should(await Bun.file(first).exists()).be.false();
    should(await Bun.file(path.join(other, 'escaped')).exists()).be.false();
  });

  describe('prune-directory operations', () => {
    it('should treat a directory that is not there as already swept', async () => {
      // Arrange
      const root = await temporaryDirectory();
      const directory = path.join(root, 'fleet', 'homes', 'one', 'skills');
      const subject = new FileFleetProvisioner([root]);

      // Act
      const actual = await subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [{ kind: 'prune-directory', path: directory, keep: ['kept'] }],
      });

      // Assert — nothing was created to sweep, and the apply still completed.
      should(actual.prunedWrappers).deepEqual([]);
      await should(lstat(directory)).be.rejected();
      should(await Bun.file(path.join(root, 'fleet', 'manifest.json')).exists()).be.true();
    });

    it('should clear moved-aside residue an earlier interrupted apply left in a folder a runtime reads', async () => {
      // Arrange — an apply that died between moving a skill aside and discarding it leaves
      // `.fy-fleet-backup-…` beside the live skills. The sweep used to skip every reserved name, so the residue
      // stayed for good and a runtime scanning the folder loaded each copy as a real skill. What a rollback
      // displaced is different: it is state that changed under a failed apply, reported to the person, so it stays.
      const root = await temporaryDirectory();
      const directory = path.join(root, 'fleet', 'homes', 'one', 'skills');
      const residue = ['.fy-fleet-backup-abc', '.fy-fleet-staged-abc'];
      for (const name of [...residue, '.fy-fleet-displaced-abc']) {
        await Bun.write(path.join(directory, name, 'SKILL.md'), 'a leftover copy\n');
      }
      await Bun.write(path.join(directory, 'kept', 'SKILL.md'), 'a live skill\n');
      await Bun.write(path.join(directory, 'stale', 'SKILL.md'), 'a skill the profile dropped\n');
      const subject = new FileFleetProvisioner([root]);

      // Act
      const actual = await subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [{ kind: 'prune-directory', path: directory, keep: ['kept'] }],
      });

      // Assert — the residue and the dropped skill are gone, nothing is reported as left aside.
      should((await readdir(directory)).toSorted()).deepEqual(['.fy-fleet-displaced-abc', 'kept']);
      should(actual.backupResidue).be.undefined();
    });

    it('should not move aside a backup this very batch minted, and should discard it at the commit', async () => {
      // Arrange — the kept entry is replaced (moved aside, rewritten) and then swept in the same batch. The backup
      // this batch just made must reach the sweep untouched, or a rollback would depend on a copy of a copy.
      const root = await temporaryDirectory();
      const directory = path.join(root, 'fleet', 'homes', 'one', 'skills');
      await Bun.write(path.join(directory, 'kept'), 'the old skill\n');
      const subject = new FileFleetProvisioner([root]);
      const captured: string[] = [];
      const original = FileMutationJournal.prototype.capture;
      FileMutationJournal.prototype.capture = async function (this: FileMutationJournal, ...args) {
        captured.push(path.basename(args[0]));
        return await original.apply(this, args);
      };

      // Act
      let actual: Awaited<ReturnType<typeof subject.apply>>;
      try {
        actual = await subject.apply({
          manifest: manifest(),
          manifestPath: path.join(root, 'fleet', 'manifest.json'),
          operations: [
            { kind: 'file', path: path.join(directory, 'kept'), content: 'the new skill\n', mode: 0o644 },
            { kind: 'prune-directory', path: directory, keep: ['kept'] },
          ],
        });
      } finally {
        FileMutationJournal.prototype.capture = original;
      }

      // Assert — the entry itself was captured and no reserved name ever was; committed, nothing is left beside it.
      should(captured).containEql('kept');
      should(captured.filter(name => isMutationReservedName(name))).deepEqual([]);
      should(await readFile(path.join(directory, 'kept'), 'utf8')).equal('the new skill\n');
      should(await readdir(directory)).deepEqual(['kept']);
      should(actual.backupResidue).be.undefined();
    });

    it('should put residue back when a later step fails and the batch rolls back', async () => {
      // Arrange — the sweep has moved the earlier apply's leftover aside when the next operation fails.
      const root = await temporaryDirectory();
      const directory = path.join(root, 'fleet', 'homes', 'one', 'skills');
      await Bun.write(path.join(directory, '.fy-fleet-backup-abc', 'SKILL.md'), 'a leftover copy\n');
      await Bun.write(path.join(directory, 'kept'), 'a file, so nothing can be written beneath it\n');
      const subject = new FileFleetProvisioner([root]);

      // Act
      const promise = subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [
          { kind: 'prune-directory', path: directory, keep: ['kept'] },
          { kind: 'file', path: path.join(directory, 'kept', 'SKILL.md'), content: 'x\n', mode: 0o644 },
        ],
      });

      // Assert — the apply failed, and the leftover is exactly where the rollback found it.
      await should(promise).be.rejected();
      should((await readdir(directory)).toSorted()).deepEqual(['.fy-fleet-backup-abc', 'kept']);
      should(await readFile(path.join(directory, '.fy-fleet-backup-abc', 'SKILL.md'), 'utf8')).equal(
        'a leftover copy\n',
      );
    });

    it('should surface a named entry it cannot inspect for any reason other than its absence', async () => {
      // Arrange — the directory is a file, so nothing beneath it can be looked at.
      const root = await temporaryDirectory();
      const directory = path.join(root, 'fleet', 'homes', 'one', 'skills');
      await Bun.write(directory, 'a file where a directory should be');
      const subject = new FileFleetProvisioner([root]);

      // Act
      const promise = subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [{ kind: 'prune-directory', path: directory, keep: [], only: ['stale'] }],
      });

      // Assert
      await should(promise).be.rejectedWith(/is not a folder/u);
      should(await readFile(directory, 'utf8')).equal('a file where a directory should be');
      should(await Bun.file(path.join(root, 'fleet', 'manifest.json')).exists()).be.false();
    });
  });

  it('should refuse shared-history requests when no shared-history adapter was supplied', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [],
      sharedHistoryRequests: [{ kind: 'claude', poolRoot: path.join(root, 'fleet', 'shared'), homes: [] }],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act + Assert
    const message = 'shared-history operations were planned without a shared-history filesystem adapter';
    await should(subject.preview(plan)).be.rejectedWith(message);
    await should(subject.apply(plan)).be.rejectedWith(message);
    should(await Bun.file(plan.manifestPath).exists()).be.false();
  });

  describe('settings that cannot be read back', () => {
    const settingsPlan = (root: string, destination: string): FleetApplyPlan => ({
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

    it('should refuse rather than merge over a settings file it is not allowed to read', async () => {
      // Arrange
      const root = await temporaryDirectory();
      const destination = path.join(root, 'fleet', 'homes', 'one', 'settings.json');
      await Bun.write(destination, '{"effortLevel":"high"}');
      await chmod(destination, 0o000);
      const subject = new FileFleetProvisioner([root]);

      // Act
      const promise = subject.apply(settingsPlan(root, destination));

      // Assert — the unreadable file is put back exactly as it was.
      await should(promise).be.rejectedWith(/could not be read \(.*EACCES/su);
      await chmod(destination, 0o600);
      should(await readFile(destination, 'utf8')).equal('{"effortLevel":"high"}');
    });

    it('should merge only the plan when the file it set aside has vanished before it could be read', async () => {
      // Arrange — the set-aside copy is gone by the time the merge looks for it.
      const root = await temporaryDirectory();
      const destination = path.join(root, 'fleet', 'homes', 'one', 'settings.json');
      await Bun.write(destination, '{"effortLevel":"high"}');
      const real = fs.lstat;
      let vanished = false;
      const lstatSpy = spyOn(fs, 'lstat').mockImplementation(((target: string, ...rest: unknown[]) => {
        if (!vanished && isMutationReservedName(path.basename(String(target)))) {
          vanished = true;
          return Promise.reject(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }));
        }
        return (real as (...args: unknown[]) => unknown)(target, ...rest);
      }) as unknown as typeof fs.lstat);
      const subject = new FileFleetProvisioner([root]);

      try {
        // Act
        await subject.apply(settingsPlan(root, destination));
      } finally {
        lstatSpy.mockRestore();
      }

      // Assert
      should(vanished).be.true();
      should(JSON.parse(await readFile(destination, 'utf8'))).deepEqual({ model: 'fresh' });
    });

    it('should fail the apply and put the file back when the set-aside copy cannot be inspected', async () => {
      // Arrange
      const root = await temporaryDirectory();
      const destination = path.join(root, 'fleet', 'homes', 'one', 'settings.json');
      await Bun.write(destination, '{"effortLevel":"high"}');
      const real = fs.lstat;
      let failed = false;
      const lstatSpy = spyOn(fs, 'lstat').mockImplementation(((target: string, ...rest: unknown[]) => {
        if (!failed && isMutationReservedName(path.basename(String(target)))) {
          failed = true;
          return Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }));
        }
        return (real as (...args: unknown[]) => unknown)(target, ...rest);
      }) as unknown as typeof fs.lstat);
      const subject = new FileFleetProvisioner([root]);

      // Act
      let promise: Promise<unknown>;
      try {
        promise = subject.apply(settingsPlan(root, destination));
        await promise.catch(() => undefined);
      } finally {
        lstatSpy.mockRestore();
      }

      // Assert
      await should(promise).be.rejectedWith(/EIO/u);
      should(await readFile(destination, 'utf8')).equal('{"effortLevel":"high"}');
    });
  });

  it('should refuse to publish a staged entry that is no longer a regular file', async () => {
    // Arrange — the copy is told to dereference, so a link in the staged tree means somebody swapped
    // an entry after the copy finished; hard-linking it into the account home is not on offer.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skill');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skill');
    const elsewhere = path.join(root, 'elsewhere.txt');
    await Bun.write(path.join(source, 'SKILL.md'), 'the skill\n');
    await Bun.write(elsewhere, 'not part of the skill\n');
    const real = fs.cp;
    const cpSpy = spyOn(fs, 'cp').mockImplementation((async (from: string, to: string, options: never) => {
      await real(from, to, options);
      await rm(path.join(to, 'SKILL.md'));
      await symlink(elsewhere, path.join(to, 'SKILL.md'));
    }) as unknown as typeof fs.cp);
    const subject = new FileFleetProvisioner([root]);

    // Act
    let promise: Promise<unknown>;
    try {
      promise = subject.apply({
        manifest: manifest(),
        manifestPath: path.join(root, 'fleet', 'manifest.json'),
        operations: [{ kind: 'copy', source, path: destination }],
      });
      await promise.catch(() => undefined);
    } finally {
      cpSpy.mockRestore();
    }

    // Assert
    const failure = await promise.then(
      () => undefined,
      (error: unknown) => error,
    );
    should((failure as Error).message).containEql(
      `refusing to publish ${path.join(destination, 'SKILL.md')}: the staged entry is not a regular file`,
    );
    await should(lstat(destination)).be.rejected();
    should(await readFile(elsewhere, 'utf8')).equal('not part of the skill\n');
  });
});

describe('FileFleetProvisioner source fence at preview', () => {
  it('should refuse to preview an empty plan when the fence cannot be resolved, as apply does', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const subject = new FileFleetProvisioner([root], undefined, {}, { homes: [root], open: [root], hardLinkRoots: [] });
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [],
    };

    // Act
    const failure = await subject.preview(plan).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.an.instanceOf(Error);
    should((failure as Error).name).equal('StateHomeUnresolvedError');
  });
});
