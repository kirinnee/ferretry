import { afterEach, describe, it } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { NixStoreGcRoot } from '../../../src/adapters/daemon/nix-gc-root.ts';
import { FileResetTrees } from '../../../src/adapters/daemon/reset-trees.ts';
import { FileServiceStore } from '../../../src/adapters/daemon/service-files.ts';

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fy-files-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

describe('the Nix garbage-collection root', () => {
  const runner = (code: number, stderr = '') => {
    const asked: (readonly string[])[] = [];
    return {
      asked,
      processes: {
        run: async (argv: readonly string[]) => {
          asked.push(argv);
          return { code, stdout: '', stderr };
        },
      } as never,
    };
  };

  it('should pin a store path through nix-store, replacing a stale root, and release it by removing the link', async () => {
    const dir = await temp();
    const root = join(dir, 'gc', 'fyd');
    await mkdir(join(dir, 'gc'));
    await writeFile(root, 'stale');
    const { asked, processes } = runner(0);
    const gc = new NixStoreGcRoot(processes);

    const result = await gc.pin('/nix/store/abc-fyd', root);
    await gc.release(root);

    should(result).be.undefined();
    should(asked).eql([['nix-store', '--add-root', root, '--indirect', '--realise', '/nix/store/abc-fyd']]);
    should(await stat(root).catch(() => undefined)).be.undefined();
  });

  it('should make the folder for the root, and say so instead of throwing when it cannot', async () => {
    const dir = await temp();
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, '');
    const gc = new NixStoreGcRoot(runner(0).processes);

    should(await gc.pin('/nix/store/x', join(dir, 'new', 'deeper', 'root'))).be.undefined();
    should((await lstat(join(dir, 'new', 'deeper'))).isDirectory()).be.true();
    should(await gc.pin('/nix/store/x', join(blocker, 'root'))).match(/^could not create .*blocker: /u);
  });

  it('should say nix-store is missing, or what it said, or how it exited', async () => {
    const root = join(await temp(), 'root');
    should(await new NixStoreGcRoot(runner(127).processes).pin('/nix/store/x', root)).equal('nix-store is not on PATH');
    should(await new NixStoreGcRoot(runner(1, ' no such path\n').processes).pin('/nix/store/x', root)).equal(
      'no such path',
    );
    should(await new NixStoreGcRoot(runner(2).processes).pin('/nix/store/x', root)).equal('nix-store exited 2');
  });

  it('should resolve a link to where it lands, and leave a path it cannot resolve as it is', async () => {
    const dir = await temp();
    const real = join(dir, 'real');
    await mkdir(real);
    await symlink(real, join(dir, 'link'));
    const gc = new NixStoreGcRoot(runner(0).processes);
    should(await gc.realPath(join(dir, 'link'))).equal(
      await Bun.file(real)
        .exists()
        .then(() => real),
    );
    should(await gc.realPath(join(dir, 'missing'))).equal(join(dir, 'missing'));
  });

  it('should release a root that was never there without complaint', async () => {
    const gc = new NixStoreGcRoot(runner(0).processes);
    await gc.release(join(await temp(), 'nothing'));
  });
});

