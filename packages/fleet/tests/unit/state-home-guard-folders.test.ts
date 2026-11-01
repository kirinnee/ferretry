import { describe, it } from 'bun:test';
import should from 'should';
import {
  copyTreeIntoFolder,
  FolderChangedError,
  type GuardedFolder,
  openFolderBelow,
  openFolderOutsideStateHomes,
  removeEntryWithin,
  resolveStateHomes,
  StateHomeUnresolvedError,
} from '../../src/lib/state-home-guard.ts';
import { FakeGuardDisk } from './fake-guard-disk.ts';

/**
 * The guard's destination side: a state home at `/fy` with its secrets and a runtime whose `skills` folder its
 * harness can swap at any moment, a host config folder `/host/.claude` outside it, and a dotfiles checkout it
 * links to.
 */
const world = async (throughDescriptors: boolean | 'calls' = true) => {
  const disk = new FakeGuardDisk(throughDescriptors);
  disk.dir('/fy');
  disk.file('/fy/api-token', 64, 'fy_admin');
  disk.dir('/fy/state');
  disk.file('/fy/state/secrets.key', 32, 'vault');
  disk.dir('/fy/config');
  disk.dir('/fy/fleet');
  disk.dir('/fy/fleet/assets');
  disk.dir('/fy/fleet/homes');
  disk.dir('/fy/fleet/homes/one');
  disk.dir('/fy/fleet/homes/one/skills');
  disk.dir('/fy/fleet/homes/one/skills/stale');
  disk.file('/fy/fleet/homes/one/skills/stale/SKILL.md', 5, 'stale');
  disk.dir('/host');
  disk.dir('/dotfiles');
  disk.dir('/dotfiles/claude');
  disk.link('/host/.claude', '/dotfiles/claude');
  const homes = await resolveStateHomes(
    { homes: ['/fy', '/fy/state', '/fy/config'], openings: ['/fy/fleet/assets'] },
    disk,
  );
  return { disk, homes };
};

const SKILLS = '/fy/fleet/homes/one/skills';

const opened = async (result: Promise<{ readonly ok: boolean }>): Promise<GuardedFolder> => {
  const settled = (await result) as { readonly ok: true; readonly value: GuardedFolder } | { readonly ok: false };
  if (!settled.ok) throw new Error(`expected the folder to open, got ${JSON.stringify(settled)}`);
  return settled.value;
};

const rule = async (result: Promise<{ readonly ok: boolean; readonly rule?: string }>): Promise<string> => {
  const settled = await result;
  return settled.ok ? 'ok' : (settled.rule as string);
};

