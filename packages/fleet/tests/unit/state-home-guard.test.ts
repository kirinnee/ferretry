import { describe, it } from 'bun:test';
import should from 'should';
import {
  copyTreeOutsideStateHomes,
  createOutsideStateHomes,
  type FileIdentity,
  openOutsideStateHomes,
  resolveStateHomes,
  type StateHomes,
  StateHomeUnresolvedError,
  stateHomeByName,
  stateHomeOf,
} from '../../src/lib/state-home-guard.ts';
import { FakeGuardDisk } from './fake-guard-disk.ts';

/**
 * A disk with the state home at `/fy` (its API token and state), a session folder `/work` beside it, a
 * symlinked name `/link-fy` for the home, and an opening `/fy/fleet/assets` inside it.
 */
const world = async (throughDescriptors = true) => {
  const disk = new FakeGuardDisk(throughDescriptors);
  disk.dir('/fy');
  disk.file('/fy/api-token', 64, 'fy_admin');
  disk.dir('/fy/state');
  disk.file('/fy/state/secrets.key', 32);
  disk.dir('/fy/fleet');
  disk.dir('/fy/fleet/assets');
  disk.file('/fy/fleet/assets/CLAUDE.md', 5, 'hello');
  disk.link('/link-fy', '/fy');
  disk.dir('/work');
  disk.file('/work/a.txt', 3, 'abc');
  const homes = await resolveStateHomes({ homes: ['/link-fy'], openings: ['/fy/fleet/assets'] }, disk);
  return { disk, homes };
};

const rule = (result: { readonly ok: boolean; readonly rule?: string }): string | undefined =>
  result.ok ? 'ok' : result.rule;

describe('resolveStateHomes', () => {
  it('should know each home by its configured name, its real path and its device and inode', async () => {
    // Arrange
    const { disk, homes } = await world();
    const real = (await disk.identity('/fy')) as FileIdentity;

    // Assert
    should(homes.homes).match([{ named: '/link-fy', real: '/fy', device: real.device, inode: real.inode }]);
    should(homes.openings).match([{ named: '/fy/fleet/assets', real: '/fy/fleet/assets' }]);
  });

  it('should fail closed for a home that is missing or not a folder, and refuse a relative one', async () => {
    const { disk } = await world();

    const missing = await resolveStateHomes({ homes: ['/nope'] }, disk).catch((error: unknown) => error);
    const file = await resolveStateHomes({ homes: ['/work/a.txt'] }, disk).catch((error: unknown) => error);
    const relative = await resolveStateHomes({ homes: ['fy'] }, disk).catch((error: unknown) => error);

    should(missing).be.instanceOf(StateHomeUnresolvedError);
    should((missing as Error).message).equal('the daemon’s state home cannot be resolved');
    should(file).be.instanceOf(StateHomeUnresolvedError);
    should(relative).be.instanceOf(TypeError);
  });
});

describe('stateHomeByName', () => {
  it('should name the home holding a path by either of its names, the home itself included', async () => {
    const { homes } = await world();

    should(stateHomeByName(homes, '/fy')).deepEqual({ inside: true, home: '/link-fy' });
    should(stateHomeByName(homes, '/link-fy/api-token')).deepEqual({ inside: true, home: '/link-fy' });
    should(stateHomeByName(homes, '/fy/state/secrets.key')).deepEqual({ inside: true, home: '/link-fy' });
  });

  it('should count a child named "..cache" as inside, and the opening and anything beside as outside', async () => {
    const { homes } = await world();

    should(stateHomeByName(homes, '/fy/..cache/api-token').inside).be.true();
    should(stateHomeByName(homes, '/fy/fleet/assets/CLAUDE.md')).deepEqual({ inside: false });
    should(stateHomeByName(homes, '/fy-other/x')).deepEqual({ inside: false });
    should(stateHomeByName(homes, '/')).deepEqual({ inside: false });
    should(() => stateHomeByName(homes, 'fy/api-token')).throw(TypeError);
  });
});

