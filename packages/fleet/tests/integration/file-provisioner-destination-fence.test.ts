import { afterEach, describe, it } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { DestinationFolders } from '../../src/adapters/destination-folders.ts';
import { FileFleetProvisioner } from '../../src/adapters/file-provisioner.ts';
import { FileMutationJournal } from '../../src/adapters/mutation-journal.ts';
import { NodeGuardDisk } from '../../src/adapters/node-guard-disk.ts';
import type { FleetManifest } from '../../src/lib/manifest.ts';
import { FleetApplyFailureError, type FleetApplyPlan, type FleetWriteOperation } from '../../src/lib/provisioning.ts';
import { type FolderDisk, type GuardedFolder, resolveStateHomes } from '../../src/lib/state-home-guard.ts';

/**
 * The provisioner's destination side (docs/agent-tools.md#component-destinations): a runtime's
 * folder is written by its harness, so a folder below the runtime's top folder can be swapped for a link into the
 * state home at any moment. Nothing below it is reached by path, so the swap moves and deletes nothing there.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fy-destination-fence-')));
  directories.push(directory);
  return directory;
}

/** A manifest declaring the runtime at `home`: its folder is the "top folder" the destination side reasons about. */
const manifestOf = (home: string): FleetManifest => ({
  version: 1,
  generatedAt: '2027-01-15T08:00:00.000Z',
  accounts: [
    {
      secretEnv: {},
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'claude',
      mode: 'auto',
      wrapper: '/placeholder/bin/claude-one',
      home,
      displayName: 'Runtime One',
      defaultModel: 'model-one',
      models: [{ id: 'model-one', displayName: 'Model One', available: true }],
      available: true,
      unavailableReason: null,
    },
  ],
});

/**
 * The disk every apply here uses unless a test names one. `FY_FLEET_DESCRIPTOR_REACH=calls` runs the whole file
 * through macOS's mechanism — each step a `fchdir` bracket on the held descriptor — on any POSIX host; on macOS
 * that is already the platform's own.
 */
const DEFAULT_DISK: FolderDisk | undefined =
  process.env.FY_FLEET_DESCRIPTOR_REACH === 'calls' ? new NodeGuardDisk('calls') : undefined;

/** What the state home holds, by name, so a test can prove none of it moved. */
const SECRETS: Readonly<Record<string, string>> = {
  'api-token': 'fy_admin_secret\n',
  'state/secrets.key': 'vault-key\n',
  'state/passkeys.json': '{"passkeys":[]}\n',
};

interface WorldOptions {
  /** The destination side's disk — `new NodeGuardDisk(false)` is macOS: no descriptor paths. */
  readonly disk?: FolderDisk;
}

/** A state home with its secrets, the fleet's asset tree, and a runtime home whose skills folder holds two items. */
async function world(options: WorldOptions = {}) {
  const machine = await temporary();
  const home = path.join(machine, '.ferretry');
  const state = path.join(home, 'state');
  const assets = path.join(home, 'fleet', 'assets');
  const runtime = path.join(home, 'fleet', 'homes', 'claude-one');
  const skills = path.join(runtime, 'skills');
  await mkdir(state, { recursive: true });
  await mkdir(path.join(home, 'config'), { recursive: true });
  await mkdir(path.join(assets, 'skills', 'kept'), { recursive: true });
  await writeFile(path.join(assets, 'skills', 'kept', 'SKILL.md'), 'Kept skill.\n');
  for (const [name, content] of Object.entries(SECRETS)) await writeFile(path.join(home, name), content);
  await mkdir(path.join(skills, 'stale'), { recursive: true });
  await writeFile(path.join(skills, 'stale', 'SKILL.md'), 'A skill the profile no longer has.\n');
  const subject = new FileFleetProvisioner(
    [home],
    undefined,
    {},
    { homes: [home, state, path.join(home, 'config')], open: [assets] },
    options.disk ?? DEFAULT_DISK,
  );
  const plan = (operations: readonly FleetWriteOperation[]): FleetApplyPlan => ({
    manifest: manifestOf(runtime),
    manifestPath: path.join(home, 'fleet', 'manifest.json'),
    operations,
  });
  return { machine, home, state, assets, runtime, skills, subject, plan };
}

