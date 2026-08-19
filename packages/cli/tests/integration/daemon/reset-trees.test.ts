import { afterEach, describe, it } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileResetTrees } from '../../../src/adapters/daemon/reset-trees.ts';
import { FileRetiredArtifacts } from '../../../src/adapters/daemon/retired-artifacts.ts';

/**
 * The trees a reset destroys, against a real filesystem.
 *
 * Two of this port's three promises are unprovable against a fake: a directory sealed to 0555 refuses
 * to have anything unlinked out of it, and a symbolic link is only really not followed if the thing it
 * points at is still there afterwards. Both are exactly the properties whose failure is silent — a
 * reset that "worked" while leaving 100MB behind, or one that deleted somebody's real data through a
 * link — so both are asserted here, on the actual kernel.
 */

const roots = new Set<string>();

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-reset-trees-'));
  roots.add(root);
  return root;
}

/** `lstat`, because these trees hold directories and symbolic links, not only regular files. */
async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * A state home shaped like a real one, with a sealed snapshot store inside the artifact tree.
 *
 * The sealed part is not decoration: an upgraded host really does carry a store whose every snapshot
 * directory is 0555, and it sits inside the second of the two roots a reset removes. If the reset's
 * removal could not unseal, that tree would survive every reset forever.
 */
async function installation(root: string): Promise<{ home: string; artifacts: string }> {
  const home = join(root, 'home', '.ferretry');
  await mkdir(join(home, 'config'), { recursive: true });
  await mkdir(join(home, 'fleet'), { recursive: true });
  await mkdir(join(home, 'logs'), { recursive: true });
  await writeFile(join(home, 'layout-version'), '1\n');
  await writeFile(join(home, 'api-token'), 'fy_token');
  await writeFile(join(home, 'config', 'daemon.json'), '{}');
  await writeFile(join(home, 'logs', 'fyd.log'), 'x'.repeat(100));

  const artifacts = join(root, 'state', 'ferretry');
  const snapshot = join(artifacts, 'daemon-snapshots', 'fyd', 'snapshots', `sha256-${'a'.repeat(64)}`);
  await mkdir(snapshot, { recursive: true });
  await writeFile(join(snapshot, 'fyd'), 'x'.repeat(1_000));
  await chmod(join(snapshot, 'fyd'), 0o555);
  await chmod(snapshot, 0o555);
  return { home, artifacts };
}

