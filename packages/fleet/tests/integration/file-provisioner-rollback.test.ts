import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileFleetProvisioner } from '../../src/adapters/file-provisioner.ts';
import type { FleetManifest } from '../../src/lib/manifest.ts';
import {
  FleetApplyFailureError,
  type FleetApplyFailure,
  type FleetApplyPlan,
  type FleetWriteOperation,
} from '../../src/lib/provisioning.ts';
import type { SharedHistoryMigration } from '../../src/lib/shared-history.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-fleet-rollback-test-'));
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

/**
 * An operation that survives preflight and throws at the mutation boundary: its parent is a regular
 * file, which canonicalizes and contains cleanly but cannot be turned into a directory. Failure is
 * injected this way rather than by stubbing the filesystem so the rollback is proven against real
 * `ENOTDIR`/`EEXIST` behaviour.
 */
const poisonAfter = (blocker: string): FleetWriteOperation => ({
  kind: 'file',
  path: path.join(blocker, 'unreachable'),
  content: 'never written\n',
  mode: 0o600,
});

const failureOf = async (promise: Promise<unknown>): Promise<FleetApplyFailure> => {
  try {
    await promise;
  } catch (error) {
    should(error).be.instanceof(FleetApplyFailureError);
    return (error as FleetApplyFailureError).failure;
  }
  throw new Error('expected the apply to fail');
};

/** No moved-aside evidence, no staged replacement and no atomic-write temporary may survive. */
const assertNoResidue = async (directory: string): Promise<void> => {
  const entries = await readdir(directory, { recursive: true });
  const residue = entries.filter(
    entry =>
      path.basename(entry).startsWith('.fy-fleet-backup-') ||
      path.basename(entry).startsWith('.fy-fleet-staged-') ||
      path.basename(entry).endsWith('.tmp'),
  );
  should(residue).deepEqual([]);
};