/** Every secret is still where it was, with what it held, and nothing of the fleet's machinery landed in the home. */
async function assertHomeUntouched(home: string): Promise<void> {
  for (const [name, content] of Object.entries(SECRETS))
    should(await readFile(path.join(home, name), 'utf8')).equal(content);
  for (const folder of [home, path.join(home, 'state')]) {
    const residue = (await readdir(folder)).filter(name => name.startsWith('.fy-fleet-'));
    should(residue).deepEqual([]);
  }
}

/** Swaps the folder at `folder` for a link to `target`, as a harness that can write the folder above it can. */
async function swapForLink(folder: string, target: string, aside?: string): Promise<void> {
  if (aside === undefined) await rm(folder, { recursive: true, force: true });
  else await rename(folder, aside);
  await symlink(target, folder);
}

const settled = async (attempt: Promise<unknown>): Promise<unknown> => {
  try {
    return await attempt;
  } catch (error) {
    return error;
  }
};

describe('FileFleetProvisioner destination side', () => {
  it('should move and delete nothing in the state home when a runtime folder is swapped for a link right after its check', async () => {
    // Arrange — the skills folder passes its `directory` check, and the moment after, the harness swaps it for a
    // link into the home's state folder. The sweep that follows used to list the home's files through the link,
    // move each aside as a "stale skill", and delete them all when the apply committed.
    const { home, state, runtime, skills, subject, plan } = await world();
    const ensure: FleetWriteOperation = { kind: 'directory', path: skills, mode: 0o700 };
    const operations: FleetWriteOperation[] = [
      { kind: 'directory', path: runtime, mode: 0o700 },
      ensure,
      { kind: 'prune-directory', path: skills, keep: [] },
    ];
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'applyOperation') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<unknown>;
        return async (operation: FleetWriteOperation, journal: unknown) => {
          const result = await original.call(target, operation, journal);
          if (operation === ensure) await swapForLink(skills, state);
          return result;
        };
      },
    });

    // Act
    const outcome = await settled(racing.apply(plan(operations)));

    // Assert — refused, and every secret is still there.
    should(outcome).be.instanceof(Error);
    should((outcome as Error).message).match(/symbolic link stands where a folder must be/u);
    await assertHomeUntouched(home);
    should(await readlink(skills)).equal(state);
  });

  it('should not delete a backup whose folder was swapped for a link after the entry was moved aside', async () => {
    // Arrange — the sweep opens the real skills folder and starts moving stale items aside. Then the harness moves
    // that folder away and leaves a link into the home in its place. The move aside went through the folder that was
    // checked, so it landed there; every later step must find that folder by identity, see the link, and keep the
    // backup rather than reach — or delete — through the link.
    const { home, state, runtime, skills, subject, plan } = await world();
    // Named like the vault key, so a move aside through the link would take the home's own file.
    await rename(path.join(skills, 'stale'), path.join(skills, 'secrets.key'));
    const aside = path.join(runtime, 'skills-moved-away');
    const original = FileMutationJournal.prototype.capture;
    let swapped = false;
    FileMutationJournal.prototype.capture = async function (this: FileMutationJournal, ...args) {
      const [target] = args;
      if (!swapped && path.dirname(path.resolve(target)) === skills) {
        swapped = true;
        await swapForLink(skills, state, aside);
      }
      return await original.apply(this, args);
    };

    // Act
    let outcome: unknown;
    try {
      outcome = await settled(subject.apply(plan([{ kind: 'prune-directory', path: skills, keep: [] }])));
    } finally {
      FileMutationJournal.prototype.capture = original;
    }

    // Assert — nothing in the home moved; the stale item was moved aside inside the folder that was checked, and the
    // backup nothing could reach by identity any more is kept and named rather than deleted.
    should(swapped).be.true();
    await assertHomeUntouched(home);
    const kept = (await readdir(aside)).filter(name => name.startsWith('.fy-fleet-backup-'));
    should(kept).have.length(1);
    should(await readFile(path.join(aside, kept[0] as string, 'SKILL.md'), 'utf8')).equal(
      'A skill the profile no longer has.\n',
    );
    should(outcome).be.instanceof(FleetApplyFailureError);
    const failure = (outcome as FleetApplyFailureError).failure;
    should(failure.kind).equal('rollback-incomplete');
    if (failure.kind !== 'rollback-incomplete') return;
    should(failure.unrestored.map(entry => entry.backup)).deepEqual([path.join(skills, kept[0] as string)]);
  });

  it('should keep a committed backup whose folder was swapped for a link before the cleanup', async () => {
    // Arrange — the commit's cleanup deletes each backup. Its folder is reopened first and must be the folder the
    // backup was moved aside in; a link in its place is refused, so nothing is deleted through it.
    const { home, state, runtime, skills } = await world();
    const homes = await resolveStateHomes({ homes: [home, state, path.join(home, 'config')] }, new NodeGuardDisk());
    const journal = new FileMutationJournal(async () => undefined, new DestinationFolders(homes));
    const aside = path.join(runtime, 'skills-moved-away');
    const mark = journal.beginOperation();
    await journal.capture(path.join(skills, 'stale'));
    await journal.sealOperation(mark);
    await swapForLink(skills, state, aside);

    // Act
    const remaining = await journal.discard();

    // Assert — the backup is named, still where it was moved aside, and the home is untouched.
    const kept = (await readdir(aside)).filter(name => name.startsWith('.fy-fleet-backup-'));
    should(kept).have.length(1);
    should(remaining).deepEqual([path.join(skills, kept[0] as string)]);
    await assertHomeUntouched(home);
  });

  it('should remove a link inside a swept item without touching what it points at', async () => {
    // Arrange — a stale skill holds a link into the home. The sweep moves the skill aside and the commit removes the
    // backup; a removal that followed links would empty the home's state folder.
    const { home, state, runtime, skills, subject, plan } = await world();
    await symlink(state, path.join(skills, 'stale', 'state'));
    await symlink(path.join(home, 'api-token'), path.join(skills, 'stale', 'token'));

    // Act
    const outcome = await subject.apply(
      plan([
        { kind: 'directory', path: runtime, mode: 0o700 },
        { kind: 'directory', path: skills, mode: 0o700 },
        { kind: 'prune-directory', path: skills, keep: [] },
      ]),
    );

    // Assert — the stale skill and its backup are gone, and the home is exactly as it was.
    should(outcome.backupResidue).be.undefined();
    should(await readdir(skills)).deepEqual([]);
    await assertHomeUntouched(home);
  });

  it('should refuse to write a file into a runtime sub-folder that is a link into the state home', async () => {
    // Arrange — a nested destination (a command, a hook) under a folder the harness replaced with a link.
    const { home, state, runtime, subject, plan } = await world();
    const commands = path.join(runtime, 'commands');
    await symlink(state, commands);

    // Act
    const outcome = await settled(
      subject.apply(
        plan([{ kind: 'file', path: path.join(commands, 'secrets.key'), content: 'planted\n', mode: 0o600 }]),
      ),
    );

    // Assert — preflight follows the link to a place inside the roots; the write itself refuses it.
    should(outcome).be.instanceof(Error);
    should((outcome as Error).message).match(/symbolic link stands where a folder must be/u);
    await assertHomeUntouched(home);
  });

  it('should still provision a runtime normally through the checked folders', async () => {
    // Arrange
    const { home, assets, runtime, skills, subject, plan } = await world();
    const settingsPath = path.join(runtime, 'settings.json');
    await writeFile(settingsPath, '{"effort":"high"}\n');

    // Act
    const outcome = await subject.apply(
      plan([
        { kind: 'directory', path: runtime, mode: 0o700 },
        { kind: 'directory', path: skills, mode: 0o700 },
        { kind: 'copy', source: path.join(assets, 'skills', 'kept'), path: path.join(skills, 'kept') },
        { kind: 'prune-directory', path: skills, keep: ['kept'] },
        {
          kind: 'symlink',
          source: path.join(assets, 'skills', 'kept', 'SKILL.md'),
          path: path.join(runtime, 'CLAUDE.md'),
        },
        { kind: 'file', path: path.join(runtime, 'commands', 'hello.md'), content: 'Hello.\n', mode: 0o600 },
        {
          kind: 'settings',
          path: settingsPath,
          format: 'json',
          layers: [{ from: 'inline', settings: { model: 'model-one' } }],
          mode: 0o600,
          preserveExisting: true,
        },
      ]),
    );

    // Assert — every entry landed, the harness's own key survived, the stale item went, and nothing is left over.
    should(outcome.backupResidue).be.undefined();
    should(await readdir(skills)).deepEqual(['kept']);
    should(await readFile(path.join(skills, 'kept', 'SKILL.md'), 'utf8')).equal('Kept skill.\n');
    should((await lstat(path.join(runtime, 'CLAUDE.md'))).isSymbolicLink()).be.true();
    should(await readFile(path.join(runtime, 'commands', 'hello.md'), 'utf8')).equal('Hello.\n');
    should(JSON.parse(await readFile(settingsPath, 'utf8'))).deepEqual({ effort: 'high', model: 'model-one' });
    should((await readdir(runtime)).filter(name => name.startsWith('.fy-fleet-') || name.endsWith('.tmp'))).deepEqual(
      [],
    );
    await assertHomeUntouched(home);
  });
});

