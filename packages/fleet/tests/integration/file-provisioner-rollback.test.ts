import { afterEach, describe, it } from 'bun:test';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileFleetProvisioner } from '../../src/adapters/file-provisioner.ts';
import type { FleetManifest } from '../../src/lib/manifest.ts';
import {
  type FleetApplyFailure,
  FleetApplyFailureError,
  type FleetApplyPlan,
  type FleetWriteOperation,
} from '../../src/lib/provisioning.ts';
import type { SharedHistoryMigration } from '../../src/lib/shared-history.ts';

/**
 * A whole number of seconds, so `utimes` can restore it to the exact value a stat reported.
 *
 * Timestamps normally carry sub-millisecond precision that `utimes` cannot reproduce. Pinning one
 * is what lets a test change a file's *content* and nothing else, which is the only way to show
 * that the content digest is load-bearing rather than shadowed by the timestamp comparison.
 */
const PINNED_TIME_SECONDS = 1_700_000_000;

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

/**
 * Where a failure says it put the content it moved out of `target`.
 *
 * A half-published tree is never picked apart at its live path; it is renamed out whole, so a
 * writer's file inside it survives at the reported location rather than where they left it. The
 * report is how anybody finds it again, so the tests read it from the report rather than guessing
 * the generated name.
 */