describe('the trees a reset destroys', () => {
  const trees = new FileResetTrees();

  async function tree(): Promise<string> {
    const root = join(await temp(), 'home');
    await mkdir(join(root, 'state', 'deep'), { recursive: true });
    await writeFile(join(root, 'a.txt'), '12345');
    await writeFile(join(root, 'state', 'deep', 'b.txt'), '123');
    await symlink('a.txt', join(root, 'inside-link'));
    await symlink('/nix/store/elsewhere', join(root, 'outside-link'));
    await symlink('../../outside', join(root, 'state', 'up-link'));
    return root;
  }

  it('should measure files, bytes and the links that leave the tree, without changing it', async () => {
    const root = await tree();
    const measured = await trees.measure(root);
    should(measured).match({ kind: 'measured', files: 5, bytes: 8 });
    should(measured.kind === 'measured' && [...measured.escapingLinks].sort()).eql([
      'outside-link -> /nix/store/elsewhere',
      'state/up-link -> ../../outside',
    ]);
    should((await readdir(root)).sort()).eql(['a.txt', 'inside-link', 'outside-link', 'state']);
  });

  it('should remove the tree it measured, never following a link out of it', async () => {
    const root = await tree();
    const kept = join(root, '..', 'kept');
    await mkdir(kept);
    await writeFile(join(kept, 'keep.txt'), 'mine');
    await symlink(kept, join(root, 'to-kept'));

    const removed = await trees.remove(root);

    should(removed).match({ kind: 'measured', files: 6 });
    should(await stat(root).catch(() => undefined)).be.undefined();
    should(await readFile(join(kept, 'keep.txt'), 'utf8')).equal('mine');
  });

  it('should open a sealed tree for removal, but not for measuring', async () => {
    const root = await tree();
    await chmod(join(root, 'state', 'deep'), 0o555);
    await chmod(join(root, 'state'), 0o555);

    const removed = await trees.remove(root);

    should(removed.kind).equal('measured');
    should(await stat(root).catch(() => undefined)).be.undefined();
  });

  it('should call a root that is not there absent, for measuring and for removing', async () => {
    const missing = join(await temp(), 'nothing');
    should(await trees.measure(missing)).eql({ kind: 'absent' });
    should(await trees.remove(missing)).eql({ kind: 'absent' });
  });

  it('should refuse a root that is a link, or not a directory, rather than report a clean slate', async () => {
    const dir = await temp();
    const real = join(dir, 'real');
    await mkdir(real);
    await symlink(real, join(dir, 'link'));
    await writeFile(join(dir, 'file'), '');
    await should(trees.measure(join(dir, 'link'))).be.rejectedWith(/is a symbolic link/u);
    await should(trees.remove(join(dir, 'link'))).be.rejectedWith(/it is a symbolic link/u);
    await should(trees.measure(join(dir, 'file'))).be.rejectedWith(/it is not a directory/u);
    should((await lstat(real)).isDirectory()).be.true();
  });

  it('should throw what the file system threw when it is not just absence', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'file'), '');
    await should(trees.measure(join(dir, 'file', 'under'))).be.rejected();
  });
});

describe('the service files on disk', () => {
  it('should publish a definition whole, owner-only, and leave no temporary beside it', async () => {
    const dir = await temp();
    const target = join(dir, 'fyd.service');
    const store = new FileServiceStore();

    await store.writePrivate(target, 'first\n');
    await store.writePrivate(target, 'second\n');

    should(await store.read(target)).equal('second\n');
    should((await stat(target)).mode & 0o777).equal(0o600);
    should(await readdir(dir)).eql(['fyd.service']);
    should(await store.exists(target)).be.true();
  });

  it('should leave the old definition and no debris when publishing fails after staging', async () => {
    const dir = await temp();
    const target = join(dir, 'fyd.service');
    await new FileServiceStore().writePrivate(target, 'old\n');
    const staged: string[] = [];
    const store = new FileServiceStore({
      afterStagedSync: async path => {
        staged.push(path);
        throw new Error('power cut');
      },
    });

    await should(store.writePrivate(target, 'new\n')).be.rejectedWith('power cut');

    should(await new FileServiceStore().read(target)).equal('old\n');
    should(staged).have.length(1);
    should(await readdir(dir)).eql(['fyd.service']);
  });

  it('should remove a definition, make a log directory, and read a missing file as nothing', async () => {
    const dir = await temp();
    const store = new FileServiceStore();
    await store.ensureDirectory(join(dir, 'logs', 'daemon'));
    await writeFile(join(dir, 'unit'), 'x');

    await store.remove(join(dir, 'unit'));
    await store.remove(join(dir, 'unit'));

    should(await store.exists(join(dir, 'unit'))).be.false();
    should((await lstat(join(dir, 'logs', 'daemon'))).isDirectory()).be.true();
    should(await store.read(join(dir, 'unit'))).be.undefined();
  });

  it('should rethrow a read that failed for a reason other than absence', async () => {
    const dir = await temp();
    await should(new FileServiceStore().read(dir)).be.rejected();
  });
});