/** The failure an apply threw, or a test failure if it landed. */
const failureOf = async (attempt: Promise<unknown>): Promise<FleetApplyFailureError> => {
  const outcome = await settled(attempt);
  should(outcome).be.instanceof(FleetApplyFailureError);
  return outcome as FleetApplyFailureError;
};

/** Every regular file under `folder`, with its text, so a test can prove no secret was linked or copied in. */
async function textsUnder(folder: string): Promise<readonly string[]> {
  const texts: string[] = [];
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) texts.push(await readFile(path.join(entry.parentPath, entry.name), 'utf8'));
  }
  return texts;
}

describe('secrev-1262 M2 — without descriptor paths (macOS) nothing below a runtime is moved or removed', () => {
  it('should skip, and report, every operation that would move or remove a name below the runtime', async () => {
    // Arrange — every step there goes by path after a proof, so a well-timed swap could redirect it.
    const { home, assets, runtime, skills, subject, plan } = await world({ disk: new NodeGuardDisk(false) });
    const settingsPath = path.join(runtime, 'settings.json');

    // Act
    const outcome = await subject.apply(
      plan([
        { kind: 'directory', path: runtime, mode: 0o700 },
        { kind: 'directory', path: skills, mode: 0o700 },
        { kind: 'symlink', source: path.join(assets, 'skills', 'kept'), path: path.join(skills, 'kept') },
        { kind: 'symlink', source: path.join(assets, 'skills', 'kept'), path: path.join(skills, 'stale') },
        { kind: 'copy', source: path.join(assets, 'skills', 'kept'), path: path.join(skills, 'copied') },
        { kind: 'prune-directory', path: skills, keep: ['kept'] },
        {
          kind: 'settings',
          path: settingsPath,
          format: 'json',
          layers: [{ from: 'inline', settings: { model: 'model-one' } }],
          mode: 0o600,
          preserveExisting: true,
        },
      ]),
    );

    // Assert — a new link landed, the replacement, the copy and the sweep were left as the disk has them and said
    // so, the runtime's own top folder was written as usual, and the home is untouched.
    should((outcome.skipped ?? []).map(entry => entry.path)).deepEqual([
      path.join(skills, 'stale'),
      path.join(skills, 'copied'),
      skills,
    ]);
    should(outcome.skipped?.[0]?.reason).match(/not moving or removing .* on this platform/u);
    should(await readlink(path.join(skills, 'kept'))).equal(path.join(assets, 'skills', 'kept'));
    should(await readFile(path.join(skills, 'stale', 'SKILL.md'), 'utf8')).equal(
      'A skill the profile no longer has.\n',
    );
    should((await readdir(skills)).toSorted()).deepEqual(['kept', 'stale']);
    should(JSON.parse(await readFile(settingsPath, 'utf8'))).deepEqual({ model: 'model-one' });
    await assertHomeUntouched(home);
  });

  it('should report, not remove, what a failed apply created below the runtime', async () => {
    // Arrange — a later operation fails; taking back a file and a folder this apply made would be a move and a
    // removal below the runtime, so they are named instead.
    const { home, runtime, subject, plan } = await world({ disk: new NodeGuardDisk(false) });
    const blocker = path.join(home, 'fleet', 'blocker');
    await writeFile(blocker, 'a file where a folder is needed\n');
    const created = path.join(runtime, 'commands', 'hello.md');

    // Act
    const failure = (
      await failureOf(
        subject.apply(
          plan([
            { kind: 'file', path: created, content: 'Hello.\n', mode: 0o600 },
            { kind: 'file', path: path.join(blocker, 'unreachable'), content: 'never\n', mode: 0o600 },
          ]),
        ),
      )
    ).failure;

    // Assert
    should(failure.kind).equal('rollback-incomplete');
    if (failure.kind !== 'rollback-incomplete') return;
    should(failure.unrestored.map(entry => entry.path)).containEql(created);
    should(failure.unrestored.map(entry => entry.reason).join('\n')).match(/not moving or removing/u);
    should(await readFile(created, 'utf8')).equal('Hello.\n');
    await assertHomeUntouched(home);
  });
});