describe('stateHomeOf — by identity', () => {
  it('should find the home through a second name for it, as a bind mount gives', async () => {
    // Arrange: `/work/mnt` IS the home's folder under another path.
    const { disk, homes } = await world();
    disk.bind('/work/mnt', '/fy');

    // Act
    const verdict = await stateHomeOf(homes, '/work/mnt/api-token', disk);

    // Assert
    should(verdict).deepEqual({ inside: true, home: '/link-fy' });
  });

  it('should let the nearest opening win, and fail closed on a folder that is not there', async () => {
    const { disk, homes } = await world();
    disk.bind('/work/assets', '/fy/fleet/assets');

    should(await stateHomeOf(homes, '/work/assets/CLAUDE.md', disk)).deepEqual({ inside: false });
    should(await stateHomeOf(homes, '/work/a.txt', disk)).deepEqual({ inside: false });
    should((await stateHomeOf(homes, '/work/gone/x', disk)).inside).be.true();
  });
});

describe('openOutsideStateHomes', () => {
  it('should open a file outside every home and read it through the descriptor', async () => {
    // Arrange
    const { disk, homes } = await world();

    // Act
    const opened = await openOutsideStateHomes('/work/a.txt', homes, disk, { inside: '/work' });
    if (!opened.ok) throw new Error(opened.rule);
    const text = await opened.value.readText(10);
    const copied = await opened.value.copyTo('/work/copy.txt', 10);
    const kept = await opened.value.copyTo('/work/mode.txt', 10, 0o640);
    await opened.value.close();

    // Assert
    should(opened.value).match({ path: '/work/a.txt', identity: { kind: 'file', links: 1 } });
    should(text).equal('abc');
    should([copied, kept]).deepEqual([3, 3]);
    should(disk.entries.get('/work/copy.txt')).match({ mode: 0o600 });
    should(disk.entries.get('/work/mode.txt')).match({ mode: 0o640 });
  });

  it('should refuse the home by name, through a symlink, and by identity behind a second name', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.link('/work/token', '/fy/api-token');
    disk.bind('/work/mnt', '/fy');

    // Act
    const refused = await Promise.all(
      ['/link-fy/api-token', '/work/token', '/work/mnt/api-token'].map(
        async path => await openOutsideStateHomes(path, homes, disk),
      ),
    );

    // Assert
    should(refused.map(rule)).deepEqual(['state-home', 'state-home', 'state-home']);
    should(refused[0]).match({ home: '/link-fy' });
  });

  it('should refuse what is missing, outside the folder, not a file, or failed to open', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.dir('/work/sub');
    disk.pipe('/work/fifo');
    disk.dir('/elsewhere');
    disk.file('/elsewhere/b.txt', 1);
    disk.file('/work/locked.txt', 1);
    disk.beforeOpen = path => {
      if (path === '/work/locked.txt') throw new Error('EACCES');
    };

    // Act
    const results = await Promise.all(
      ['/work/nope', '/elsewhere/b.txt', '/work/sub', '/work/fifo', '/work/locked.txt'].map(
        async path => await openOutsideStateHomes(path, homes, disk, { inside: '/work' }),
      ),
    );

    // Assert
    should(results.map(rule)).deepEqual(['not-found', 'outside', 'not-a-file', 'not-a-file', 'changed']);
  });

  it('should refuse a file swapped, turned into a folder, or removed between the check and the open', async () => {
    // Arrange
    const { disk, homes } = await world();
    for (const name of ['swapped', 'folder', 'gone']) disk.file(`/work/${name}.txt`, 1);
    disk.beforeOpen = path => {
      if (path === '/work/folder.txt') disk.dir('/work/folder.txt');
    };
    disk.afterOpen = path => {
      if (path === '/work/swapped.txt') disk.file('/work/swapped.txt', 1);
      if (path === '/work/gone.txt') disk.entries.delete('/work/gone.txt');
    };

    // Act
    const results = await Promise.all(
      ['swapped', 'folder', 'gone'].map(async name => await openOutsideStateHomes(`/work/${name}.txt`, homes, disk)),
    );

    // Assert
    should(results.map(rule)).deepEqual(['changed', 'not-a-file', 'changed']);
  });

  it('should refuse a hard link unless its real path is under an allowed root', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.dir('/nix');
    disk.file('/nix/store-file', 2);
    disk.hardLink('/nix/second-name', '/nix/store-file');
    disk.hardLink('/work/token-too', '/fy/api-token');

    // Act
    const refused = await openOutsideStateHomes('/work/token-too', homes, disk);
    const nix = await openOutsideStateHomes('/nix/store-file', homes, disk, { hardLinks: { allowUnder: ['/nix'] } });
    const notCovered = await openOutsideStateHomes('/work/token-too', homes, disk, {
      hardLinks: { allowUnder: ['/nix'] },
    });
    const plain = await openOutsideStateHomes('/nix/store-file', homes, disk, { hardLinks: 'refuse' });

    // Assert
    should([refused, nix, notCovered, plain].map(rule)).deepEqual(['hard-link', 'ok', 'hard-link', 'hard-link']);
  });

  it('should refuse, hop by hop, a link that lives inside a home even when it lands outside', async () => {
    // Arrange: a credential home in the state home links OUT to the host login.
    const { disk, homes } = await world();
    disk.dir('/host');
    disk.file('/host/auth.json', 9);
    disk.link('/fy/state/auth.json', '/host/auth.json');
    disk.link('/work/auth', '../fy/state/auth.json');

    // Act
    const landing = await openOutsideStateHomes('/work/auth', homes, disk);
    const every = await openOutsideStateHomes('/work/auth', homes, disk, { hops: 'every' });
    const plain = await openOutsideStateHomes('/host/auth.json', homes, disk, { hops: 'every' });

    // Assert
    should([landing, every, plain].map(rule)).deepEqual(['ok', 'state-home', 'ok']);
  });

  it('should not count the home’s own configured name as a hop, and leave a broken or looping path to resolve', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.link('/work/assets', '/link-fy/fleet/assets/CLAUDE.md');
    disk.link('/work/loop', '/work/loop');
    disk.link('/work/dangling', '/nowhere/x');
    disk.dir('/work/deep');
    disk.link('/work/deep/up', '../a.txt');

    // Act
    const results = await Promise.all(
      ['/work/assets', '/work/loop', '/work/dangling', '/work/deep/up'].map(
        async path => await openOutsideStateHomes(path, homes, disk, { hops: 'every' }),
      ),
    );

    // Assert
    should(results.map(rule)).deepEqual(['ok', 'not-found', 'not-found', 'ok']);
  });

  it('should refuse a relative path outright', async () => {
    const { disk, homes } = await world();

    await openOutsideStateHomes('work/a.txt', homes, disk).then(
      () => should.fail(undefined, undefined, 'a relative path should throw'),
      (error: unknown) => should(error).be.instanceOf(TypeError),
    );
  });

  it('should refuse when the real path vanishes before its kind is read', async () => {
    const { disk, homes } = await world();
    const racing = Object.create(disk) as FakeGuardDisk;
    racing.identity = async () => undefined;

    should(rule(await openOutsideStateHomes('/work/a.txt', homes, racing))).equal('not-found');
  });
});