describe('openFolderOutsideStateHomes — a folder to write below', () => {
  it('should open a runtime folder inside the home by walking down from the home without following a link', async () => {
    // Arrange
    const { disk, homes } = await world();

    // Act
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));

    // Assert
    should(folder.path).equal(SKILLS);
    should((await disk.identity(await folder.entry('stale')))?.kind).equal('directory');
  });

  it('should refuse a runtime folder the harness swapped for a link into the home', async () => {
    // Arrange — the link lands inside the roots, so a path check alone would let it through.
    const { disk, homes } = await world();
    disk.move(SKILLS, '/fy/fleet/homes/one/elsewhere');
    disk.link(SKILLS, '/fy/state');

    // Act + Assert
    should(await rule(openFolderOutsideStateHomes(SKILLS, homes, disk))).equal('link');
    should(await rule(openFolderOutsideStateHomes(`${SKILLS}/deeper`, homes, disk, { make: 0o700 }))).equal('link');
  });

  it('should refuse a folder below the home that is a home by identity (a bind mount)', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.move(SKILLS, '/fy/fleet/homes/one/elsewhere');
    disk.bind(SKILLS, '/fy/state');

    // Act + Assert
    should(await rule(openFolderOutsideStateHomes(SKILLS, homes, disk))).equal('state-home');
  });

  it('should follow links outside the homes, but refuse one that lands in a home', async () => {
    // Arrange — a host `~/.claude` that is a dotfiles link is ordinary; one whose skills lead into the home is not.
    const { disk, homes } = await world();
    disk.link('/dotfiles/claude/skills', '/fy/state');

    // Act + Assert
    should((await opened(openFolderOutsideStateHomes('/host/.claude', homes, disk))).path).equal('/dotfiles/claude');
    should(await rule(openFolderOutsideStateHomes('/host/.claude/skills', homes, disk))).equal('state-home');
  });

  it('should make missing folders through their checked parents', async () => {
    // Arrange
    const { disk, homes } = await world();

    // Act
    const folder = await opened(
      openFolderOutsideStateHomes('/fy/fleet/homes/two/skills', homes, disk, { make: 0o700 }),
    );

    // Assert
    should(folder.path).equal('/fy/fleet/homes/two/skills');
    should((await disk.identity('/fy/fleet/homes/two/skills'))?.mode).equal(0o700);
  });

  it('should refuse a file where a folder must be, and answer not-found for a missing one it may not make', async () => {
    // Arrange
    const { disk, homes } = await world();

    // Act + Assert
    should(await rule(openFolderOutsideStateHomes('/fy/api-token/below', homes, disk, { make: 0o700 }))).equal(
      'not-a-folder',
    );
    should(await rule(openFolderOutsideStateHomes('/fy/fleet/homes/nobody', homes, disk))).equal('not-found');
  });

  it('should keep reaching the folder it opened after the path is swapped for a link (through descriptors)', async () => {
    // Arrange
    const { disk, homes } = await world();
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));

    // Act — the harness moves the folder away and leaves a link into the home in its place.
    disk.move(SKILLS, '/fy/fleet/homes/one/elsewhere');
    disk.link(SKILLS, '/fy/state');

    // Assert — the entry is still the one in the folder that was checked, never the home's.
    should((await disk.identity(await folder.entry('stale')))?.kind).equal('directory');
    should(await disk.identity(await folder.entry('secrets.key'))).be.undefined();
  });

  it('should refuse every later step through a folder whose path was swapped, where there are no descriptor paths', async () => {
    // Arrange — macOS: entries are reached by path, so each one first proves the folder is still there.
    const { disk, homes } = await world(false);
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));
    disk.move(SKILLS, '/fy/fleet/homes/one/elsewhere');
    disk.link(SKILLS, '/fy/state');

    // Act + Assert
    await should(folder.entry('secrets.key')).be.rejectedWith(FolderChangedError);
    await should(folder.self()).be.rejectedWith(FolderChangedError);
  });

  it('should refuse a child folder swapped for a link between its look and its open', async () => {
    // Arrange
    const { disk, homes } = await world();
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));
    disk.beforeOpen = path => {
      if (!path.endsWith('/stale')) return;
      disk.beforeOpen = undefined;
      disk.move(`${SKILLS}/stale`, `${SKILLS}/moved`);
      disk.link(`${SKILLS}/stale`, '/fy/state');
    };

    // Act + Assert
    should(await rule(openFolderBelow(folder, 'stale', homes, disk))).equal('changed');
  });
});

describe('openFolderOutsideStateHomes — the edges of opening and making', () => {
  it('should reach a folder itself by its real path where there are no descriptor paths, once proven there', async () => {
    // Arrange
    const { disk, homes } = await world(false);
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));

    // Act + Assert
    should(await folder.self()).equal(SKILLS);
    should(await disk.list(await folder.self())).deepEqual(['stale']);
  });

  it('should refuse a child of a folder whose path was swapped, where there are no descriptor paths', async () => {
    // Arrange
    const { disk, homes } = await world(false);
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));
    disk.move(SKILLS, '/fy/fleet/homes/one/elsewhere');
    disk.link(SKILLS, '/fy/state');

    // Act + Assert
    should(await rule(openFolderBelow(folder, 'stale', homes, disk))).equal('changed');
  });

  it('should throw for a name holding a NUL, which a C call would cut short', async () => {
    // Arrange
    const { disk, homes } = await world('calls');
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));

    // Act + Assert
    await should(folder.describe('stale\0../../state')).be.rejectedWith(TypeError);
  });

  it('should throw for a child named by a path rather than one entry', async () => {
    // Arrange
    const { disk, homes } = await world();
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));

    // Act + Assert
    await should(openFolderBelow(folder, 'stale/deeper', homes, disk)).be.rejectedWith(TypeError);
  });

  it('should surface a folder it cannot make for any reason but somebody else having made it first', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.mkdir = async path => {
      throw Object.assign(new Error(`EACCES ${path}`), { code: 'EACCES' });
    };

    // Act + Assert
    await should(openFolderOutsideStateHomes('/fy/fleet/homes/two', homes, disk, { make: 0o700 })).be.rejectedWith(
      /EACCES/u,
    );
  });

  it('should open a folder somebody else made between its look and its make', async () => {
    // Arrange — the make loses the race (`EEXIST`); the folder that won is opened and checked like any other.
    const { disk, homes } = await world();
    disk.mkdir = async path => {
      disk.dir('/fy/fleet/homes/two');
      throw Object.assign(new Error(`EEXIST ${path}`), { code: 'EEXIST' });
    };

    // Act
    const folder = await opened(openFolderOutsideStateHomes('/fy/fleet/homes/two', homes, disk, { make: 0o700 }));

    // Assert
    should(folder.path).equal('/fy/fleet/homes/two');
  });

  it('should make missing folders below a folder outside the homes, through its checked parent', async () => {
    // Arrange — a host config folder, reached through its dotfiles link, that lacks two folders.
    const { disk, homes } = await world();

    // Act
    const folder = await opened(
      openFolderOutsideStateHomes('/host/.claude/commands/team', homes, disk, { make: 0o750 }),
    );

    // Assert
    should(folder.path).equal('/dotfiles/claude/commands/team');
    should((await disk.identity('/dotfiles/claude/commands'))?.mode).equal(0o750);
  });

  it('should refuse a home that is no longer the folder it was resolved as', async () => {
    // Arrange — the home is moved away after it was resolved and another folder takes its name.
    const { disk, homes } = await world();
    disk.move('/fy', '/fy-old');
    disk.dir('/fy');
    disk.dir('/fy/fleet');

    // Act + Assert
    should(await rule(openFolderOutsideStateHomes('/fy/fleet', homes, disk))).equal('changed');
  });
});