describe('secrev-1262 L1 — a Linux host with no /proc refuses loudly', () => {
  it('should refuse the apply rather than read every destination folder as empty', async () => {
    // Arrange
    const { machine, home, skills, plan } = await world();
    const noProc = new NodeGuardDisk(true, '/etc/group', path.join(machine, 'no-proc'));
    const subject = new FileFleetProvisioner([home], undefined, {}, undefined, noProc);

    // Act
    const outcome = await settled(subject.apply(plan([{ kind: 'prune-directory', path: skills, keep: [] }])));

    // Assert — refused, and the stale item is where it was.
    should((outcome as Error).message).match(/this host has no \/proc\/self\/fd/u);
    should(await readdir(skills)).deepEqual(['stale']);
  });
});

describe('secrev-1262 L2 — a pipe where a staged file was never blocks the daemon', () => {
  it('should refuse a staged file swapped for a pipe between its look and its read', async () => {
    // Arrange — a blocking open of a pipe with no writer never returns, on the thread holding the apply claim.
    const { home, assets, skills, subject, plan } = await world();
    const kit = path.join(assets, 'skills', 'kit');
    await mkdir(kit, { recursive: true });
    await writeFile(path.join(kit, 'SKILL.md'), 'Kit.\n');
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'publishFile') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          const from = args[0] as string;
          const staged = path.join(await realpath(path.dirname(from)), path.basename(from));
          await rm(staged);
          should(Bun.spawnSync(['mkfifo', staged]).exitCode).equal(0);
          return await original.apply(target, args);
        };
      },
    });

    // Act
    const failure = await failureOf(
      racing.apply(plan([{ kind: 'copy', source: kit, path: path.join(skills, 'kit') }])),
    );

    // Assert
    should(failure.message).match(/no longer a regular file/u);
    await assertHomeUntouched(home);
  });
});

