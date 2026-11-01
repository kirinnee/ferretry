import { afterEach, describe, it } from 'bun:test';
import {
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
import { resolveStateHomes } from '../../src/lib/state-home-guard.ts';

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

const manifest: FleetManifest = { version: 1, generatedAt: '2027-01-15T08:00:00.000Z', accounts: [] };

/** What the state home holds, by name, so a test can prove none of it moved. */
const SECRETS: Readonly<Record<string, string>> = {
  'api-token': 'fy_admin_secret\n',
  'state/secrets.key': 'vault-key\n',
  'state/passkeys.json': '{"passkeys":[]}\n',
};

/** A state home with its secrets, the fleet's asset tree, and a runtime home whose skills folder holds two items. */
async function world() {
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
  );
  const plan = (operations: readonly FleetWriteOperation[]): FleetApplyPlan => ({
    manifest,
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
