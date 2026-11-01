import { describe, it } from 'bun:test';
import should from 'should';
import {
  copyTreeOutsideStateHomes,
  createOutsideStateHomes,
  type FileIdentity,
  judgeOutsideStateHomes,
  MutableRootError,
  openOutsideStateHomes,
  resolveImmutableRoots,
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

  it('should refuse a hard link unless its real path is under a root proven immutable', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.own('/', 0, 0o755);
    disk.dir('/nix');
    disk.own('/nix', 0, 0o755);
    disk.file('/nix/store-file', 2);
    disk.hardLink('/nix/second-name', '/nix/store-file');
    disk.hardLink('/work/token-too', '/fy/api-token');
    const nixRoot = await resolveImmutableRoots(['/nix'], disk, [1000]);

    // Act
    const refused = await openOutsideStateHomes('/work/token-too', homes, disk);
    const nix = await openOutsideStateHomes('/nix/store-file', homes, disk, { hardLinks: { allowUnder: nixRoot } });
    const notCovered = await openOutsideStateHomes('/work/token-too', homes, disk, {
      hardLinks: { allowUnder: nixRoot },
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

  it('should fail closed when the real path vanishes while it is judged', async () => {
    const { disk, homes } = await world();
    const racing = Object.create(disk) as FakeGuardDisk;
    racing.identity = async () => undefined;

    should(rule(await openOutsideStateHomes('/work/a.txt', homes, racing))).equal('state-home');
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

  it('should discard a file it made after a failed write, and leave one that was already there alone', async () => {
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
    should(disk.entries.get('/work/a.txt')).match({ size: 3 });
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

  it('should make a read-only folder writable while it is filled, then give it its own mode', async () => {
    const folder = await tree('/src');

    const copied = await folder.run(disk => {
      disk.dir('/src/sealed', 0o555);
      disk.file('/src/sealed/c.md', 1);
    });

    should(copied.ok).be.true();
    should(folder.disk.modes).containDeep([['/out/copy/sealed', 0o755]]);
    should(folder.disk.entries.get('/out/copy/sealed')).match({ mode: 0o555 });
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

describe('judgeOutsideStateHomes — a path judged without opening it', () => {
  it('should answer where a file or a folder really is, and what is there', async () => {
    const { disk, homes } = await world();
    disk.link('/work/to-assets', '/fy/fleet/assets');

    const folder = await judgeOutsideStateHomes('/work/to-assets', homes, disk, { hops: 'every' });
    const file = await judgeOutsideStateHomes('/work/a.txt', homes, disk);

    should(folder).match({ ok: true, value: { real: '/fy/fleet/assets', identity: { kind: 'directory' } } });
    should(file).match({ ok: true, value: { real: '/work/a.txt', identity: { kind: 'file' } } });
  });

  it('should refuse by name, by hop, by real path, by identity, and what is not there', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.link('/fy/state/out', '/work');
    disk.link('/work/through', '/fy/state/out/a.txt');
    disk.link('/work/state', '/fy/state');
    disk.bind('/work/mnt', '/fy');

    // Act
    const results = await Promise.all(
      [
        ['/fy/api-token', {}],
        ['/work/through', { hops: 'every' }],
        ['/work/state', {}],
        ['/work/mnt/state', {}],
        ['/work/nope', {}],
      ].map(async ([path, options]) => await judgeOutsideStateHomes(path as string, homes, disk, options as object)),
    );
    const racing = Object.create(disk) as FakeGuardDisk;
    racing.identity = async (path: string) => (path === '/work/a.txt' ? undefined : await disk.identity(path));
    const vanished = await judgeOutsideStateHomes('/work/a.txt', homes, racing);

    // Assert
    should(results.map(rule)).deepEqual(['state-home', 'state-home', 'state-home', 'state-home', 'not-found']);
    should(rule(vanished)).equal('state-home');
  });
});

describe('resolveImmutableRoots — what may hold a tolerated hard link', () => {
  const chain = () => {
    const disk = new FakeGuardDisk();
    disk.own('/', 0, 0o755);
    disk.dir('/nix');
    disk.own('/nix', 0, 0o755);
    disk.dir('/nix/store');
    // A multi-user store: root:nixbld 1775, written by build users only.
    disk.own('/nix/store', 0, 0o1775, 30_000);
    return disk;
  };
  const refusal = async (work: Promise<unknown>) => await work.catch((error: unknown) => error);

  it('should accept a root-owned store whose group writes are not this process’s', async () => {
    const roots = await resolveImmutableRoots(['/nix/store'], chain(), [1000, 100]);

    should(roots.roots).deepEqual(['/nix/store']);
  });

  it('should refuse a user-owned store, one anyone can write, one this process’s group can write, and a missing one', async () => {
    // Arrange
    const single = chain();
    single.own('/nix/store', 1000, 0o755, 100);
    const open = chain();
    open.own('/nix', 0, 0o1777);
    const grouped = chain();

    // Act
    const errors = [
      await refusal(resolveImmutableRoots(['/nix/store'], single, [1000])),
      await refusal(resolveImmutableRoots(['/nix/store'], open, [1000])),
      await refusal(resolveImmutableRoots(['/nix/store'], grouped, [1000, 30_000])),
      await refusal(resolveImmutableRoots(['/nix/missing'], chain(), [1000])),
      await refusal(resolveImmutableRoots(['nix/store'], chain(), [1000])),
    ];

    // Assert
    should(errors.slice(0, 4).every(error => error instanceof MutableRootError)).be.true();
    should((errors[0] as MutableRootError).root).equal('/nix/store');
    should((errors[0] as Error).message).containEql('not root-owned');
    should(errors[4]).be.instanceOf(TypeError);
  });
});

describe('pinned key files — a bind mount of one file alone', () => {
  it('should refuse a key file bound somewhere else, skip one not there yet, and fail closed when one cannot be read', async () => {
    // Arrange
    const { disk } = await world();
    const homes = await resolveStateHomes({ homes: ['/fy'], pinned: ['/fy/api-token', '/fy/not-yet'] }, disk);
    disk.bind('/work/x', '/fy/api-token');
    const broken = Object.create(disk) as FakeGuardDisk;
    broken.identity = async (path: string) => {
      if (path === '/fy/api-token') throw new Error('EIO');
      return await disk.identity(path);
    };

    // Act
    const bound = await openOutsideStateHomes('/work/x', homes, disk);
    const unread = await resolveStateHomes({ homes: ['/fy'], pinned: ['/fy/api-token'] }, broken).catch(
      (error: unknown) => error,
    );

    // Assert
    should(homes.pinned).have.length(1);
    should(rule(bound)).equal('state-home');
    should(unread).be.instanceOf(StateHomeUnresolvedError);
  });
});

describe('the pre-open check — a non-file is never opened', () => {
  it('should refuse a folder and a pipe without opening either', async () => {
    const { disk, homes } = await world();
    disk.dir('/work/sub');
    disk.pipe('/work/fifo');

    const results = [
      await openOutsideStateHomes('/work/sub', homes, disk),
      await openOutsideStateHomes('/work/fifo', homes, disk),
    ];

    should(results.map(rule)).deepEqual(['not-a-file', 'not-a-file']);
    should(disk.reads).deepEqual([]);
  });
});

describe('createOutsideStateHomes — making missing folders', () => {
  it('should make each missing folder THROUGH the checked one, and refuse a missing one when not asked', async () => {
    // Arrange
    const { disk, homes } = await world();

    // Act
    const made = await createOutsideStateHomes('/work/a/b/c.txt', homes, disk, {
      inside: '/work',
      overwrite: false,
      mode: 0o644,
      makeFolders: 0o750,
    });
    if (!made.ok) throw new Error(made.rule);
    await made.value.close();
    const plain = await createOutsideStateHomes('/work/x/y.txt', homes, disk, { overwrite: false, mode: 0o644 });

    // Assert
    should(made.value.path).equal('/work/a/b/c.txt');
    should(disk.entries.get('/work/a/b')).match({ kind: 'directory', mode: 0o750 });
    should(disk.modes.map(([at]) => at)).deepEqual(['/work/a', '/work/a/b']);
    should(rule(plain)).equal('not-found');
  });

  it('should make no folder in the home when the checked folder is swapped for a link into it', async () => {
    // Arrange: `/work/dl` is checked; just before the folder below it is made, it is renamed away and a link
    // to the home's state put in its place.
    const { disk, homes } = await world();
    disk.dir('/work/dl');
    const racing = Object.create(disk) as FakeGuardDisk;
    racing.mkdir = async (at: string, mode: number) => {
      disk.move('/work/dl', '/work/dl-was');
      disk.link('/work/dl', '/fy/state');
      await disk.mkdir(at, mode);
    };

    // Act
    const result = await createOutsideStateHomes('/work/dl/new/passkeys.json', homes, racing, {
      overwrite: false,
      mode: 0o644,
      makeFolders: 0o755,
    });

    // Assert
    should(rule(result)).equal('changed');
    should(disk.entries.has('/fy/state/new')).be.false();
    should(disk.entries.get('/work/dl-was/new')).match({ kind: 'directory' });
  });

  it('should refuse when a folder cannot be made, or the one made is swapped for a link', async () => {
    // Arrange
    const { disk, homes } = await world();
    const failing = Object.create(disk) as FakeGuardDisk;
    failing.mkdir = async () => {
      throw new Error('EACCES');
    };
    const swapped = (await world()).disk;
    swapped.afterMkdirp = path => {
      swapped.entries.delete(path);
      swapped.link(path, '/fy/state');
    };
    const options = { overwrite: false, mode: 0o644, makeFolders: 0o755 };

    // Act
    const results = [
      await createOutsideStateHomes('/work/new/x', homes, failing, options),
      await createOutsideStateHomes(
        '/work/new/x',
        await resolveStateHomes({ homes: ['/fy'] }, swapped),
        swapped,
        options,
      ),
      await createOutsideStateHomes('/elsewhere/new/x', homes, disk, { ...options, inside: '/work' }),
    ];

    // Assert
    should(results.map(rule)).deepEqual(['changed', 'changed', 'outside']);
  });
});