const displacedTo = (failure: FleetApplyFailure, target: string): string => {
  should(failure.kind).equal('rollback-incomplete');
  if (failure.kind !== 'rollback-incomplete') throw new Error('expected rollback-incomplete');
  const moved = (failure.displaced ?? []).find(entry => entry.path === target);
  should(moved?.movedTo).be.a.String();
  return moved?.movedTo ?? '';
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
  it('should refuse to set the mode of a directory path that is a symbolic link', async () => {
    // Arrange — the account home is a link to a directory that is itself inside the allowed roots,
    // so every containment check passes. `chmod` follows the link, and `lstat` reports a link rather
    // than a directory, so no mode was recorded to undo: the target's permissions were changed and
    // the rollback still reported a clean restore. The undo path already refuses to restore a mode
    // through a link, so the forward path was doing what its own undo would not.
    const root = await temporaryDirectory();
    const real = path.join(root, 'fleet', 'homes', 'real-home');
    const linked = path.join(root, 'fleet', 'homes', 'one');
    const blocker = path.join(root, 'fleet', 'blocker');
    await mkdir(real, { recursive: true });
    await symlink(real, linked);
    await writeFile(blocker, 'a file where a directory is needed\n');
    const before = (await stat(real)).mode & 0o7777;
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'directory', path: linked, mode: 0o700 }, poisonAfter(blocker)],
    };

    // Act
    const actual = await failureOf(new FileFleetProvisioner([root]).apply(plan));

    // Assert — refused at the link, so the target keeps the permissions it had.
    should(actual.kind).equal('rolled-back');
    should(actual).match({ reason: /symbolic link.*chmod would change what it points at/su });
    should((await stat(real)).mode & 0o7777).equal(before);
    await assertNoResidue(root);
  });

  it('should still traverse a symlinked directory path when no mode is being set', async () => {
    // Arrange — being allowed to chmod through a link is the thing refused, not being allowed to
    // walk one. A directory operation with no mode changes nothing about the target.
    const root = await temporaryDirectory();
    const real = path.join(root, 'fleet', 'homes', 'real-home');
    const linked = path.join(root, 'fleet', 'homes', 'one');
    await mkdir(real, { recursive: true });
    await symlink(real, linked);
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'directory', path: linked }],
    };

    // Act
    const actual = await new FileFleetProvisioner([root]).apply(plan);

    // Assert — the apply landed, and the link is still a link to the same directory.
    should(actual.manifestPath).equal(plan.manifestPath);
    should(await Bun.file(plan.manifestPath).exists()).be.true();
    should((await lstat(linked)).isSymbolicLink()).be.true();
    should((await stat(linked)).isDirectory()).be.true();
  });

  it('should take back every name a half-published tree created and leave the account as it was', async () => {
    // Arrange — a tree is published entry by entry with primitives that refuse an existing name, so
    // a failure part-way used to leave a half-materialised account: one file of four visible under
    // the destination, with the account's own content moved aside. Every name the publish created
    // was created exclusively, which makes each provably ours and safe to take back out again.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skills');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    await mkdir(path.join(source, 'deep'), { recursive: true });
    for (const name of ['a.md', 'b.md', 'c.md']) await writeFile(path.join(source, name), `${name}\n`);
    await writeFile(path.join(source, 'deep', 'd.md'), 'd\n');
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'previous.md'), 'the account had this\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }],
    };
    const subject = new FileFleetProvisioner([root]);
    let published = 0;
    // A concurrent writer taking one of the names, which is exactly what `link` is there to catch.
    const interfered = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'publishFile') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<void>;
        return async (...args: unknown[]): Promise<void> => {
          published += 1;
          if (published === 2) throw Object.assign(new Error('EEXIST: file already exists, link'), { code: 'EEXIST' });
          return await original.call(target, ...args);
        };
      },
    });

    // Act
    const actual = await failureOf(interfered.apply(plan));

    // Assert — the account is exactly as it was, not half a new tree.
    should(actual.kind).equal('rolled-back');
    should(await readdir(destination)).deepEqual(['previous.md']);
    should(await readFile(path.join(destination, 'previous.md'), 'utf8')).equal('the account had this\n');
    await assertNoResidue(root);
  });

  it('should leave a name a concurrent writer populated rather than deleting their work', async () => {
    // Arrange — the unwind is non-recursive on purpose. A directory this publish created is only
    // provably ours while it is still empty; once somebody has written into it, `rmdir` refuses and
    // the destination stays occupied and is reported, which is true. A recursive delete here would
    // take their file with it.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skills');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    await mkdir(source, { recursive: true });
    for (const name of ['a.md', 'b.md']) await writeFile(path.join(source, name), `${name}\n`);
    await mkdir(path.dirname(destination), { recursive: true });
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }],
    };
    const subject = new FileFleetProvisioner([root]);
    const intruder = path.join(destination, 'theirs.md');
    let published = 0;
    // The second file fails, and by then a stranger has written into the directory this publish
    // created — so the unwind reaches a name it made but can no longer prove is only its own.
    const interfered = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'publishFile') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<void>;
        return async (...args: unknown[]): Promise<void> => {
          published += 1;
          if (published === 1) return await original.call(target, ...args);
          await writeFile(intruder, 'a harness wrote this at runtime\n');
          throw Object.assign(new Error('EEXIST: file already exists, link'), { code: 'EEXIST' });
        };
      },
    });

    // Act
    const actual = await failureOf(interfered.apply(plan));

    // Assert — the tree was taken out whole rather than picked apart, so their file went with it
    // and is findable at the reported location. Nothing of theirs was deleted, and freeing the
    // destination is what let the account's own state be restored underneath.
    const moved = displacedTo(actual, destination);
    should(await readFile(path.join(moved, path.basename(intruder)), 'utf8')).equal(
      'a harness wrote this at runtime\n',
    );
    should(await Bun.file(intruder).exists()).be.false();
  });

  it('should not delete a replacement somebody put under a name this publish had created', async () => {
    // Arrange — the retract must not destroy a file it did not write. A concurrent writer can
    // unlink our published file and put their own there under the same name, and an unwind that
    // deleted by path would remove their replacement while calling it our own cleanup. Nothing is
    // deleted by path now: the tree goes out whole, is compared against what this publish recorded,
    // and a mismatch keeps it. Their bytes end up at the reported location, never destroyed.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skills');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    await mkdir(source, { recursive: true });
    for (const name of ['a.md', 'b.md']) await writeFile(path.join(source, name), `${name}\n`);
    await mkdir(path.dirname(destination), { recursive: true });
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }],
    };
    const subject = new FileFleetProvisioner([root]);
    let published = 0;
    let replaced = '';
    // Deterministic interleaving: the second publish swaps the first file for a stranger's — a
    // different inode under the same name — and then fails, so the unwind meets it immediately.
    const interfered = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'publishFile') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<void>;
        return async (...args: unknown[]): Promise<void> => {
          published += 1;
          if (published === 1) {
            await original.call(target, ...args);
            replaced = args[1] as string;
            return;
          }
          await rm(replaced, { force: true });
          await writeFile(replaced, 'a stranger wrote this\n');
          throw Object.assign(new Error('EEXIST: file already exists, link'), { code: 'EEXIST' });
        };
      },
    });

    // Act
    const actual = await failureOf(interfered.apply(plan));

    // Assert — the swapped file is intact at the reported location, and gone from the live path
    // only because the whole tree was moved there.
    const moved = displacedTo(actual, destination);
    should(await readFile(path.join(moved, path.basename(replaced)), 'utf8')).equal('a stranger wrote this\n');
  });

  it('should record what it linked, not what occupies the name once the link has returned', async () => {
    // Arrange — the gap this closes is between `link` succeeding and the identity being read. If the
    // identity came from the live name, a writer who replaces the file in that gap has *their* file
    // blessed as this publish's own work, and the retract is then entitled to delete it: the
    // verification would agree, because it was told their file is ours. The evidence is taken from
    // the staged entry the link was made from, so the substitution changes nothing it believes.
    //
    // The interleaving is the exact one described: let the real publish run, then swap the live file
    // underneath before returning to the caller that records it.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skills');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    await mkdir(source, { recursive: true });
    for (const name of ['a.md', 'b.md']) await writeFile(path.join(source, name), `${name}\n`);
    await mkdir(path.dirname(destination), { recursive: true });
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }],
    };
    const subject = new FileFleetProvisioner([root]);
    let published = 0;
    let swapped = '';
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'publishFile') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<string>;
        return async (...args: unknown[]): Promise<string> => {
          published += 1;
          // The second child fails *before* it is published, so the tree that comes back out holds
          // exactly the entries the publish recorded. That matters: a file on disk that was never
          // recorded fails the entry-set check on its own, and the tree would then be preserved
          // whatever the identity evidence said — the test would pass without testing the proof.
          if (published > 1) throw new Error('the tree could not be finished');
          const identity = await original.call(target, ...args);
          // The link has landed and the caller has not yet recorded anything. Take the name.
          swapped = args[1] as string;
          await rm(swapped, { force: true });
          await writeFile(swapped, 'a stranger wrote this\n');
          return identity;
        };
      },
    });

    // Act
    const actual = await failureOf(racing.apply(plan));

    // Assert — their file was never deleted. It travelled out with the displaced tree, which was
    // preserved rather than removed precisely because it no longer matched what was published.
    const moved = displacedTo(actual, destination);
    should(await readFile(path.join(moved, path.basename(swapped)), 'utf8')).equal('a stranger wrote this\n');
  });

  it('should not bless an edit made through the published inode as this publish’s own work', async () => {
    // Arrange — the sibling of the replacement race, and the one an inode cannot catch. The
    // published name and the staged name are the same inode, so a writer who edits *through* the
    // published file changes what the staged file reports too. Evidence read from either name after
    // the link would therefore describe their edit and bless it, and the retract would delete their
    // work. The proof is taken before the link exists, and it includes the content, so the edit has
    // nothing to hide behind: the tree no longer matches and is preserved.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skills');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    await mkdir(source, { recursive: true });
    for (const name of ['a.md', 'b.md']) await writeFile(path.join(source, name), `${name}\n`);
    await mkdir(path.dirname(destination), { recursive: true });
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }],
    };
    const subject = new FileFleetProvisioner([root]);
    let published = 0;
    let edited = '';
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'publishFile') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<string | undefined>;
        return async (...args: unknown[]): Promise<string | undefined> => {
          published += 1;
          // Fails before publishing, so nothing unrecorded reaches the tree and the entry-set check
          // cannot be what preserves it. The digest has to be the thing that notices.
          if (published > 1) throw new Error('the tree could not be finished');

          // Normalise the timestamp *before* the proof is taken, and hand the proof a fresh stat of
          // the normalised file. A file's `mtimeMs` carries sub-millisecond precision that `utimes`
          // cannot put back, so without this the restored time would differ on its own and the
          // timestamp — not the digest — would be what catches the edit. Pinned to an exact whole
          // number of seconds, every stat field the proof records is one this test can reproduce
          // exactly afterwards, which leaves the content as the only thing that can differ.
          const staged = args[0] as string;
          await utimes(staged, PINNED_TIME_SECONDS, PINNED_TIME_SECONDS);
          const identity = await original.call(target, staged, args[1], await lstat(staged));

          // Same inode, opened by name and written in place — no unlink, no new file — and the same
          // byte length, so size is unchanged too.
          edited = args[1] as string;
          const handle = await open(edited, 'r+');
          await handle.write('THEIR', 0);
          await handle.close();
          await utimes(edited, PINNED_TIME_SECONDS, PINNED_TIME_SECONDS);
          return identity;
        };
      },
    });

    // Act
    const actual = await failureOf(racing.apply(plan));

    // Assert — their edit survives at the reported location; nothing was deleted over it. Size and
    // mtime are unchanged from what was recorded, so only the digest can have caught this.
    const moved = displacedTo(actual, destination);
    should(await readFile(path.join(moved, path.basename(edited)), 'utf8')).equal('THEIR');
  });

  it('should refuse to read a published entry through a link rather than following it', async () => {
    // Arrange — the retract re-reads each entry of the displaced tree to prove it is still this
    // publish's own work. If a published file was replaced by a symlink during the publish window,
    // the entry is `lstat`ed as a link and then opened; without a no-follow, the open reads through
    // it. The deletion decision was already safe — a link never matches a file's recorded identity
    // — but a link aimed at a FIFO makes the open itself block, and a retract that never returns is
    // a worse failure than a refusal. The refusal is what is pinned here: no proof, so the tree is
    // kept and reported rather than removed, and the read never leaves the tree.
    //
    // A bounded non-blocking writer probe makes the open observable. With no-follow, the apply
    // finishes without any reader reaching the FIFO and every writer attempt gets `ENXIO`. Against
    // the regressed code, a writer succeeds as soon as the reader blocks in its open, then closes
    // and lets the retract finish. The final read/write opener is a safety backstop after the bound,
    // so even broken code cannot leave the suite hung.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skills');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    const elsewhere = path.join(root, 'somebody-elses-pipe');
    await mkdir(source, { recursive: true });
    for (const name of ['a.md', 'b.md']) await writeFile(path.join(source, name), `${name}\n`);
    const mkfifo = Bun.spawn(['mkfifo', elsewhere], { stdout: 'ignore', stderr: 'ignore' });
    should(await mkfifo.exited).equal(0);
    await mkdir(path.dirname(destination), { recursive: true });
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }],
    };
    const subject = new FileFleetProvisioner([root]);
    let published = 0;
    let swapped = '';
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'publishFile') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<string | undefined>;
        return async (...args: unknown[]): Promise<string | undefined> => {
          published += 1;
          // Fails before publishing, so the displaced tree holds exactly the recorded entries.
          if (published > 1) throw new Error('the tree could not be finished');
          const identity = await original.call(target, ...args);
          swapped = args[1] as string;
          await rm(swapped, { force: true });
          await symlink(elsewhere, swapped);
          return identity;
        };
      },
    });

    let applySettled = false;
    const targetWasOpened = async (): Promise<boolean> => {
      const deadline = Date.now() + 1_000;
      while (!applySettled && Date.now() < deadline) {
        try {
          const writer = await open(elsewhere, constants.O_WRONLY | constants.O_NONBLOCK);
          await writer.close();
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENXIO') throw error;
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }
      if (applySettled) return false;
      const release = await open(elsewhere, constants.O_RDWR | constants.O_NONBLOCK);
      await release.close();
      return true;
    };

    // Act
    const applying = failureOf(racing.apply(plan)).finally(() => {
      applySettled = true;
    });
    const [actual, followed] = await Promise.all([applying, targetWasOpened()]);

    // Assert — the link is intact where it was put, and no reader ever reached its FIFO target.
    const moved = displacedTo(actual, destination);
    const link = path.join(moved, path.basename(swapped));
    should((await lstat(link)).isSymbolicLink()).be.true();
    should(followed).be.false();
  });

  it('should refuse to keep writing through a destination swapped for a link to somewhere else', async () => {
    // Arrange — the nastiest of these. Once the destination directory exists, a writer can rename
    // it away and put a symlink to an unrelated directory in its place. Every later step reaches
    // that name by path: the next child's `link` would land a file inside *their* directory, and the
    // final `chmod` would change *their* permissions — and a plain `open` is no defence, because
    // opening a symlink to a directory succeeds and reports a directory.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skills');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    const outside = path.join(root, 'somebody-elses-directory');
    await mkdir(source, { recursive: true });
    for (const name of ['a.md', 'b.md']) await writeFile(path.join(source, name), `${name}\n`);
    await mkdir(outside, { recursive: true, mode: 0o755 });
    await mkdir(path.dirname(destination), { recursive: true });
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }],
    };
    const subject = new FileFleetProvisioner([root]);
    let published = 0;
    // Pinned interleaving: the swap happens after the first child lands and before the next one.
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'publishFile') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<string | undefined>;
        return async (...args: unknown[]): Promise<string | undefined> => {
          published += 1;
          const identity = await original.call(target, ...args);
          if (published === 1) {
            await rename(destination, path.join(root, 'moved-away'));
            await symlink(outside, destination);
          }
          return identity;
        };
      },
    });

    // Act
    const actual = await failureOf(racing.apply(plan));

    // Assert — nothing of ours reached their directory, and their permissions are untouched.
    should(await readdir(outside)).deepEqual([]);
    should((await stat(outside)).mode & 0o7777).equal(0o755);
    // And the report is the exact one this promises, not merely "some kind of failure". The
    // replacement link was moved out whole and kept, because a symlink is not what was published;
    // "rolled-back" here would be a false clean report over a host that still has state moved.
    should(actual.kind).equal('rollback-incomplete');
    if (actual.kind !== 'rollback-incomplete') return;
    should(actual.reason).match(/replaced while the tree was being written/u);
    const moved = displacedTo(actual, destination);
    should((await lstat(moved)).isSymbolicLink()).be.true();
    // Their directory is what it pointed at, and it is still there with its own name.
    should(await realpath(moved)).equal(await realpath(outside));
    should((await lstat(path.join(root, 'moved-away'))).isDirectory()).be.true();
  });

  it('should refuse to restore over something created at the destination after it was freed', async () => {
    // Arrange — moving the partial tree out leaves the destination name free, and free is a name
    // somebody else may take. The restore that follows must not treat an empty-looking destination
    // as its own to fill: it puts the account's content back only where nothing has appeared.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skills');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    await mkdir(source, { recursive: true });
    for (const name of ['a.md', 'b.md']) await writeFile(path.join(source, name), `${name}\n`);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'previous.md'), 'the account had this\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }],
    };
    const subject = new FileFleetProvisioner([root]);
    let published = 0;
    // The publish fails part-way, and somebody claims the freed name in the moment between the
    // retract that frees it and the restore that would put the account's content back.
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'publishFile' && property !== 'retractPublication') {
          return Reflect.get(target, property, receiver);
        }
        const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<void>;
        if (property === 'publishFile') {
          return async (...args: unknown[]): Promise<void> => {
            published += 1;
            if (published === 1) return await original.call(target, ...args);
            throw new Error('the tree could not be finished');
          };
        }
        return async (...args: unknown[]): Promise<void> => {
          await original.call(target, ...args);
          await mkdir(destination, { recursive: true });
          await writeFile(path.join(destination, 'mine.md'), 'somebody took this name\n');
        };
      },
    });

    // Act
    const actual = await failureOf(racing.apply(plan));

    // Assert — their directory is untouched, and the account's own content is named where it sits
    // rather than being forced back over them.
    should(actual.kind).equal('rollback-incomplete');
    if (actual.kind !== 'rollback-incomplete') return;
    should(await readFile(path.join(destination, 'mine.md'), 'utf8')).equal('somebody took this name\n');
    const backup = actual.unrestored.find(entry => entry.path === destination)?.backup ?? '';
    should(await readFile(path.join(backup, 'previous.md'), 'utf8')).equal('the account had this\n');
  });

  it('should keep reporting the original failure when the partial tree cannot be moved at all', async () => {
    // Arrange — the retract runs while an apply is already failing, so it must never become the
    // reported error. Here the destination's parent is made unwritable, so the rename cannot happen
    // and the half-published tree simply stays; the apply still says what actually went wrong, and
    // the occupied destination is reported rather than silently tolerated.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skills');
    const parent = path.join(root, 'fleet', 'homes', 'one');
    const destination = path.join(parent, 'skills');
    await mkdir(source, { recursive: true });
    for (const name of ['a.md', 'b.md']) await writeFile(path.join(source, name), `${name}\n`);
    await mkdir(parent, { recursive: true });
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }],
    };
    const subject = new FileFleetProvisioner([root]);
    let published = 0;
    const interfered = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'publishFile') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<void>;
        return async (...args: unknown[]): Promise<void> => {
          published += 1;
          if (published === 1) return await original.call(target, ...args);
          await chmod(parent, 0o500);
          throw new Error('the tree could not be finished');
        };
      },
    });

    // Act
    let actual: FleetApplyFailure;
    try {
      actual = await failureOf(interfered.apply(plan));
    } finally {
      await chmod(parent, 0o700);
    }

    // Assert — the cause survives, not a cleanup error.
    should(actual.reason).match(/the tree could not be finished/u);
    should(actual.kind).equal('rollback-incomplete');
    if (actual.kind !== 'rollback-incomplete') return;
    should(actual.unrestored.map(entry => entry.path)).containEql(destination);
  });

  it('should verify a clean rollback of a tree far larger than the seal once held in memory', async () => {
    // Arrange — the seal used to collect one line per entry into an array and give up past a couple
    // of thousand, and an unsummarisable tree never compares equal. So a large skills tree could
    // never be proved unchanged, and even a flawless rollback of one had to be reported unverified.
    // Folding each entry into a running hash removes the memory cost that forced that bound.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skills');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    const blocker = path.join(root, 'fleet', 'blocker');
    await mkdir(source, { recursive: true });
    await Promise.all(
      Array.from({ length: 2500 }, (_, index) => writeFile(path.join(source, `skill-${index}.md`), `${index}\n`)),
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await mkdir(path.join(root, 'fleet'), { recursive: true });
    await writeFile(blocker, 'a file where a directory is needed\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }, poisonAfter(blocker)],
    };

    // Act
    const actual = await failureOf(new FileFleetProvisioner([root]).apply(plan));

    // Assert — a clean restore, proved rather than assumed, on 2500 entries.
    should(actual.kind).equal('rolled-back');
    should(await Bun.file(destination).exists()).be.false();
    await assertNoResidue(root);
  });

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

  it('should report a directory it created that somebody else has since put a file in', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const created = path.join(root, 'homes', 'one');
    const intruder = path.join(created, 'not-ours.txt');
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
        { kind: 'directory', path: created, mode: 0o700 },
        interfere,
        poisonAfter(path.join(root, 'interfere')),
      ],
    };
    const subject = new FileFleetProvisioner([root]);
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'applyOperation') return Reflect.get(target, property, receiver);
        return async (operation: FleetWriteOperation, journal: unknown) => {
          const run = await (
            Reflect.get(target, property, receiver) as (a: FleetWriteOperation, b: unknown) => Promise<string[]>
          ).call(target, operation, journal);
          if (operation === interfere) await writeFile(intruder, 'somebody else works here\n');
          return run;
        };
      },
    });

    // Act
    const actual = await failureOf(racing.apply(plan));

    // Assert — their file survives, and the directory this apply created is named as unrestored.
    should(actual.kind).equal('rollback-incomplete');
    if (actual.kind !== 'rollback-incomplete') return;
    should(await readFile(intruder, 'utf8')).equal('somebody else works here\n');
    should(actual.unrestored.map(entry => entry.path)).containEql(created);
    should(actual.unrestored.find(entry => entry.path === created)?.reason).match(/no longer empty/u);
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

  it('should name an unclearable claim inside the committed state, not only beside it', async () => {
    // Arrange — the same committed-then-history-failed outcome, with a claim that cannot be
    // released. `FleetApplyCommittedState.lockResidue` was never populated: the committed state is
    // built inside the lock and the residue only exists after the release, so the field production
    // could never fill was rendered by readers that would never see it. The state is completed on
    // the way out instead. A committed fleet whose claim is stuck blocks the next apply, and that is
    // part of what the host now is.
    const root = await temporaryDirectory();
    const wrapper = path.join(root, 'fleet', 'bin', 'claude-kirin');
    const manifestPath = path.join(root, 'fleet', 'manifest.json');
    const lockPath = path.join(root, 'fleet', '.fy-fleet-apply.lock');
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
        // A successor took the claim while this apply was running, so the release cannot clear it.
        // Published the way the lock publishes: a directory holding one token-named file.
        await rm(lockPath, { recursive: true, force: true });
        await mkdir(lockPath, { recursive: true });
        await writeFile(
          path.join(lockPath, 'claim-the-successor.json'),
          `${JSON.stringify({ owner: 1, token: 'the-successor', at: 0 })}\n`,
        );
        throw new Error('history pool is locked');
      },
    } as unknown as SharedHistoryMigration;
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath,
      operations: [{ kind: 'file', path: wrapper, content: '#!/bin/sh\nexec true\n', mode: 0o755 }],
      sharedHistoryRequests: [{ kind: 'claude', poolRoot: path.join(root, 'fleet', 'shared'), homes: [] }],
    };

    // Act
    const actual = await failureOf(new FileFleetProvisioner([root], sharedHistory).apply(plan));

    // Assert — reported in both places, so a reader that shows only the committed state still sees
    // it, and one that shows both can tell they are the same claim rather than two.
    should(actual.kind).equal('history-failed-after-commit');
    if (actual.kind !== 'history-failed-after-commit') return;
    should(actual.committed.lockResidue).equal(lockPath);
    should(actual.committed.manifestPath).equal(manifestPath);
  });

  it('should leave the committed state alone when the claim released cleanly', async () => {
    // Arrange — the field is absent rather than present-and-empty when there is nothing stuck.
    const root = await temporaryDirectory();
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
      operations: [],
      sharedHistoryRequests: [{ kind: 'claude', poolRoot: path.join(root, 'fleet', 'shared'), homes: [] }],
    };

    // Act
    const actual = await failureOf(new FileFleetProvisioner([root], sharedHistory).apply(plan));

    // Assert
    should(actual.kind).equal('history-failed-after-commit');
    if (actual.kind !== 'history-failed-after-commit') return;
    should(Object.hasOwn(actual.committed, 'lockResidue')).be.false();
  });

  it('should refuse to delete a copied tree whose child somebody else edited', async () => {
    // Arrange — the destination directory's own inode and timestamp do not move when a file inside
    // it is rewritten, so a seal that only described the root would call this tree ours and delete
    // the edit recursively while reporting a clean rollback.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skills');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    const contested = path.join(destination, 'nested', 'skill.md');
    await mkdir(path.join(source, 'nested'), { recursive: true });
    await writeFile(path.join(source, 'nested', 'skill.md'), 'ours\n');
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'previous.md'), 'the account had this\n');
    const interfere: FleetWriteOperation = {
      kind: 'file',
      path: path.join(root, 'interfere'),
      content: 'x\n',
      mode: 0o600,
    };
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }, interfere, poisonAfter(path.join(root, 'interfere'))],
    };
    const subject = new FileFleetProvisioner([root]);
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'applyOperation') return Reflect.get(target, property, receiver);
        return async (operation: FleetWriteOperation, journal: unknown) => {
          const run = await (
            Reflect.get(target, property, receiver) as (a: FleetWriteOperation, b: unknown) => Promise<string[]>
          ).call(target, operation, journal);
          if (operation === interfere) await writeFile(contested, 'somebody else edited this\n');
          return run;
        };
      },
    });

    // Act
    const actual = await failureOf(racing.apply(plan));

    // Assert — their edit survives and the tree is reported, not silently removed.
    should(actual.kind).equal('rollback-incomplete');
    if (actual.kind !== 'rollback-incomplete') return;
    should(await readFile(contested, 'utf8')).equal('somebody else edited this\n');
    should(actual.unrestored.map(entry => entry.path)).containEql(destination);
    const backup = actual.unrestored.find(entry => entry.path === destination)?.backup ?? '';
    should(await readFile(path.join(backup, 'previous.md'), 'utf8')).equal('the account had this\n');
  });

  it('should refuse to publish over a file somebody created inside the destination tree', async () => {
    // Arrange — the destination directory is claimed exclusively, but a concurrent writer can still
    // create a child name inside it before the tree finishes publishing. Replacing that child would
    // be the same silent clobber at one level down.
    const root = await temporaryDirectory();
    const source = path.join(root, 'assets', 'skills');
    const destination = path.join(root, 'fleet', 'homes', 'one', 'skills');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'skill.md'), 'ours\n');
    await mkdir(path.dirname(destination), { recursive: true });
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'copy', source, path: destination }],
    };
    const subject = new FileFleetProvisioner([root]);
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'publishFile') return Reflect.get(target, property, receiver);
        return async (from: string, to: string, information: unknown) => {
          // Somebody claims this exact child name after its parent was created and immediately
          // before the link that would place ours.
          await writeFile(to, 'somebody else got here first\n');
          return await (
            Reflect.get(target, property, receiver) as (a: string, b: string, c: unknown) => Promise<void>
          ).call(target, from, to, information);
        };
      },
    });

    // Act
    const actual = await failureOf(racing.apply(plan));

    // Assert — their file survives, and the apply says the host is not as it was. It survives at
    // the location the failure names: the directory this publish created had to come back out, and
    // it could not be picked apart around their file without deleting at a live path, so it was
    // moved out whole with their file inside it.
    const moved = displacedTo(actual, destination);
    should(await readFile(path.join(moved, 'skill.md'), 'utf8')).equal('somebody else got here first\n');
  });

  it('should refuse to prune a wrapper that was replaced between being read and being removed', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const binDirectory = path.join(root, 'fleet', 'bin');
    const stale = path.join(binDirectory, 'claude-retired');
    await mkdir(binDirectory, { recursive: true });
    await writeFile(stale, '#!/bin/sh\n# managed-marker\nexec true\n');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [{ kind: 'prune', path: binDirectory, marker: '# managed-marker', keep: [] }],
    };
    const subject = new FileFleetProvisioner([root]);
    const racing = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'stillCarries') return Reflect.get(target, property, receiver);
        // The sweep read a managed wrapper; by the time it was moved aside it was somebody's file.
        return async () => false;
      },
    });

    // Act
    const actual = await failureOf(racing.apply(plan));

    // Assert — the rollback puts it back rather than the sweep replacing it by hand.
    should(actual.kind).equal('rolled-back');
    should(await readFile(stale, 'utf8')).equal('#!/bin/sh\n# managed-marker\nexec true\n');
  });

  it('should refuse to write a document whose file was deleted after the change was composed', async () => {
    // Arrange — a change composed against an existing file must not quietly recreate it once
    // somebody has deleted it; the author of the change never saw that deletion.
    const root = await temporaryDirectory();
    const document = path.join(root, 'fleet', 'config.yaml');
    await mkdir(path.dirname(document), { recursive: true });
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    const actual = await failureOf(
      subject.apply(plan, [
        { path: document, content: 'agents: []\n', mode: 0o600, expect: 'a-digest-of-what-is-no-longer-there' },
      ]),
    );

    // Assert
    should(actual.kind).equal('rolled-back');
    should(actual.kind === 'rolled-back' && actual.reason).match(/not what this change was composed against/u);
    should(await Bun.file(document).exists()).be.false();
  });

  it('should write a document that expected to find nothing and finds nothing', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const document = path.join(root, 'fleet', 'assets', 'CLAUDE.md');
    const plan: FleetApplyPlan = {
      manifest: manifest(),
      manifestPath: path.join(root, 'fleet', 'manifest.json'),
      operations: [],
    };
    const subject = new FileFleetProvisioner([root]);

    // Act
    await subject.apply(plan, [{ path: document, content: 'be brief\n', mode: 0o600, expect: 'absent' }]);

    // Assert
    should(await readFile(document, 'utf8')).equal('be brief\n');
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