describe('secrev-1262 M1 — a folder outside the homes is walked from the root, not opened by path', () => {
  /** A host `~/.claude` that is a real folder, and another runtime's skills inside the home it could be flipped to. */
  const host = async () => {
    const { disk, homes } = await world();
    disk.dir('/host/claude');
    disk.dir('/host/claude/skills');
    disk.dir('/fy/fleet/homes/other');
    disk.dir('/fy/fleet/homes/other/skills');
    disk.file('/fy/fleet/homes/other/skills/victim', 3, 'abc');
    /** Flips `/host/claude` between the real folder and a link to the other runtime, as `RENAME_EXCHANGE` does. */
    const flip = (toLink: boolean): void => {
      const linked = disk.entries.get('/host/claude')?.kind === 'link';
      if (toLink === linked) return;
      if (toLink) {
        disk.move('/host/claude', '/host/.claude-real');
        disk.link('/host/claude', '/fy/fleet/homes/other');
      } else {
        disk.entries.delete('/host/claude');
        disk.move('/host/.claude-real', '/host/claude');
      }
    };
    return { disk, homes, flip };
  };

  it('should refuse when the folder is flipped to a link at the open and back for the checks', async () => {
    // Arrange — the order that passed the old check by path: a link in place at the open, the real folder for the
    // `realpath`, the link again for the `lstat` (so its device and inode match what was opened).
    const { disk, homes, flip } = await host();
    let opened = false;
    disk.beforeOpen = path => {
      if (path.endsWith('/claude') || path.endsWith('/claude/skills')) flip(true);
    };
    disk.afterOpen = () => {
      opened = true;
      flip(false);
    };
    const identity = disk.identity.bind(disk);
    disk.identity = async path => {
      if (opened && path === '/host/claude/skills') flip(true);
      return await identity(path);
    };

    // Act
    const result = await openFolderOutsideStateHomes('/host/claude/skills', homes, disk);

    // Assert — refused, and no handle on the other runtime's folder was ever handed back.
    should(result.ok ? 'ok' : result.rule).equal('changed');
  });

  it('should refuse a folder of the resolved path that is gone by the time it is walked', async () => {
    // Arrange
    const { disk, homes } = await host();
    disk.beforeOpen = path => {
      if (!path.endsWith('/host')) return;
      disk.beforeOpen = undefined;
      disk.move('/host/claude', '/host/elsewhere');
    };

    // Act + Assert
    should(await rule(openFolderOutsideStateHomes('/host/claude/skills', homes, disk))).equal('changed');
  });

  it('should hand back the very folder it resolved when nothing moves', async () => {
    // Arrange
    const { disk, homes } = await host();

    // Act
    const folder = await opened(openFolderOutsideStateHomes('/host/claude/skills', homes, disk));

    // Assert
    should(folder.path).equal('/host/claude/skills');
    should(folder.anchored).be.true();
  });
});