afterEach(async () => {
  for (const root of roots) {
    // The fixtures seal directories read-only, so the tidy-up needs the same unsealing the subject does.
    await new FileRetiredArtifacts().retire(root);
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe('measuring the trees a reset would remove', () => {
  it('should measure a tree without modifying a single byte of it', async () => {
    // Arrange — a measurement runs before anybody has confirmed anything, so it may not touch the tree.
    const root = await createTemporaryRoot();
    const { home } = await installation(root);

    // Act
    const measured = await new FileResetTrees().measure(home);

    // Assert — four regular files, and the log accounts for most of the bytes.
    should(measured).have.property('kind', 'measured');
    should(measured).have.property('files', 4);
    should(measured).have.property('bytes', 2 + 8 + 2 + 100);
    should(await readFile(join(home, 'logs', 'fyd.log'), 'utf8')).have.length(100);
    should(await exists(join(home, 'config', 'daemon.json'))).be.true();
  });

  it('should leave a sealed directory sealed, because a measurement is not a removal', async () => {
    // Arrange
    const root = await createTemporaryRoot();
    const { artifacts } = await installation(root);
    const snapshot = join(artifacts, 'daemon-snapshots', 'fyd', 'snapshots', `sha256-${'a'.repeat(64)}`);

    // Act
    await new FileResetTrees().measure(artifacts);

    // Assert — unsealing during a measurement would be a write to a tree nobody has authorized
    // touching yet, and would leave the mode changed if the person then aborted.
    should((await lstat(snapshot)).mode & 0o777).equal(0o555);
  });

  it('should answer absent for a host that has no such tree, and create nothing', async () => {
    // Arrange — the ordinary case for the artifact tree on any install after the snapshot store went.
    const root = await createTemporaryRoot();
    const absent = join(root, 'state', 'ferretry');

    // Act
    const measured = await new FileResetTrees().measure(absent);

    // Assert
    should(measured).deepEqual({ kind: 'absent' });
    should(await exists(join(root, 'state'))).be.false();
  });

  it('should name a link that points out of the tree, and keep quiet about one that stays inside', async () => {
    // Arrange — FY_HOME bans links with ONE exemption, `fleet/homes` into `fleet/shared`, which stays
    // inside the tree and is nobody's business. A link out of the tree is the one a person must be told
    // about before they authorize anything.
    const root = await createTemporaryRoot();
    const { home } = await installation(root);
    const outside = join(root, 'somebody-elses-data');
    await mkdir(outside, { recursive: true });
    await mkdir(join(home, 'fleet', 'shared'), { recursive: true });
    await symlink(join(home, 'fleet', 'shared'), join(home, 'fleet', 'homes'));
    await symlink(outside, join(home, 'escape'));

    // Act
    const measured = await new FileResetTrees().measure(home);

    // Assert
    should(measured).have.property('kind', 'measured');
    should(measured).have.property('escapingLinks', [`escape -> ${outside}`]);
  });

  it('should treat a relative link as escaping only when it actually leaves the tree', async () => {
    // Arrange — the classification is resolved against the link's own directory, not the tree root, so
    // a `../` inside a nested directory is still inside.
    const root = await createTemporaryRoot();
    const { home } = await installation(root);
    await symlink(join('..', 'config'), join(home, 'fleet', 'inside'));
    await symlink(join('..', '..', '..', 'somewhere'), join(home, 'fleet', 'outside'));

    // Act
    const measured = await new FileResetTrees().measure(home);

    // Assert
    should(measured).have.property('kind', 'measured');
    should(measured).have.property('escapingLinks').which.has.length(1);
    should(measured)
      .have.property('escapingLinks')
      .which.matchAny(/fleet\/outside/u);
  });
});

describe('removing the trees a reset destroys', () => {
  it('should remove a state home whole, and report what actually went', async () => {
    // Arrange
    const root = await createTemporaryRoot();
    const { home } = await installation(root);

    // Act
    const removed = await new FileResetTrees().remove(home);

    // Assert
    should(removed).have.property('kind', 'measured');
    should(removed).have.property('files', 4);
    should(await exists(home)).be.false();
  });

  it('should remove a sealed snapshot store an ordinary recursive remove cannot', async () => {
    // Arrange — this is what an upgraded host carries, and it is where roughly 100MB of copies of an
    // already-installed executable lives. A reset that could not open it would leave that behind
    // forever while telling the owner it had cleared everything.
    const root = await createTemporaryRoot();
    const { artifacts } = await installation(root);
    const store = join(artifacts, 'daemon-snapshots', 'fyd', 'snapshots', `sha256-${'a'.repeat(64)}`);

    // Act + Assert — the fixture really is unremovable by ordinary means, asserted on its own copy so a
    // partly-completed remove does not change what the subject then measures.
    const decoy = await createTemporaryRoot();
    const decoyStore = (await installation(decoy)).artifacts;
    await should(rm(decoyStore, { recursive: true })).be.rejectedWith(/EACCES|EPERM/u);

    const removed = await new FileResetTrees().remove(artifacts);
    should(removed).have.property('kind', 'measured');
    should(removed).have.property('bytes', 1_000);
    should(await exists(store)).be.false();
    should(await exists(artifacts)).be.false();
  });

  it('should unlink a link out of the tree and never touch what it points at', async () => {
    // Arrange — the requirement stated as a fact rather than a promise: a garbage-collection root is a
    // link into the Nix store, and FY_HOME may hold one of its own. Following either would delete
    // somebody's real data, and no amount of care in the caller would undo it.
    const root = await createTemporaryRoot();
    const { home, artifacts } = await installation(root);
    const precious = join(root, 'precious');
    await mkdir(join(precious, 'bin'), { recursive: true });
    await writeFile(join(precious, 'bin', 'fyd'), 'the real executable');
    await mkdir(join(artifacts, 'nix'), { recursive: true });
    await symlink(precious, join(artifacts, 'nix', 'fyd'));
    await symlink(precious, join(home, 'escape'));

    // Act
    await new FileResetTrees().remove(artifacts);
    await new FileResetTrees().remove(home);

    // Assert — both trees are gone, and every byte on the other side of both links survives.
    should(await exists(artifacts)).be.false();
    should(await exists(home)).be.false();
    should(await readFile(join(precious, 'bin', 'fyd'), 'utf8')).equal('the real executable');
  });

  it('should answer absent rather than fail when there is nothing there', async () => {
    // Arrange — a second reset, which has to be safe and quiet.
    const root = await createTemporaryRoot();

    // Act + Assert
    should(await new FileResetTrees().remove(join(root, 'state', 'ferretry'))).deepEqual({ kind: 'absent' });
  });

  it('should refuse a root that is itself a symbolic link rather than report a clean slate', async () => {
    // Arrange — removing the link would unlink one entry and leave every byte behind while this said it
    // had removed the installation. A lie with no error in it is worse than a refusal.
    const root = await createTemporaryRoot();
    const real = join(root, 'real-home');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'api-token'), 'fy_token');
    const link = join(root, 'linked-home');
    await symlink(real, link);

    // Act + Assert
    await should(new FileResetTrees().remove(link)).be.rejectedWith(/is a symbolic link/u);
    await should(new FileResetTrees().measure(link)).be.rejectedWith(/is a symbolic link/u);
    should(await exists(join(real, 'api-token'))).be.true();
  });

  it('should refuse a root that is a regular file', async () => {
    // Arrange — an FY_HOME pointing at a file. Neither root is ever a file, so this is a mistake rather
    // than a shape to accommodate.
    const root = await createTemporaryRoot();
    const file = join(root, 'not-a-home');
    await writeFile(file, 'x');

    // Act + Assert
    await should(new FileResetTrees().remove(file)).be.rejectedWith(/is not a directory/u);
  });

  it('should surface a removal it cannot complete, rather than swallowing it as a value', async () => {
    // Arrange — the tree is unsealable but its PARENT is not writable, so the final unlink is refused.
    // This is the opposite contract from the retired-artifact port next door: tidying may fail silently,
    // a reset may not, because somebody has already been told their data is gone.
    const root = await createTemporaryRoot();
    const home = join(root, 'sealed', '.ferretry');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'api-token'), 'x');
    await chmod(join(root, 'sealed'), 0o500);

    // Act + Assert
    await should(new FileResetTrees().remove(home)).be.rejectedWith(/EACCES|EPERM/u);
    should(await exists(home)).be.true();

    // Cleanup — hand the fixture back so the afterEach removal is not the thing under test.
    await chmod(join(root, 'sealed'), 0o700);
  });

  it('should surface a path it cannot even inspect', async () => {
    // Arrange — an ancestor that is a regular file, which is ENOTDIR rather than ENOENT.
    const root = await createTemporaryRoot();
    await writeFile(join(root, 'not-a-directory'), 'x');

    // Act + Assert — an absent tree is absent; anything else is an error, never a silent success.
    await should(new FileResetTrees().measure(join(root, 'not-a-directory', '.ferretry'))).be.rejectedWith(/ENOTDIR/u);
  });
});