describe('secrev-1262 — a publish swapped mid-tree reaches nothing in the home', () => {
  /** An asset skill with a file and a sub-folder of two files. */
  const kitIn = async (assets: string): Promise<string> => {
    const kit = path.join(assets, 'skills', 'kit');
    await mkdir(path.join(kit, 'sub'), { recursive: true });
    await writeFile(path.join(kit, 'SKILL.md'), 'Kit.\n');
    for (const name of ['one.md', 'two.md']) await writeFile(path.join(kit, 'sub', name), `${name}\n`);
    return kit;
  };

  it('should not link the home into the runtime when a staged sub-folder is swapped for a link to it', async () => {
    // Arrange — the staged copy sits in the runtime's own folder; its sub-folder is swapped for a link into the
    // home's state folder just before it is walked. Walked by path, every file of the home would be hard-linked
    // into the runtime, where its harness reads them.
    const { home, state, assets, runtime, skills, subject, plan } = await world();
    const kit = await kitIn(assets);
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'publishTree') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          const staged = args[0] as { readonly folder: { readonly path: string }; readonly leaf: string };
          if (staged.leaf === 'sub') await swapForLink(path.join(staged.folder.path, 'sub'), state);
          // Through the proxy, so the walk's own recursion comes back here.
          return await original.apply(receiver, args);
        };
      },
    });

    // Act
    const failure = await failureOf(
      racing.apply(plan([{ kind: 'copy', source: kit, path: path.join(skills, 'kit') }])),
    );

    // Assert — refused at the link, and no secret is anywhere under the runtime.
    should(failure.message).match(/symbolic link stands where a folder must be/u);
    should(await textsUnder(runtime)).not.containEql(SECRETS['state/secrets.key']);
    await assertHomeUntouched(home);
  });

  it('should not publish into the home when a destination sub-folder is swapped for a link to it', async () => {
    // Arrange — once the destination's sub-folder exists, the harness renames it away and leaves a link into the
    // home in its place, after its first file and before its second.
    const { home, state, assets, skills, subject, plan } = await world();
    const kit = await kitIn(assets);
    const sub = path.join(skills, 'kit', 'sub');
    let swapped = false;
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'publishFile') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          const identity = await original.apply(target, args);
          if (!swapped && path.dirname(args[3] as string) === sub) {
            swapped = true;
            await swapForLink(sub, state, path.join(skills, 'moved-away'));
          }
          return identity;
        };
      },
    });

    // Act
    const failure = await failureOf(
      racing.apply(plan([{ kind: 'copy', source: kit, path: path.join(skills, 'kit') }])),
    );

    // Assert — refused, and the home's state folder holds exactly what it held.
    should(swapped).be.true();
    should(failure.message).match(/replaced while the tree was being written/u);
    should((await readdir(state)).toSorted()).deepEqual(['passkeys.json', 'secrets.key']);
    await assertHomeUntouched(home);
  });
});

