import { describe, it } from 'bun:test';
import should from 'should';
import { readSkillFolder } from '../../../src/lib/shared-catalogs/skill-source.ts';
import { MemoryTree, SKILL_MD, SKILL_PATH } from './support.ts';

const big = (bytes: number) => new Uint8Array(bytes).fill(97);

describe('readSkillFolder', () => {
  it('should carry every text file, sorted, and list nothing as skipped', async () => {
    const tree = new MemoryTree();
    tree.set(SKILL_PATH, { 'b.txt': 'b', 'SKILL.md': SKILL_MD, 'a/c.md': 'c' });
    const read = await readSkillFolder(tree, SKILL_PATH);
    should(read.files.map(file => file.path)).deepEqual(['SKILL.md', 'a/c.md', 'b.txt']);
    should(read.problems).deepEqual([]);
    should(read.refusal).be.undefined();
  });

  it('should list a symlink, a special file, a deep folder, a binary file and .git with their reasons', async () => {
    const tree = new MemoryTree();
    tree.set(SKILL_PATH, {
      'SKILL.md': SKILL_MD,
      link: 'symlink',
      pipe: 'other',
      'deep/x': 'deep',
      'image.bin': new Uint8Array([1, 0, 2]),
      'latin.txt': new Uint8Array([0xff, 0xfe, 0x41]),
      '.git/config': 'x',
      'my file.txt': 'x',
    });
    const read = await readSkillFolder(tree, SKILL_PATH);
    const reasons = Object.fromEntries(read.problems.map(problem => [problem.subject, problem.reason]));
    should(reasons.link).match(/never followed/u);
    should(reasons.pipe).match(/not a regular file/u);
    should(reasons['deep/x']).match(/deeper than 16/u);
    should(reasons['image.bin']).match(/not text/u);
    should(reasons['latin.txt']).match(/not text/u);
    should(reasons['.git/config']).match(/not one a catalog carries/u);
    should(reasons['my file.txt']).match(/not one a catalog carries/u);
    should(read.files.map(file => file.path)).deepEqual(['SKILL.md']);
  });

  it('should list an oversize file and a file that fails to read, before reading the oversize one', async () => {
    const tree = new MemoryTree();
    tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'huge.txt': big(300 * 1024) });
    const read = await readSkillFolder(tree, SKILL_PATH);
    should(read.problems[0]?.reason).match(/larger than 256 KiB/u);
    const listed = tree.list.bind(tree);
    tree.list = async (path: string) => {
      const listing = await listed(path);
      return listing === undefined
        ? undefined
        : {
            ...listing,
            entries: [
              ...listing.entries.map(entry => (entry.path === 'grown.txt' ? { ...entry, size: 1 } : entry)),
              { path: 'ghost.txt', type: 'file' as const, size: 1 },
            ],
          };
    };
    tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'grown.txt': big(300 * 1024) });
    const again = await readSkillFolder(tree, SKILL_PATH);
    should(again.problems.map(problem => problem.subject).sort()).deepEqual(['ghost.txt', 'grown.txt']);
    should(again.problems.map(problem => problem.reason).sort()).deepEqual([
      'it could not be read',
      'larger than 256 KiB',
    ]);
  });

  it('should stop at 200 files and at 2 MiB, and say what it left out', async () => {
    const many = new MemoryTree();
    many.set(SKILL_PATH, {
      'SKILL.md': SKILL_MD,
      ...Object.fromEntries(Array.from({ length: 205 }, (_, index) => [`f${String(index).padStart(3, '0')}.txt`, 'x'])),
    });
    const files = await readSkillFolder(many, SKILL_PATH);
    should(files.files).have.length(200);
    should(files.problems).have.length(6);
    should(files.problems[0]?.reason).match(/at most 200 files/u);

    const heavy = new MemoryTree();
    heavy.set(SKILL_PATH, {
      'SKILL.md': SKILL_MD,
      ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`h${index}.txt`, big(250 * 1024)])),
    });
    const total = await readSkillFolder(heavy, SKILL_PATH);
    should(total.problems.some(problem => /past 2 MiB/u.test(problem.reason))).be.true();
  });

  it('should refuse two names that are one file on a Mac or on Windows', async () => {
    const tree = new MemoryTree();
    tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'Notes.txt': 'a', 'notes.txt': 'b' });
    const read = await readSkillFolder(tree, SKILL_PATH);
    should(read.problems[0]?.reason).match(/same file as Notes.txt/u);
  });

  it('should say when the walk was cut short', async () => {
    const tree = new MemoryTree();
    tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD });
    tree.truncated = true;
    const read = await readSkillFolder(tree, SKILL_PATH);
    should(read.problems[0]?.subject).equal('(the rest of the folder)');
  });

  it('should refuse a folder that cannot be read, and one whose SKILL.md cannot be carried', async () => {
    const tree = new MemoryTree();
    should((await readSkillFolder(tree, SKILL_PATH)).refusal).match(/cannot be read any more/u);
    tree.set(SKILL_PATH, { 'SKILL.md': new Uint8Array([0]), 'a.txt': 'a' });
    should((await readSkillFolder(tree, SKILL_PATH)).refusal).match(/SKILL.md cannot be carried: not text/u);
    tree.set(SKILL_PATH, { 'a.txt': 'a' });
    should((await readSkillFolder(tree, SKILL_PATH)).refusal).match(/not in the folder/u);
  });
});