describe('createOutsideStateHomes', () => {
  const write = async (
    homes: StateHomes,
    disk: FakeGuardDisk,
    path: string,
    options: { readonly overwrite?: boolean; readonly inside?: string } = {},
  ) =>
    await createOutsideStateHomes(path, homes, disk, {
      overwrite: options.overwrite === true,
      mode: 0o644,
      ...(options.inside === undefined ? {} : { inside: options.inside }),
    });

  it('should create a new file through the checked folder, and write into an existing one only when asked', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.file('/stage', 11);

    // Act
    const created = await write(homes, disk, '/work/new.txt', { inside: '/work' });
    if (!created.ok) throw new Error(created.rule);
    const size = await created.value.copyFrom('/stage', 100);
    await created.value.close();
    const taken = await write(homes, disk, '/work/a.txt');
    const replaced = await write(homes, disk, '/work/a.txt', { overwrite: true });
    if (!replaced.ok) throw new Error(replaced.rule);
    await replaced.value.copyFrom('/stage', 100);
    await replaced.value.close();
    const absent = await write(homes, disk, '/work/fresh.txt', { overwrite: true });

    // Assert
    should(created.value).match({ path: '/work/new.txt', created: true });
    should(size).equal(11);
    should(disk.entries.get('/work/new.txt')).match({ size: 11, mode: 0o644 });
    should(rule(taken)).equal('taken');
    should(replaced.value.created).be.false();
    should(disk.entries.get('/work/a.txt')).match({ size: 11 });
    should(absent).match({ ok: true, value: { created: true } });
  });

  it('should refuse the home by name, a folder in it by identity, outside the folder, and a missing folder', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.bind('/work/mnt', '/fy');
    disk.link('/work/conf', '/fy/state');

    // Act
    const results = [
      await write(homes, disk, '/link-fy/state/passkeys.json'),
      await write(homes, disk, '/work/conf/passkeys.json'),
      await write(homes, disk, '/work/mnt/state/passkeys.json'),
      await write(homes, disk, '/elsewhere/x', { inside: '/work' }),
      await write(homes, disk, '/work/nope/x'),
    ];

    // Assert
    should(results.map(rule)).deepEqual(['state-home', 'state-home', 'state-home', 'not-found', 'not-found']);
    should(disk.entries.has('/fy/state/passkeys.json')).be.false();
  });

  it('should refuse outside the folder it was confined to', async () => {
    const { disk, homes } = await world();
    disk.dir('/elsewhere');

    should(rule(await write(homes, disk, '/elsewhere/x', { inside: '/work' }))).equal('outside');
  });

  it('should refuse a folder that fails to open or is swapped for a link into the home after the check', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.dir('/work/locked');
    disk.dir('/work/downloads');
    disk.beforeOpen = path => {
      if (path === '/work/locked') throw new Error('EACCES');
    };
    disk.afterOpen = path => {
      if (path !== '/work/downloads') return;
      disk.move('/work/downloads', '/work/downloads-was');
      disk.link('/work/downloads', '/fy/state');
    };

    // Act
    const locked = await write(homes, disk, '/work/locked/x');
    const swapped = await write(homes, disk, '/work/downloads/secrets.key', { overwrite: true });

    // Assert
    should([locked, swapped].map(rule)).deepEqual(['changed', 'changed']);
    should(disk.entries.get('/fy/state/secrets.key')).match({ size: 32 });
  });

  it('should write THROUGH the checked folder when its path is swapped after the check, then refuse and remove its own file', async () => {
    // Arrange: the folder is checked, then renamed away and a link into the home put in its place.
    const { disk, homes } = await world();
    disk.dir('/work/downloads');
    disk.afterOpen = path => {
      if (!path.startsWith('/@fd/')) return;
      disk.move('/work/downloads', '/work/downloads-was');
      disk.link('/work/downloads', '/fy/state');
    };

    // Act
    const result = await write(homes, disk, '/work/downloads/secrets.key', { overwrite: true });

    // Assert
    should(rule(result)).equal('changed');
    should(disk.entries.get('/fy/state/secrets.key')).match({ size: 32 });
    should(disk.unlinked).deepEqual(['/work/downloads-was/secrets.key']);
  });

  it('should empty, not remove, a file it made when the platform has no descriptor paths', async () => {
    // Arrange
    const { disk, homes } = await world(false);
    disk.dir('/work/downloads');
    disk.afterOpen = path => {
      if (path === '/work/downloads/new.txt') disk.file('/work/downloads/new.txt', 0);
    };

    // Act
    const result = await write(homes, disk, '/work/downloads/new.txt');

    // Assert
    should(rule(result)).equal('changed');
    should(disk.unlinked).deepEqual([]);
  });

  it('should refuse to write into a hard link, or into something that will not open as a file', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.hardLink('/work/token-too', '/fy/api-token');
    disk.dir('/work/folder');
    disk.pipe('/work/fifo');

    // Act
    const linked = await write(homes, disk, '/work/token-too', { overwrite: true });
    const folder = await write(homes, disk, '/work/folder', { overwrite: true });
    const fifo = await write(homes, disk, '/work/fifo', { overwrite: true });

    // Assert
    should([linked, folder, fifo].map(rule)).deepEqual(['hard-link', 'changed', 'not-a-file']);
    should(disk.entries.get('/fy/api-token')).match({ size: 64 });
  });

  it('should discard a file it made after a failed write, and empty one that was already there', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.file('/stage', 500);
    const made = await write(homes, disk, '/work/new.txt');
    const kept = await write(homes, disk, '/work/a.txt', { overwrite: true });
    if (!made.ok || !kept.ok) throw new Error('both should open');

    // Act
    const failure = await made.value.copyFrom('/stage', 100).catch((error: unknown) => error);
    await made.value.discard();
    await kept.value.discard();

    // Assert
    should(failure).be.instanceOf(Error);
    should(disk.entries.has('/work/new.txt')).be.false();
    should(disk.entries.get('/work/a.txt')).match({ size: 0 });
  });

  it('should refuse a path that names no file, and a relative one', async () => {
    const { disk, homes } = await world();

    for (const path of ['/', '/work/..', 'work/x'])
      await write(homes, disk, path).then(
        () => should.fail(undefined, undefined, `${path} should throw`),
        (error: unknown) => should(error).be.instanceOf(TypeError),
      );
  });
});

