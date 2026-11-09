/**
 * Where an Apply writes, over the kernel's REAL `work` root and real folders: a Repo lesson goes into the project's own
 * AGENTS.md / CLAUDE.md at its git root, reached only through a ferret whose folder holds that path; a link that leads
 * outside the ferret's folder is refused with a sentence, and a path no ferret holds is a refusal, never a crash.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { StateGlobalLessons, WorkRootLessonFiles } from '../../daemon/adapters/instruction-files.ts';
import { GLOBAL_LESSONS_FILE, LessonsError } from '../../daemon/lib/index.ts';
import { diskWorld, type DiskWorld } from './support/lessons-world.ts';

let world: DiskWorld;
beforeEach(async () => {
  world = await diskWorld();
});
afterEach(async () => {
  await world.dispose();
});

const files = () => new WorkRootLessonFiles(world.ferrets, world.roots, world.store);

const refusal = async (act: Promise<unknown>): Promise<LessonsError> => {
  const caught = await act.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(LessonsError);
  return caught as LessonsError;
};

describe('the project root', () => {
  it('is the folder that holds .git, found by walking up from the filing ferret’s folder', async () => {
    const repo = await world.folder('repo');
    await mkdir(`${repo}/.git`);
    const deep = await world.folder('repo', 'packages', 'daemon');
    world.ferret('lead', repo);
    world.ferret('deep', deep);

    expect(await files().projectRoot(deep)).toBe(repo);
    expect(await files().projectRoot(`${deep}/`)).toBe(repo);
    expect(await files().projectRoot(repo)).toBe(repo);
  });

  it('stops where sight ends and answers the filing folder when no .git is within reach', async () => {
    const deep = await world.folder('plain', 'packages', 'daemon');
    world.ferret('deep', deep);

    expect(await files().projectRoot(deep)).toBe(deep);
  });

  it('answers the folder it was given when no ferret holds it at all', async () => {
    const nowhere = await world.folder('nobody-here');

    expect(await files().projectRoot(nowhere)).toBe(nowhere);
  });

  it('walks all the way up to the top of the disk and gives up there when nothing holds a .git', async () => {
    const deep = await world.folder('walk', 'down');
    world.ferret('everything', '/');

    expect(await files().projectRoot(deep)).toBe(deep);
  });

  it('refuses with a sentence when the walk meets a link that leads outside the ferret’s folder', async () => {
    const repo = await world.folder('repo');
    const outside = await world.folder('elsewhere');
    await symlink(outside, `${repo}/linked`);
    world.ferret('lead', repo);

    const caught = await refusal(files().projectRoot(`${repo}/linked`));

    expect(caught.reason).toBe('invalid');
  });
});

describe('reading and writing a project’s instruction file', () => {
  it('writes the file through the ferret’s root and reads it back, and reads a missing one as nothing', async () => {
    const repo = await world.folder('repo');
    world.ferret('lead', repo);
    const path = files().join(`${repo}/`, 'AGENTS.md');

    expect(path).toBe(`${repo}/AGENTS.md`);
    expect(await files().read(path)).toBeUndefined();

    await files().write(path, '# Rules\n- Use bun.\n');

    expect(await readFile(path, 'utf8')).toBe('# Rules\n- Use bun.\n');
    expect(await files().read(path)).toBe('# Rules\n- Use bun.\n');
  });

  it('refuses a path no ferret’s folder holds, reading or writing, with a sentence that says where to start one', async () => {
    const stranger = await world.folder('stranger');
    const path = `${stranger}/AGENTS.md`;
    await writeFile(path, 'not yours');

    const reading = await refusal(files().read(path));
    const writing = await refusal(files().write(path, 'x'));

    expect(reading).toMatchObject({ reason: 'not-found' });
    expect(reading.message).toContain('start a ferret in that project and apply again');
    expect(writing.reason).toBe('not-found');
    expect(await readFile(path, 'utf8')).toBe('not yours');
  });

  it('refuses a file that is a link out of the ferret’s folder, never reading or writing through it', async () => {
    const repo = await world.folder('repo');
    const outside = await world.folder('elsewhere');
    await writeFile(`${outside}/secret.md`, 'outside text');
    await symlink(`${outside}/secret.md`, `${repo}/CLAUDE.md`);
    world.ferret('lead', repo);

    const reading = await refusal(files().read(`${repo}/CLAUDE.md`));
    const writing = await refusal(files().write(`${repo}/CLAUDE.md`, 'overwritten'));

    expect(reading.reason).toBe('invalid');
    expect(reading.message).toContain('is a link that leads outside the ferret');
    expect(writing.reason).toBe('invalid');
    expect(await readFile(`${outside}/secret.md`, 'utf8')).toBe('outside text');
  });

  it('refuses a file beneath a folder that is a link out of the ferret’s folder', async () => {
    const repo = await world.folder('repo');
    const outside = await world.folder('elsewhere');
    await symlink(outside, `${repo}/docs`);
    world.ferret('lead', repo);

    expect((await refusal(files().read(`${repo}/docs/AGENTS.md`))).reason).toBe('invalid');
  });
});

describe('the Global lessons document', () => {
  it('is this plugin’s own state, read and written by name and never as a file on disk', async () => {
    expect(await files().read(GLOBAL_LESSONS_FILE)).toBeUndefined();

    await files().write(GLOBAL_LESSONS_FILE, '# Lessons\n- Use bun.\n');

    expect(await files().read(GLOBAL_LESSONS_FILE)).toBe('# Lessons\n- Use bun.\n');
    expect(await world.store.readGlobal()).toBe('# Lessons\n- Use bun.\n');
  });

  it('is located by name, with the notes that say who reads it and how to change it', async () => {
    const located = await new StateGlobalLessons().locate();

    expect(located.path).toBe(GLOBAL_LESSONS_FILE);
    expect(located.notes).toEqual([
      'Every ferret reads this document at its next launch.',
      'Change or remove a rule in it from Settings › Lessons or with `fy lesson global`; it is not a file on disk.',
    ]);
    expect(await new StateGlobalLessons().ensureComponent()).toBeUndefined();
  });
});
