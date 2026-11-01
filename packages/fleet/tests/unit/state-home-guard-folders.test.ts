import { describe, it } from 'bun:test';
import should from 'should';
import {
  FolderChangedError,
  type GuardedFolder,
  openFolderBelow,
  openFolderOutsideStateHomes,
  removeEntryWithin,
  resolveStateHomes,
} from '../../src/lib/state-home-guard.ts';
import { FakeGuardDisk } from './fake-guard-disk.ts';

/**
 * The guard's destination side: a state home at `/fy` with its secrets and a runtime whose `skills` folder its
 * harness can swap at any moment, a host config folder `/host/.claude` outside it, and a dotfiles checkout it
 * links to.
 */
const world = async (throughDescriptors = true) => {
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