describe('secrev-1262 L3 — pinned key folders are known by where they are', () => {
  it('should walk through a pinned folder at its own place and refuse it bound anywhere else', async () => {
    // Arrange — `fleet/homes` is a pinned key: every runtime's folder is reached through it, and a bind of it
    // into a runtime would put every other runtime's credentials under that runtime.
    const { disk } = await world();
    const homes = await resolveStateHomes(
      { homes: ['/fy', '/fy/state', '/fy/config'], openings: ['/fy/fleet/assets'], pinned: ['/fy/fleet/homes'] },
      disk,
    );
    disk.bind(`${SKILLS}/stale/all-homes`, '/fy/fleet/homes');

    // Act + Assert
    should((await opened(openFolderOutsideStateHomes(SKILLS, homes, disk))).path).equal(SKILLS);
    should(await rule(openFolderOutsideStateHomes(`${SKILLS}/stale/all-homes`, homes, disk))).equal('state-home');
  });

  it('should fail closed for a pinned key whose folder cannot be resolved', async () => {
    // Arrange — the key is there when it is looked at, and its folder cannot be resolved the moment after.
    const { disk } = await world();
    const realpath = disk.realpath.bind(disk);
    let resolved = 0;
    disk.realpath = async path => {
      if (path === '/fy/state') resolved += 1;
      if (path === '/fy/state' && resolved > 1) throw Object.assign(new Error(`EACCES ${path}`), { code: 'EACCES' });
      return await realpath(path);
    };

    // Act
    const outcome = await resolveStateHomes({ homes: ['/fy'], pinned: ['/fy/state/secrets.key'] }, disk).catch(
      (error: unknown) => error,
    );

    // Assert
    should(outcome).be.instanceOf(StateHomeUnresolvedError);
  });

  it('should say a folder reached by path is not anchored to its descriptor', async () => {
    // Arrange
    const { disk, homes } = await world(false);

    // Act
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));

    // Assert
    should(folder.anchored).be.false();
  });
});

describe('removeEntryWithin — a removal that never follows a link', () => {
  it('should remove a whole tree, unlinking a link inside it rather than what it points at', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.link(`${SKILLS}/stale/state`, '/fy/state');
    disk.link(`${SKILLS}/stale/token`, '/fy/api-token');
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));

    // Act
    await removeEntryWithin(folder, 'stale', homes, disk);

    // Assert
    should(await disk.identity(`${SKILLS}/stale`)).be.undefined();
    should((await disk.identity('/fy/state/secrets.key'))?.kind).equal('file');
    should((await disk.identity('/fy/api-token'))?.kind).equal('file');
  });

  it('should remove nothing in the home when a sub-folder is swapped for a link while the removal runs', async () => {
    // Arrange — the sub-folder is a folder when it is looked at, and a link into the home when it is opened.
    const { disk, homes } = await world();
    disk.dir(`${SKILLS}/stale/sub`);
    disk.file(`${SKILLS}/stale/sub/notes.md`, 3, 'abc');
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));
    disk.beforeOpen = path => {
      if (!path.endsWith('/sub')) return;
      disk.beforeOpen = undefined;
      disk.move(`${SKILLS}/stale/sub`, `${SKILLS}/sub-moved`);
      disk.link(`${SKILLS}/stale/sub`, '/fy/state');
    };

    // Act
    const outcome = await removeEntryWithin(folder, 'stale', homes, disk).catch((error: unknown) => error);

    // Assert — refused by the guard at the swapped folder, and the home's files are all there.
    should((outcome as Error).message).match(
      /refusing to remove .*\/sub: the state-home guard refused it \(changed\)/u,
    );
    should((await disk.identity('/fy/state/secrets.key'))?.kind).equal('file');
    should((await disk.identity('/fy/state'))?.kind).equal('directory');
  });

  it('should refuse to empty a folder in the tree that is a home by identity', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.bind(`${SKILLS}/stale/mounted`, '/fy/state');
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));

    // Act
    const outcome = await removeEntryWithin(folder, 'stale', homes, disk).catch((error: unknown) => error);

    // Assert
    should(outcome).be.instanceOf(Error);
    should((await disk.identity('/fy/state/secrets.key'))?.kind).equal('file');
  });

  it('should treat an entry that is already gone as removed', async () => {
    // Arrange
    const { disk, homes } = await world();
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));

    // Act + Assert
    await removeEntryWithin(folder, 'never-there', homes, disk);
  });
});

