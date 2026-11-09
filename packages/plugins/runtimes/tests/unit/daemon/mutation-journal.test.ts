/**
 * The undo log over the `fleet` root: evidence is MOVED aside (a link stays a link), a restore is a rename back, and
 * nothing is deleted on a decision about a name that could have changed since: an entry changed after this batch wrote
 * it is kept and named. Rows: S44 (a backup is deleted only from the folder it was moved to, after the commit).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, lstat, mkdir, readdir, readFile, readlink, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileMutationJournal, isMutationReservedName } from '../../../daemon/adapters/mutation-journal.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

const journalOf = (world: FleetWorld) => new FileMutationJournal(world.disk, async () => undefined);
const exists = async (path: string): Promise<boolean> =>
  await lstat(path).then(
    () => true,
    () => false,
  );
const sealed = async (journal: FileMutationJournal, mark: number) => await journal.sealOperation(mark);

describe('the mutation journal', () => {
  it('moves a file aside, rolls it back by renaming, and a link comes back as a link (never followed)', async () => {
    const world = await fleetWorld();
    const file = join(world.fleet, 'a.txt');
    const link = join(world.fleet, 'l');
    await writeFile(file, 'original');
    await writeFile(join(world.parent, 'target'), 'target text');
    await symlink(join(world.parent, 'target'), link);
    const journal = journalOf(world);

    const mark = journal.beginOperation();
    expect(await journal.capture(file)).toBe(true);
    expect(await journal.capture(link)).toBe(true);
    expect(await exists(file)).toBe(false);
    await world.disk.create(file, new TextEncoder().encode('new'), 0o600);
    await sealed(journal, mark);
    const outcome = await journal.rollback();

    expect(outcome).toEqual({ unrestored: [], displaced: [] });
    expect(await readFile(file, 'utf8')).toBe('original');
    expect(await readlink(link)).toBe(join(world.parent, 'target'));
    expect((await readdir(world.fleet)).filter(isMutationReservedName)).toEqual([]);
  });

  it('captures a path once: a later capture of the same path is this batch’s own work', async () => {
    const world = await fleetWorld();
    const file = join(world.fleet, 'a.txt');
    await writeFile(file, 'original');
    const journal = journalOf(world);

    expect(await journal.capture(file)).toBe(true);
    await world.disk.create(file, new TextEncoder().encode('mine'), 0o600);
    expect(await journal.capture(file)).toBe(false);
  });

  it('S44 keeps the only copy of the original when somebody changed what the batch wrote', async () => {
    const world = await fleetWorld();
    const file = join(world.fleet, 'a.txt');
    await writeFile(file, 'original');
    const journal = journalOf(world);
    const mark = journal.beginOperation();
    await journal.capture(file);
    await world.disk.create(file, new TextEncoder().encode('mine'), 0o600);
    await sealed(journal, mark);
    await writeFile(file, 'edited meanwhile!');

    const outcome = await journal.rollback();

    expect(outcome.unrestored).toHaveLength(1);
    expect(outcome.unrestored[0]?.reason).toMatch(/changed after this apply wrote it, so the original was left at /u);
    const backup = outcome.unrestored[0]?.backup as string;
    expect(await readFile(backup, 'utf8')).toBe('original');
    expect(await readFile(file, 'utf8')).toBe('edited meanwhile!');
  });

  it('refuses to touch an entry whose folder was swapped for another after the capture', async () => {
    const world = await fleetWorld();
    const folder = join(world.fleet, 'homes');
    await mkdir(folder);
    await writeFile(join(folder, 'a.txt'), 'original');
    const journal = journalOf(world);
    const mark = journal.beginOperation();
    await journal.capture(join(folder, 'a.txt'));
    await sealed(journal, mark);
    // The folder is moved away and another put in its place.
    await rename(folder, join(world.fleet, 'moved'));
    await mkdir(folder);

    const outcome = await journal.rollback();

    expect(outcome.unrestored[0]?.reason).toMatch(/the folder it is in was replaced after this apply wrote there/u);
    expect(await readdir(folder)).toEqual([]);
  });

  it('keeps a tree it cannot summarise: not knowing is not the same as knowing it is ours', async () => {
    const world = await fleetWorld();
    const folder = join(world.fleet, 'skills');
    await mkdir(join(folder, 'one'), { recursive: true });
    await writeFile(join(folder, 'one', 'a.md'), 'a');
    await writeFile(join(folder, 'b.md'), 'b');
    const journal = new FileMutationJournal(world.disk, async () => undefined, 1);
    const mark = journal.beginOperation();
    await journal.capture(folder);
    await mkdir(folder);
    await writeFile(join(folder, 'new.md'), 'mine');
    await writeFile(join(folder, 'new2.md'), 'mine too');
    await sealed(journal, mark);

    const outcome = await journal.rollback();

    expect(outcome.unrestored[0]?.reason).toMatch(/changed after this apply wrote it/u);
    expect(await readFile(join(folder, 'new.md'), 'utf8')).toBe('mine');
    expect(await readFile(join(outcome.unrestored[0]?.backup as string, 'b.md'), 'utf8')).toBe('b');
  });

  it('removes a folder it created only while it is still empty', async () => {
    const world = await fleetWorld();
    const journal = journalOf(world);
    const created = join(world.fleet, 'new', 'deep');
    await journal.captureDirectory(created);
    await mkdir(created, { recursive: true });

    expect(await journal.rollback()).toEqual({ unrestored: [], displaced: [] });
    expect(await exists(join(world.fleet, 'new'))).toBe(false);

    const second = journalOf(world);
    await second.captureDirectory(created);
    await mkdir(created, { recursive: true });
    await writeFile(join(created, 'theirs.txt'), 'somebody else');
    const outcome = await second.rollback();
    expect(outcome.unrestored.map(entry => entry.reason).join()).toMatch(/no longer empty/u);
    expect(await readFile(join(created, 'theirs.txt'), 'utf8')).toBe('somebody else');
  });

  it('restores a mode it changed, but not one somebody else has since chosen', async () => {
    const world = await fleetWorld();
    const folder = join(world.fleet, 'bin');
    await mkdir(folder, { mode: 0o700 });
    const journal = journalOf(world);
    const mark = journal.beginOperation();
    await journal.captureDirectory(folder, 0o500);
    await world.disk.setMode(folder, 0o500);
    await sealed(journal, mark);

    expect(await journal.rollback()).toEqual({ unrestored: [], displaced: [] });
    // The fleet root keeps owner bits only: a restore can narrow or keep a mode, never add a group or other bit.
    expect((await stat(folder)).mode & 0o777).toBe(0o700);

    // Somebody who has since chosen their own mode is not corrected by a rollback.
    const again = journalOf(world);
    const next = again.beginOperation();
    await again.captureDirectory(folder, 0o500);
    await world.disk.setMode(folder, 0o500);
    await sealed(again, next);
    await world.disk.setMode(folder, 0o400);
    const outcome = await again.rollback();
    expect(outcome.unrestored[0]?.reason).toMatch(/changed after this apply set it/u);
    expect((await stat(folder)).mode & 0o777).toBe(0o400);
  });

  it('S44 discards its backups only after the commit, each from the folder it was moved to', async () => {
    const world = await fleetWorld();
    const file = join(world.fleet, 'a.txt');
    await writeFile(file, 'original');
    const journal = journalOf(world);
    await journal.capture(file);
    expect((await readdir(world.fleet)).filter(isMutationReservedName)).toHaveLength(1);

    expect(await journal.discard()).toEqual([]);

    expect((await readdir(world.fleet)).filter(isMutationReservedName)).toEqual([]);
  });

  it('displaces what it cannot prove is its own and names where it went', async () => {
    const world = await fleetWorld();
    const file = join(world.fleet, 'a.txt');
    await writeFile(file, 'theirs');
    const journal = journalOf(world);

    await journal.displace(file, async () => false);
    const outcome = await journal.rollback();

    expect(outcome.displaced).toHaveLength(1);
    expect(outcome.displaced[0]?.path).toBe(file);
    expect(await readFile(outcome.displaced[0]?.movedTo as string, 'utf8')).toBe('theirs');
    expect(await exists(file)).toBe(false);
  });

  it('S44 M8 discards a backup only from the folder it was moved to: a swapped folder keeps its look-alike', async () => {
    const world = await fleetWorld();
    const folder = join(world.fleet, 'homes');
    await mkdir(folder);
    await writeFile(join(folder, 'a.txt'), 'original');
    const journal = journalOf(world);
    await journal.capture(join(folder, 'a.txt'));
    const [backupName] = (await readdir(folder)).filter(isMutationReservedName);
    // The folder is moved away (with the real backup in it) and another put in its place holding a look-alike name.
    await rename(folder, join(world.fleet, 'moved'));
    await mkdir(folder);
    await writeFile(join(folder, backupName as string), 'somebody else’s file with the same name');

    const remaining = await journal.discard();

    expect(remaining).toEqual([join(folder, backupName as string)]);
    expect(await readFile(join(folder, backupName as string), 'utf8')).toBe('somebody else’s file with the same name');
    expect(await readFile(join(world.fleet, 'moved', backupName as string), 'utf8')).toBe('original');
  });

  it('m5 does not call a mode restored when the fleet root could only give back the owner bits', async () => {
    const world = await fleetWorld();
    const folder = join(world.fleet, 'bin');
    await mkdir(folder, { mode: 0o755 });
    await chmod(folder, 0o755);
    const journal = journalOf(world);
    const mark = journal.beginOperation();
    await journal.captureDirectory(folder, 0o500);
    await world.disk.setMode(folder, 0o500);
    await sealed(journal, mark);

    const outcome = await journal.rollback();

    expect(outcome.unrestored).toHaveLength(1);
    expect(outcome.unrestored[0]?.reason).toMatch(/mode .*755.*700|owner/u);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });
});