describe('copyTreeOutsideStateHomes', () => {
  const tree = async (source: string, options: Partial<Parameters<typeof copyTreeOutsideStateHomes>[4]> = {}) => {
    const { disk, homes } = await world();
    disk.dir('/src', 0o750);
    disk.file('/src/a.md', 4, 'aaaa', 0o640);
    disk.dir('/src/sub');
    disk.file('/src/sub/b.md', 2);
    disk.dir('/out');
    return {
      disk,
      run: async (extra: (d: FakeGuardDisk) => void = () => undefined) => {
        extra(disk);
        return await copyTreeOutsideStateHomes(source, '/out/copy', homes, disk, {
          maxFileBytes: 100,
          maxFiles: 10,
          ...options,
        });
      },
    };
  };

  it('should copy a folder, following links and keeping modes, and a single file', async () => {
    // Arrange
    const folder = await tree('/src');
    const single = await tree('/src/a.md');

    // Act
    const copied = await folder.run(disk => disk.link('/src/linked.md', '/work/a.txt'));
    const one = await single.run();

    // Assert
    should(copied).deepEqual({ ok: true, value: { files: 3, bytes: 9 } });
    should(folder.disk.entries.get('/out/copy')).match({ kind: 'directory', mode: 0o750 });
    should(folder.disk.entries.get('/out/copy/a.md')).match({ mode: 0o640, text: 'aaaa' });
    should(folder.disk.entries.get('/out/copy/linked.md')).match({ size: 3 });
    should(one).deepEqual({ ok: true, value: { files: 1, bytes: 4 } });
  });

  it('should stop at a file or folder in the home, however it is reached', async () => {
    const byLink = await (await tree('/src')).run(disk => disk.link('/src/token', '/fy/api-token'));
    const byFolder = await (await tree('/src')).run(disk => disk.link('/src/state', '/fy/state'));
    const byName = await (await tree('/link-fy/state')).run();
    const byHop = await (
      await tree('/src', { hops: 'every' })
    ).run(disk => {
      disk.dir('/elsewhere');
      disk.link('/fy/out', '/elsewhere');
      disk.link('/src/through', '/fy/out');
    });

    should([byLink, byFolder, byName, byHop].map(rule)).deepEqual([
      'state-home',
      'state-home',
      'state-home',
      'state-home',
    ]);
  });

  it('should refuse a loop, too many files, a dangling link and a hard link where not allowed', async () => {
    const loop = await (await tree('/src')).run(disk => disk.link('/src/sub/again', '/src'));
    const many = await (await tree('/src', { maxFiles: 1 })).run();
    const dangling = await (await tree('/src')).run(disk => disk.link('/src/broken', '/nowhere'));
    const linked = await (
      await tree('/src', { hardLinks: 'refuse' })
    ).run(disk => disk.hardLink('/src/again.md', '/src/a.md'));

    should([loop, many, dangling, linked].map(rule)).deepEqual(['loop', 'too-many', 'not-found', 'hard-link']);
  });
});