describe('secrev-1262 — a removal swapped mid-tree on a real disk', () => {
  // Hooks the disk's by-path open, which a descriptor-calls disk (macOS) never makes; its own swap test is in
  // descriptor-calls.test.ts.
  it.skipIf(process.platform !== 'linux')(
    'should remove nothing in the home when a sub-folder is swapped for a link while the tree is removed',
    async () => {
      // Arrange — the sub-folder is a folder when it is looked at, and a link into the home when it is opened.
      const { home, state, skills } = await world();
      const tree = path.join(skills, 'tree');
      await mkdir(path.join(tree, 'sub'), { recursive: true });
      await writeFile(path.join(tree, 'sub', 'notes.md'), 'notes\n');
      const homes = await resolveStateHomes({ homes: [home, state, path.join(home, 'config')] }, new NodeGuardDisk());
      let swapped = false;
      class SwappingDisk extends NodeGuardDisk {
        override async openDirectory(at: string) {
          if (!swapped && at.endsWith('/sub')) {
            swapped = true;
            const real = path.join(await realpath(path.dirname(at)), 'sub');
            await swapForLink(real, state, path.join(skills, 'moved-away'));
          }
          return await super.openDirectory(at);
        }
      }
      const folders = new DestinationFolders(homes, new SwappingDisk());

      // Act
      const outcome = await settled(
        folders.within(skills, async folder => await folders.remove(folder as GuardedFolder, 'tree')),
      );

      // Assert
      should(swapped).be.true();
      should((outcome as Error).message).match(
        /refusing to remove .*\/sub: the state-home guard refused it \(changed\)/u,
      );
      await assertHomeUntouched(home);
    },
  );
});