describe('descriptor calls (macOS) — every step goes through the held folder', () => {
  it('should reach the folder it opened after its path is swapped for a link into the home', async () => {
    // Arrange
    const { disk, homes } = await world('calls');
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));
    disk.move(SKILLS, '/fy/fleet/homes/one/elsewhere');
    disk.link(SKILLS, '/fy/state');

    // Act
    const listed = await folder.list();
    const key = await folder.describe('secrets.key');
    await folder.rename('stale', 'renamed');
    await folder.mkdir('made', 0o700);
    await folder.symlink('/nowhere', 'pointer');
    const descriptor = await folder.openFile('new.txt', 'new', 0o600);
    await folder.link(folder, 'new.txt', 'second.txt');
    await folder.unlink('pointer');
    await folder.rmdir('made');

    // Assert — all of it landed in the folder that was opened, none of it in the home.
    should(folder.anchored).be.true();
    should(listed).deepEqual(['stale']);
    should(key).be.undefined();
    should(descriptor).be.a.Number();
    should((await disk.list('/fy/fleet/homes/one/elsewhere')).toSorted()).deepEqual([
      'new.txt',
      'renamed',
      'second.txt',
    ]);
    should((await disk.list('/fy/state')).toSorted()).deepEqual(['secrets.key']);
  });

  it('should open a child and remove a whole tree through the descriptor calls', async () => {
    // Arrange
    const { disk, homes } = await world('calls');
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));

    // Act
    const child = await opened(openFolderBelow(folder, 'stale', homes, disk));
    await removeEntryWithin(folder, 'stale', homes, disk);

    // Assert
    should(child.path).equal(`${SKILLS}/stale`);
    should(await disk.identity(`${SKILLS}/stale`)).be.undefined();
  });

  it('should copy a tree into a folder held by descriptor calls, each file filled through its new descriptor', async () => {
    // Arrange
    const { disk, homes } = await world('calls');
    disk.dir('/src');
    disk.file('/src/a.md', 5, 'hello');
    disk.dir('/src/sub');
    disk.file('/src/sub/b.md', 3, 'abc');
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));

    // Act
    const copied = await copyTreeIntoFolder('/src', folder, 'copy', homes, disk, {
      maxFileBytes: 10,
      maxTotalBytes: 100,
      maxFiles: 10,
    });

    // Assert
    should(copied).match({ ok: true, value: { files: 2, bytes: 8 } });
    should(disk.entries.get(`${SKILLS}/copy/a.md`)).match({ kind: 'file', text: 'hello', size: 5 });
    should(disk.entries.get(`${SKILLS}/copy/sub/b.md`)).match({ kind: 'file', text: 'abc', size: 3 });
  });

  it('should refuse to copy into a descriptor where the disk cannot read into one', async () => {
    // Arrange — a disk whose read handles cannot fill a descriptor.
    const { disk, homes } = await world('calls');
    disk.dir('/src');
    disk.file('/src/a.md', 5, 'hello');
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));
    const openRead = disk.openRead.bind(disk);
    disk.openRead = async path => {
      const { copyToDescriptor: _dropped, ...handle } = await openRead(path);
      return handle;
    };

    // Act + Assert
    await should(
      copyTreeIntoFolder('/src/a.md', folder, 'copy.md', homes, disk, {
        maxFileBytes: 10,
        maxTotalBytes: 100,
        maxFiles: 10,
      }),
    ).be.rejectedWith(/cannot copy into a descriptor/u);
  });
});

describe('a folder reached through descriptor paths (Linux) or by path', () => {
  it('should give a file a second name through the folder, refusing a name already taken', async () => {
    // Arrange
    const { disk, homes } = await world();
    disk.file(`${SKILLS}/a`, 1, 'a');
    disk.file(`${SKILLS}/taken`, 1, 't');
    const folder = await opened(openFolderOutsideStateHomes(SKILLS, homes, disk));

    // Act
    await folder.link(folder, 'a', 'b');
    const refused = await folder.link(folder, 'a', 'taken').catch((error: unknown) => error);

    // Assert
    should(disk.entries.get(`${SKILLS}/b`)).equal(disk.entries.get(`${SKILLS}/a`));
    should((refused as NodeJS.ErrnoException).code).equal('EEXIST');
  });
});
