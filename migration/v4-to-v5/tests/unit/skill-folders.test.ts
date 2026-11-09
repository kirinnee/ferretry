import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, link, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { skillFoldersStep } from '../../src/steps/skill-folders.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const v4 = async (path: string, text: string, mode = 0o600) => {
  const target = join(f.from, 'fleet/assets/skills', path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, text, { mode });
};
const v5 = (path: string) => join(f.to, 'fleet/assets/skills', path);

test('skill folders are copied byte for byte to the path v5 Runtimes reads; links are never followed', async () => {
  await v4('review/SKILL.md', '---\nname: review\n---\nFAKE skill body\n');
  await v4('review/scripts/run.sh', '#!/bin/sh\necho FAKE\n', 0o700);
  await v4('notes/SKILL.md', 'FAKE notes\n');
  await symlink('/etc/hostname', join(f.from, 'fleet/assets/skills/review/elsewhere'));
  await symlink(join(f.from, 'fleet/assets/skills/notes'), join(f.from, 'fleet/assets/skills/alias'));

  const report = await skillFoldersStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await readFile(v5('review/SKILL.md'), 'utf8')).toBe('---\nname: review\n---\nFAKE skill body\n');
  expect((await stat(v5('review/scripts/run.sh'))).mode & 0o777).toBe(0o700);
  expect(await readFile(v5('notes/SKILL.md'), 'utf8')).toBe('FAKE notes\n');
  expect((await readdir(v5(''))).sort()).toEqual(['notes', 'review']);
  expect((await readdir(v5('review'))).sort()).toEqual(['SKILL.md', 'scripts']);
  expect(report.kept).toEqual([
    { what: 'skill folders', count: 2 },
    { what: 'skill files copied without opening', count: 3 },
    { what: 'links not followed or re-made', count: 2 },
  ]);
  expect(JSON.stringify(report)).not.toContain('FAKE');
});

test('M1 a hard link in a skill folder to a key file is not copied and is named by its path, never its content', async () => {
  const KEY = 'FAKE-PRIVATE-KEY-0123456789';
  await mkdir(join(f.from, 'state'), { recursive: true });
  await writeFile(join(f.from, 'state/daemon-identity.json'), KEY, { mode: 0o600 });
  await v4('s/SKILL.md', 'FAKE skill\n');
  await link(join(f.from, 'state/daemon-identity.json'), join(f.from, 'fleet/assets/skills/s/notes.md'));

  const report = await skillFoldersStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await readFile(v5('s/SKILL.md'), 'utf8')).toBe('FAKE skill\n');
  expect(await stat(v5('s/notes.md')).catch(() => undefined)).toBeUndefined();
  expect(JSON.stringify(report)).toContain('skills/s/notes.md');
  expect(JSON.stringify(report)).toContain('a hard link (v4 refused it');
  expect(JSON.stringify(report)).not.toContain(KEY);
});

test('n1 the step lists the hard-link skip up front, and the file-level skip says only that file is left behind', async () => {
  const header = skillFoldersStep.notCarried.map(row => row.what).join('|');
  expect(header).toContain('files with a second hard link inside fleet/assets/skills');
  await v4('s/SKILL.md', 'FAKE skill\n');
  await writeFile(join(f.from, 'keep.txt'), 'FAKE', { mode: 0o600 });
  await link(join(f.from, 'keep.txt'), join(f.from, 'fleet/assets/skills/s/extra.md'));
  const report = await skillFoldersStep.run(f.ctx());
  expect(report.notCarried.map(row => row.what)).toContain('skills/s/extra.md');
  expect(JSON.stringify(report)).toContain('only this file is left behind');
});

test('n3 a skill whose SKILL.md is a hard link is refused whole by name; its other files and other skills are unaffected', async () => {
  await writeFile(join(f.from, 'outside.md'), 'FAKE outside\n', { mode: 0o600 });
  await v4('broken/scripts/run.sh', '#!/bin/sh\necho FAKE\n', 0o700);
  await v4('broken/notes.md', 'FAKE notes\n');
  await link(join(f.from, 'outside.md'), join(f.from, 'fleet/assets/skills/broken/SKILL.md'));
  await v4('fine/SKILL.md', 'FAKE fine\n');

  const report = await skillFoldersStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await stat(v5('broken')).catch(() => undefined)).toBeUndefined();
  expect(await readFile(v5('fine/SKILL.md'), 'utf8')).toBe('FAKE fine\n');
  const row = report.notCarried.find(entry => entry.what === 'skills/broken');
  expect(row?.why).toContain('SKILL.md is a hard link (v4 refused it');
  expect(row?.why).toContain('not carried at all');
  expect(report.kept).toContainEqual({ what: 'skill folders', count: 1 });
  expect(JSON.stringify(report)).not.toContain('FAKE');
  // A dry run names the same skill and writes nothing.
  const dry = await skillFoldersStep.run(f.ctx(true));
  expect(dry.notCarried.map(entry => entry.what)).toContain('skills/broken');
});

test('no asset tree converts to nothing; a dry run writes nothing', async () => {
  expect((await skillFoldersStep.run(f.ctx())).status).toBe('converted');
  await v4('review/SKILL.md', 'FAKE\n');
  const dry = await skillFoldersStep.run(f.ctx(true));
  expect(dry.status).toBe('converted');
  expect(dry.kept).toContainEqual({ what: 'skill files copied without opening', count: 1 });
  expect(await stat(v5('')).catch(() => undefined)).toBeUndefined();
});

test('an unreadable skill file fails the step by path with the remedy; a link in the tree path is refused', async () => {
  await v4('review/SKILL.md', 'FAKE\n');
  await chmod(join(f.from, 'fleet/assets/skills/review/SKILL.md'), 0o000);
  const report = await skillFoldersStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain('fleet/assets/skills/review/SKILL.md');
  expect(report.note).toContain('chmod u+r');
  await f.clean();
  f = await fixture();
  await mkdir(join(f.from, 'fleet/assets'), { recursive: true });
  await mkdir(join(f.from, 'elsewhere'));
  await symlink(join(f.from, 'elsewhere'), join(f.from, 'fleet/assets/skills'));
  const linked = await skillFoldersStep.run(f.ctx());
  expect(linked.status).toBe('failed');
  expect(linked.note).toContain("a link or file sits in a folder's place");
});