describe('FileFleetProvisioner rollback', () => {
  it('should restore a replaced file and remove a created one when a later operation fails', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const replaced = path.join(root, 'fleet', 'existing.txt');
    const created = path.join(root, 'fleet', 'created.txt');
    const blocker = path.join(root, 'fleet', 'blocker');
    await mkdir(path.join(root, 'fleet'), { recursive: true });
    await writeFile(replaced, 'original bytes\n');
    await writeFile(blocker, 'a file where a directory is needed\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [
        { kind: 'file', path: replaced, content: 'replacement\n', mode: 0o600 },
        { kind: 'file', path: created, content: 'new\n', mode: 0o600 },
        poisonAfter(blocker),
      ],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await failureOf(subject.apply(plan));

    // Assert
    should(actual.kind).equal('rolled-back');
    should(await readFile(replaced, 'utf8')).equal('original bytes\n');
    should(await Bun.file(created).exists()).be.false();
    should(await Bun.file(plan.manifestPath).exists()).be.false();
    await assertNoResidue(root);
  });

  it('should restore a replaced directory tree copied over by a failing apply', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skills');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    const blocker = path.join(root, 'fleet', 'blocker');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'new-skill.md'), 'incoming\n');
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'old-skill.md'), 'the account had this\n');
    await mkdir(path.join(root, 'fleet'), { recursive: true });
    await writeFile(blocker, 'blocker\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }, poisonAfter(blocker)],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await failureOf(subject.apply(plan));

    // Assert
    should(actual.kind).equal('rolled-back');
    should(await readdir(destination)).deepEqual(['old-skill.md']);
    should(await readFile(path.join(destination, 'old-skill.md'), 'utf8')).equal('the account had this\n');
    await assertNoResidue(root);
  });

  it('should restore a replaced file copied over by a failing apply', async () => {
    // Arrange — a file source takes the non-recursive copy branch a directory source does not.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'CLAUDE.md');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'CLAUDE.md');
    const blocker = path.join(root, 'blocker');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, 'incoming instructions\n');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'the account had these\n');
    await writeFile(blocker, 'blocker\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }, poisonAfter(blocker)],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await failureOf(subject.apply(plan));

    // Assert
    should(actual.kind).equal('rolled-back');
    should(await readFile(destination, 'utf8')).equal('the account had these\n');
    await assertNoResidue(root);
  });

  it('should undo an enabled Codex ownership sidecar and its settings write in reverse order', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const home = path.join(root, 'fleet', 'homes', 'codex-one');
    const configPath = path.join(home, 'config.toml');
    const markerPath = path.join(home, '.ferretry-sqlite-home.json');
    const sqliteHome = path.join(root, 'fleet', 'shared', 'codex', 'sqlite');
    const blocker = path.join(root, 'blocker');
    await mkdir(home, { recursive: true });
    await writeFile(configPath, 'sqlite_home = "/somewhere/the/operator/chose"\n');
    await writeFile(blocker, 'blocker\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [
        { kind: 'codex-sqlite-ownership', path: configPath, markerPath, sqliteHome, enabled: true },
        {
          kind: 'settings',
          path: configPath,
          format: 'toml',
          layers: [{ from: 'inline', settings: { sqlite_home: sqliteHome } }],
          mode: 0o600,
          preserveExisting: true,
        },
        poisonAfter(blocker),
      ],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await failureOf(subject.apply(plan));

    // Assert — the sidecar this apply created is gone and the operator's value is back.
    should(actual.kind).equal('rolled-back');
    should(await Bun.file(markerPath).exists()).be.false();
    should(await readFile(configPath, 'utf8')).equal('sqlite_home = "/somewhere/the/operator/chose"\n');
    await assertNoResidue(root);
  });

  it('should undo a disabled Codex ownership reconciliation, sidecar included', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const home = path.join(root, 'fleet', 'homes', 'codex-one');
    const configPath = path.join(home, 'config.toml');
    const markerPath = path.join(home, '.ferretry-sqlite-home.json');
    const sqliteHome = path.join(root, 'fleet', 'shared', 'codex', 'sqlite');
    const marker = `${JSON.stringify({
      version: 1,
      sqliteHome,
      createdConfig: false,
      original: { present: true, value: '/the/original' },
    })}\n`;
    const blocker = path.join(root, 'blocker');
    await mkdir(home, { recursive: true });
    await writeFile(configPath, `sqlite_home = "${sqliteHome}"\n`);
    await writeFile(markerPath, marker);
    await writeFile(blocker, 'blocker\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [
        { kind: 'codex-sqlite-ownership', path: configPath, markerPath, sqliteHome, enabled: false },
        poisonAfter(blocker),
      ],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await failureOf(subject.apply(plan));

    // Assert — both the reconciled config and the ownership record are exactly as they were.
    should(actual.kind).equal('rolled-back');
    should(await readFile(configPath, 'utf8')).equal(`sqlite_home = "${sqliteHome}"\n`);
    should(await readFile(markerPath, 'utf8')).equal(marker);
    await assertNoResidue(root);
  });

  it('should preserve bytes another actor wrote while the failing operation was in flight', async () => {
    // Arrange — the operation moves the original aside and then throws before it can record what
    // it left behind, and somebody else claims the empty destination in that window.
    const root = await temporaryDirectory();
    const contested = path.join(root, 'homes', 'one', 'memory.md');
    await mkdir(path.dirname(contested), { recursive: true });
    await writeFile(contested, 'the original\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'file', path: contested, content: 'ours\n', mode: 0o600 }],
    };
    const subject = new FileFleetProvisioner([root]);
    const interrupted = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'writeFileAtomically') return Reflect.get(target, property, receiver);
        return async (destination: string) => {
          if (destination !== contested) return;
          await writeFile(contested, 'somebody else got here first\n');
          throw new Error('the write was interrupted');
        };
      },
    });

    // Act
    const actual = await failureOf(interrupted.apply(plan));

    // Assert
    should(actual.kind).equal('rollback-incomplete');
    if (actual.kind !== 'rollback-incomplete') return;
    should(await readFile(contested, 'utf8')).equal('somebody else got here first\n');
    should(actual.unrestored[0]?.path).equal(contested);
    should(await readFile(actual.unrestored[0]?.backup ?? '', 'utf8')).equal('the original\n');
  });

  it('should leave a destination untouched when a copy source cannot be read', async () => {
    // Arrange — the regression that made a missing asset delete the account's previous one.
    const root = await temporaryDirectory();
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'old-skill.md'), 'must survive\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source: path.join(root, 'assets', 'absent'), path: destination }],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const promise = subject.apply(plan);

    // Assert — refused in preflight, so the failure is not even a rollback case.
    await should(promise).be.rejected();
    should(await readFile(path.join(destination, 'old-skill.md'), 'utf8')).equal('must survive\n');
    await assertNoResidue(root);
  });

  it('should refuse an unreadable settings layer before any destination is disturbed', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const destination = path.join(root, 'fleet', 'homes', 'one', 'settings.json');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, '{"kept":true}\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [
        {
          kind: 'settings',
          path: destination,
          format: 'json',
          layers: [{ from: 'file', path: path.join(root, 'assets', 'absent.json') }],
          mode: 0o600,
          preserveExisting: true,
        },
      ],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const promise = subject.apply(plan);

    // Assert
    await should(promise).be.rejected();
    should(await readFile(destination, 'utf8')).equal('{"kept":true}\n');
  });

  it('should restore the settings file the harness had been writing to', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const destination = path.join(root, 'fleet', 'homes', 'one', 'settings.json');
    const blocker = path.join(root, 'fleet', 'blocker');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, '{"runtimeKey":"written by the harness"}\n');
    await writeFile(blocker, 'blocker\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [
        {
          kind: 'settings',
          path: destination,
          format: 'json',
          layers: [{ from: 'inline', settings: { declared: true } }],
          mode: 0o600,
          preserveExisting: true,
        },
        poisonAfter(blocker),
      ],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await failureOf(subject.apply(plan));

    // Assert
    should(actual.kind).equal('rolled-back');
    should(await readFile(destination, 'utf8')).equal('{"runtimeKey":"written by the harness"}\n');
    await assertNoResidue(root);
  });

  it('should restore a replaced symlink rather than leave the new target in place', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const link = path.join(root, 'fleet', 'homes', 'one', 'memory.md');
    const blocker = path.join(root, 'fleet', 'blocker');
    await mkdir(path.dirname(link), { recursive: true });
    await writeFile(path.join(root, 'original-target.md'), 'original\n');
    await writeFile(path.join(root, 'new-target.md'), 'new\n');
    await symlink(path.join(root, 'original-target.md'), link);
    await mkdir(path.join(root, 'fleet'), { recursive: true });
    await writeFile(blocker, 'blocker\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'symlink', source: path.join(root, 'new-target.md'), path: link }, poisonAfter(blocker)],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await failureOf(subject.apply(plan));

    // Assert
    should(actual.kind).equal('rolled-back');
    should(await readFile(link, 'utf8')).equal('original\n');
    await assertNoResidue(root);
  });

  it('should restore a directory mode it narrowed and keep ancestors it did not create', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const existing = path.join(root, 'fleet');
    const created = path.join(root, 'fleet', 'homes', 'one');
    const blocker = path.join(root, 'blocker');
    await mkdir(existing, { recursive: true, mode: 0o755 });
    await writeFile(blocker, 'blocker\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [
        { kind: 'directory', path: existing, mode: 0o700 },
        { kind: 'directory', path: created, mode: 0o700 },
        poisonAfter(blocker),
      ],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await failureOf(subject.apply(plan));

    // Assert
    should(actual.kind).equal('rolled-back');
    should((await stat(existing)).mode & 0o777).equal(0o755);
    should(await Bun.file(created).exists()).be.false();
    should(await Bun.file(path.join(root, 'fleet', 'homes')).exists()).be.false();
    should((await stat(existing)).isDirectory()).be.true();
  });

  it('should put a pruned wrapper back when a later operation fails', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const binDirectory = path.join(root, 'fleet', 'bin');
    const stale = path.join(binDirectory, 'claude-retired');
    const blocker = path.join(root, 'blocker');
    await mkdir(binDirectory, { recursive: true });
    await writeFile(stale, '#!/bin/sh\n# managed-marker\nexec true\n');
    await writeFile(blocker, 'blocker\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'prune', path: binDirectory, marker: '# managed-marker', keep: [] }, poisonAfter(blocker)],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await failureOf(subject.apply(plan));

    // Assert
    should(actual.kind).equal('rolled-back');
    should(await readFile(stale, 'utf8')).equal('#!/bin/sh\n# managed-marker\nexec true\n');
    await assertNoResidue(root);
  });

  it('should never sweep away the moved-aside evidence of an earlier operation', async () => {
    // Arrange — the wrapper this apply replaces is backed up into the very directory prune sweeps.
    const root = await temporaryDirectory();
    const binDirectory = path.join(root, 'fleet', 'bin');
    const wrapper = path.join(binDirectory, 'claude-kirin');
    const blocker = path.join(root, 'blocker');
    await mkdir(binDirectory, { recursive: true });
    await writeFile(wrapper, '#!/bin/sh\n# managed-marker\nexec previous\n');
    await writeFile(blocker, 'blocker\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [
        { kind: 'file', path: wrapper, content: '#!/bin/sh\n# managed-marker\nexec next\n', mode: 0o755 },
        { kind: 'prune', path: binDirectory, marker: '# managed-marker', keep: ['claude-kirin'] },
        poisonAfter(blocker),
      ],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await failureOf(subject.apply(plan));

    // Assert
    should(actual.kind).equal('rolled-back');
    should(await readFile(wrapper, 'utf8')).equal('#!/bin/sh\n# managed-marker\nexec previous\n');
    await assertNoResidue(root);
  });

  it('should roll every ordinary operation back when the manifest cannot be published', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const landed = path.join(root, 'homes', 'one', 'wrapper');
    const manifestPath = path.join(root, 'fleet', 'manifest.json');
    const replaced = path.join(root, 'homes', 'one', 'previous');
    await mkdir(path.dirname(replaced), { recursive: true });
    await writeFile(replaced, 'previous bytes\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath,
      operations: [
        { kind: 'file', path: landed, content: 'landed\n', mode: 0o755 },
        { kind: 'file', path: replaced, content: 'replacement\n', mode: 0o600 },
      ],
    };
    const subject = new FileFleetProvisioner([root]);
    const failing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'writeManifest') return Reflect.get(target, property, receiver);
        return async () => {
          throw new Error('the manifest could not be published');
        };
      },
    });

    // Act
    const actual = await failureOf(failing.apply(plan));

    // Assert
    should(actual.kind).equal('rolled-back');
    should(actual.kind === 'rolled-back' && actual.failedOperation).match(/manifest/u);
    should(actual.kind === 'rolled-back' && actual.reason).match(/could not be published/u);
    should(await Bun.file(landed).exists()).be.false();
    should(await readFile(replaced, 'utf8')).equal('previous bytes\n');
    should(await Bun.file(manifestPath).exists()).be.false();
    await assertNoResidue(root);
  });

  it('should roll a configuration document back together with the fleet it describes', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const configPath = path.join(root, 'fleet', 'config.yaml');
    const blocker = path.join(root, 'blocker');
    await mkdir(path.join(root, 'fleet'), { recursive: true });
    await writeFile(configPath, 'agents: []\n');
    await writeFile(blocker, 'blocker\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [poisonAfter(blocker)],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await failureOf(
      subject.apply(plan, [{ path: configPath, content: 'agents: [the new one]\n', mode: 0o600 }]),
    );

    // Assert — a host may never be left declaring an account whose home was never materialised.
    should(actual.kind).equal('rolled-back');
    should(await readFile(configPath, 'utf8')).equal('agents: []\n');
    await assertNoResidue(root);
  });

  it('should name the exact paths whose restoration could not be verified', async () => {
    // Arrange — the entry captured first has an ancestor replaced by a link out of the roots.
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const homes = path.join(root, 'homes');
    const movedAside = path.join(root, 'homes-moved');
    const home = path.join(homes, 'one');
    const asset = path.join(home, 'memory.md');
    const blocker = path.join(root, 'blocker');
    await mkdir(home, { recursive: true });
    await writeFile(asset, 'original\n');
    await writeFile(blocker, 'blocker\n');
    const swap: FleetWriteOperation = { kind: 'file', path: path.join(root, 'swap'), content: 'x\n', mode: 0o600 };
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'file', path: asset, content: 'replacement\n', mode: 0o600 }, swap, poisonAfter(blocker)],
    };
    const subject = new FileFleetProvisioner([root]);
    // Swapping the home for a link out of the roots between the capture and the rollback is what a
    // hostile or merely broken host looks like; the restore must refuse rather than follow it.
    const hostile = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'applyOperation') return Reflect.get(target, property, receiver);
        return async (operation: FleetWriteOperation, journal: unknown) => {
          if (operation === swap) {
            // Move the real tree aside — taking the backup with it — and leave a link out of the
            // roots in its place, so the restore has to refuse rather than follow it.
            await rename(homes, movedAside);
            await symlink(outside, homes);
            return [];
          }
          return await (
            Reflect.get(target, property, receiver) as (a: FleetWriteOperation, b: unknown) => Promise<string[]>
          ).call(target, operation, journal);
        };
      },
    });

    // Act
    const actual = await failureOf(hostile.apply(plan));

    // Assert
    should(actual.kind).equal('rollback-incomplete');
    if (actual.kind !== 'rollback-incomplete') return;
    should(actual.unrestored.length).be.above(0);
    should(actual.unrestored[0]?.path).equal(asset);
    should(actual.unrestored[0]?.reason).match(/outside configured fleet roots/u);
    // The only surviving copy is named rather than tidied away — here it travelled with the tree
    // that was moved out from under the restore.
    const backup = actual.unrestored[0]?.backup ?? '';
    should(backup).startWith(path.join(homes, 'one'));
    const preserved = path.join(movedAside, 'one', path.basename(backup));
    should(await readFile(preserved, 'utf8')).equal('original\n');
  });

  it('should report a committed fleet when only shared history fails afterwards', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const wrapper = path.join(root, 'fleet', 'bin', 'claude-kirin');
    const manifestPath = path.join(root, 'fleet', 'manifest.json');
    const sharedHistory = {
      preview: async () => ({
        kind: 'claude' as const,
        pool: path.join(root, 'fleet', 'shared', 'claude'),
        migrated: 0,
        conflicts: 0,
        links: 0,
        changes: [],
        emptiedSourceDirectories: [],
        refusals: [],
      }),
      materialize: async () => {
        throw new Error('history pool is locked');
      },
    } as unknown as SharedHistoryMigration;
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath,
      operations: [{ kind: 'file', path: wrapper, content: '#!/bin/sh\nexec true\n', mode: 0o755 }],
      sharedHistoryRequests: [{ kind: 'claude', poolRoot: path.join(root, 'fleet', 'shared'), homes: [] }],
    };
    const subject = new FileFleetProvisioner([root], sharedHistory);

    // Act
    const actual = await failureOf(subject.apply(plan));

    // Assert — the fleet really did land, and saying otherwise would send the owner re-applying it.
    should(actual.kind).equal('history-failed-after-commit');
    if (actual.kind !== 'history-failed-after-commit') return;
    should(actual.failedHarness).equal('claude');
    should(actual.reason).match(/history pool is locked/u);
    should(actual.committed.manifestPath).equal(manifestPath);
    should(actual.committed.manifest).deepEqual(manifest());
    should(actual.committed.operationCount).equal(1);
    should(JSON.parse(await readFile(manifestPath, 'utf8'))).deepEqual(manifest());
    should(await Bun.file(wrapper).exists()).be.true();
    await assertNoResidue(root);
  });

  it('should refuse to overwrite a destination that changed after this apply wrote it', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const contested = path.join(root, 'homes', 'one', 'settings.json');
    const blocker = path.join(root, 'blocker');
    await mkdir(path.dirname(contested), { recursive: true });
    await writeFile(contested, '{"original":true}\n');
    await writeFile(blocker, 'blocker\n');
    const interfere: FleetWriteOperation = {
      kind: 'file',
      path: path.join(root, 'interfere'),
      content: 'x\n',
      mode: 0o600,
    };
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [
        { kind: 'file', path: contested, content: '{"applied":true}\n', mode: 0o600 },
        interfere,
        poisonAfter(blocker),
      ],
    };
    const subject = new FileFleetProvisioner([root]);
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'applyOperation') return Reflect.get(target, property, receiver);
        return async (operation: FleetWriteOperation, journal: unknown) => {
          // Somebody else rewrites the destination between this apply's write and its rollback.
          if (operation === interfere) {
            await writeFile(contested, '{"written by someone else":true}\n');
            return [];
          }
          return await (
            Reflect.get(target, property, receiver) as (a: FleetWriteOperation, b: unknown) => Promise<string[]>
          ).call(target, operation, journal);
        };
      },
    });

    // Act
    const actual = await failureOf(racing.apply(plan));

    // Assert — their bytes survive, and ours are kept aside rather than forced back over them.
    should(actual.kind).equal('rollback-incomplete');
    if (actual.kind !== 'rollback-incomplete') return;
    should(await readFile(contested, 'utf8')).equal('{"written by someone else":true}\n');
    should(actual.unrestored[0]?.path).equal(contested);
    should(actual.unrestored[0]?.reason).match(/changed after this apply wrote it/u);
    const preserved = actual.unrestored[0]?.backup ?? '';
    should(await readFile(preserved, 'utf8')).equal('{"original":true}\n');
  });

  it('should serialize concurrent applies rather than let them interleave', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const order: string[] = [];
    const sharedHistory = {
      preview: async () => ({
        kind: 'claude' as const,
        pool: path.join(root, 'fleet', 'shared', 'claude'),
        migrated: 0,
        conflicts: 0,
        links: 0,
        changes: [],
        emptiedSourceDirectories: [],
        refusals: [],
      }),
      materialize: async () => {
        order.push('enter');
        await new Promise(resolve => setTimeout(resolve, 10));
        order.push('exit');
        return {
          kind: 'claude' as const,
          pool: path.join(root, 'fleet', 'shared', 'claude'),
          migrated: 0,
          conflicts: 0,
          links: 0,
          changes: [],
          emptiedSourceDirectories: [],
          refusals: [],
        };
      },
    } as unknown as SharedHistoryMigration;
    const planFor = (name: string): FleetApplyPlan => ({
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'file', path: path.join(root, 'fleet', 'bin', name), content: `${name}\n`, mode: 0o755 }],
      sharedHistoryRequests: [{ kind: 'claude', poolRoot: path.join(root, 'fleet', 'shared'), homes: [] }],
    });
    const subject = new FileFleetProvisioner([root], sharedHistory);

    // Act
    await Promise.all([subject.apply(planFor('first')), subject.apply(planFor('second'))]);

    // Assert — one apply finishes entirely before the next begins.
    should(order).deepEqual(['enter', 'exit', 'enter', 'exit']);
    should(await readFile(path.join(root, 'fleet', 'bin', 'first'), 'utf8')).equal('first\n');
    should(await readFile(path.join(root, 'fleet', 'bin', 'second'), 'utf8')).equal('second\n');
  });

  it('should leave no moved-aside evidence behind after a successful apply', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const replaced = path.join(root, 'fleet', 'bin', 'claude-kirin');
    await mkdir(path.dirname(replaced), { recursive: true });
    await writeFile(replaced, 'previous\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'file', path: replaced, content: 'next\n', mode: 0o755 }],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await subject.apply(plan);

    // Assert
    should(actual.backupResidue).equal(undefined);
    should(await readFile(replaced, 'utf8')).equal('next\n');
    await assertNoResidue(root);
  });
});