describe('the destination side — what each refusal says', () => {
  it('should refuse a host destination whose folder is a link into the state home, naming the home', async () => {
    // Arrange — a host config folder outside the home (a root of its own) that is a link into the home's state.
    const { machine, home, state, plan } = await world();
    const host = path.join(machine, 'host');
    await mkdir(host);
    await symlink(state, path.join(host, '.claude'));
    const fence = { homes: [home, state, path.join(home, 'config')], open: [] };
    const subject = new FileFleetProvisioner([home, host], undefined, {}, fence);

    // Act
    const outcome = await settled(
      subject.apply(
        plan([{ kind: 'file', path: path.join(host, '.claude', 'CLAUDE.md'), content: 'x\n', mode: 0o600 }]),
      ),
    );

    // Assert
    should((outcome as Error).message).match(/refusing to write in .*: it is inside this daemon's state home/u);
    await assertHomeUntouched(home);
  });

  it("should name the guard's rule for any other refusal", async () => {
    // Arrange
    const { home, state, runtime } = await world();
    const homes = await resolveStateHomes({ homes: [home, state] }, new NodeGuardDisk());
    const folders = new DestinationFolders(homes);

    // Act
    const outcome = await settled(
      folders.within(
        runtime,
        async folder => await folders.child(folder as GuardedFolder, 'nothing-here', 'the label'),
      ),
    );

    // Assert
    should((outcome as Error).message).equal(
      'refusing to write in the label: the state-home guard refused it (not-found)',
    );
  });

  it('should surface a name in a folder it may open but not search', async () => {
    // Arrange — the runtime folder can be listed but not entered (`r` without `x`).
    const { runtime, subject, plan } = await world();
    await chmod(runtime, 0o600);
    try {
      // Act
      const sweep = await settled(
        subject.apply(plan([{ kind: 'prune-directory', path: runtime, keep: [], only: ['x'] }])),
      );
      const sidecar = await settled(
        subject.apply(
          plan([
            {
              kind: 'codex-sqlite-ownership',
              path: path.join(runtime, 'config.toml'),
              markerPath: path.join(runtime, '.ferretry-sqlite-home.json'),
              sqliteHome: path.join(runtime, 'sqlite'),
              enabled: false,
            },
          ]),
        ),
      );

      // Assert — neither is mistaken for an absent file.
      should((sweep as Error).message).match(/EACCES|could not be installed as the working directory/u);
      should((sidecar as Error).message).match(/EACCES|could not be installed as the working directory/u);
    } finally {
      await chmod(runtime, 0o700);
    }
  });

  it('should replace a settings file an earlier operation of the same apply wrote', async () => {
    // Arrange — the second write finds the first one's file, which is this apply's own to clear.
    const { runtime, subject, plan } = await world();
    const settingsPath = path.join(runtime, 'settings.json');
    const settings = (model: string): FleetWriteOperation => ({
      kind: 'settings',
      path: settingsPath,
      format: 'json',
      layers: [{ from: 'inline', settings: { model } }],
      mode: 0o600,
      preserveExisting: false,
    });

    // Act
    await subject.apply(plan([settings('first'), settings('second')]));

    // Assert
    should(JSON.parse(await readFile(settingsPath, 'utf8'))).deepEqual({ model: 'second' });
  });
});

describe('secrev-1262 delta — without descriptor reach the move is refused unless the folder is known safe', () => {
  it('should confine a runtime folder that did not exist yet, under a linked folder, once it is made', async () => {
    // Arrange — a host runtime folder that is not there at the first check, under a folder reached through a link:
    // judged by the configured string, the folder made later (at its real place) would read as outside it.
    const { machine, home, state } = await world();
    const real = path.join(machine, 'host-real');
    await mkdir(real);
    await symlink(real, path.join(machine, 'host'));
    const top = path.join(machine, 'host', '.codex');
    const homes = await resolveStateHomes({ homes: [home, state] }, new NodeGuardDisk());
    const folders = new DestinationFolders(homes, new NodeGuardDisk(false), [
      top,
      path.join(home, 'fleet', 'homes', 'one'),
    ]);

    // Act — asked first while the host runtime's folder is not there, then of the folder made below it, then of
    // the fleet runtime's own folder and one below it.
    const before = await folders.made(path.join(home, 'fleet', 'bin'), 0o700);
    const daemonsOwn = await folders.confined(before);
    const made = await folders.made(path.join(top, 'skills'), 0o700);
    const runtime = await folders.made(path.join(home, 'fleet', 'homes', 'one'), 0o700);
    const below = await folders.made(path.join(home, 'fleet', 'homes', 'one', 'skills'), 0o700);

    // Assert — only the daemon's own folders (and a fleet runtime's own folder) may move or remove a name.
    should(daemonsOwn).be.false();
    should(await folders.confined(made)).be.true();
    should(await folders.confined(runtime)).be.false();
    should(await folders.confined(below)).be.true();
    for (const folder of [before, made, runtime, below]) await folder.close();
  });

  it("should skip a host runtime's own folder too, and say why descriptor reach is missing", async () => {
    // Arrange — the fallback when the C calls cannot load: a host runtime's settings already there.
    const { machine, home, state } = await world();
    const claude = path.join(machine, 'host', '.claude');
    await mkdir(claude, { recursive: true });
    const settingsPath = path.join(claude, 'settings.json');
    await writeFile(settingsPath, '{"effort":"high"}\n');
    const disk = Object.assign(new NodeGuardDisk(false), { descriptorCallsUnavailable: 'libSystem would not load' });
    const subject = new FileFleetProvisioner(
      [home, path.join(machine, 'host')],
      undefined,
      {},
      { homes: [home, state, path.join(home, 'config')], open: [] },
      disk,
    );

    // Act
    const outcome = await subject.apply({
      manifest: manifestOf(claude),
      manifestPath: path.join(home, 'fleet', 'manifest.json'),
      operations: [
        {
          kind: 'settings',
          path: settingsPath,
          format: 'json',
          layers: [{ from: 'inline', settings: { model: 'model-one' } }],
          mode: 0o600,
          preserveExisting: true,
        },
      ],
    });

    // Assert — left as it was, and the result says why.
    should(outcome.skipped).match([{ path: settingsPath }]);
    should(outcome.skipped?.[0]?.reason).match(/could not load the calls .*: libSystem would not load/u);
    should(await readFile(settingsPath, 'utf8')).equal('{"effort":"high"}\n');
    await assertHomeUntouched(home);
  });
});

describe('the destination side — retiring what an earlier apply put in a runtime', () => {
  it('should retire only a link or a name the last apply recorded, through the checked folder', async () => {
    // Arrange — a link, a recorded file, and a person's own file the record does not name.
    const { runtime, assets, subject, plan } = await world();
    await symlink(path.join(assets, 'skills', 'kept', 'SKILL.md'), path.join(runtime, 'linked.md'));
    await writeFile(path.join(runtime, 'recorded.md'), 'the last apply wrote this\n');
    await writeFile(path.join(runtime, 'own.md'), 'a person wrote this\n');
    const record = path.join(runtime, '.fy', 'materialised.json');
    await mkdir(path.dirname(record), { recursive: true });
    await writeFile(record, `${JSON.stringify({ version: 1, entries: ['recorded.md'] })}\n`);

    // Act
    await subject.apply(
      plan([
        {
          kind: 'prune-directory',
          path: runtime,
          keep: [],
          only: ['linked.md', 'recorded.md', 'own.md', 'gone.md'],
          record,
        },
      ]),
    );

    // Assert
    const left = (await readdir(runtime)).filter(name => name.endsWith('.md')).toSorted();
    should(left).deepEqual(['own.md']);
  });

  it('should treat a record that is not one, or cannot be read, as empty', async () => {
    // Arrange
    const { runtime, subject, plan } = await world();
    await writeFile(path.join(runtime, 'recorded.md'), 'kept\n');
    const record = path.join(runtime, 'materialised.json');
    await writeFile(record, 'not json');

    const unreadable = path.join(runtime, 'a-folder-not-a-record');
    await mkdir(unreadable);

    // Act — one record that is not JSON, one that cannot be read as a file at all.
    await subject.apply(plan([{ kind: 'prune-directory', path: runtime, keep: [], only: ['recorded.md'], record }]));
    await subject.apply(
      plan([{ kind: 'prune-directory', path: runtime, keep: [], only: ['recorded.md'], record: unreadable }]),
    );

    // Assert — nothing is proved to be the last apply's, so nothing is retired.
    should(await readFile(path.join(runtime, 'recorded.md'), 'utf8')).equal('kept\n');
  });
});
