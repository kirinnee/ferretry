import { afterEach, describe, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { NodeSkillFolder } from '../../../src/adapters/shared-catalogs/node-skill-folder.ts';
import { SKILL_WALK_LIMITS } from '../../../src/lib/shared-catalogs/skill-source.ts';

/** The skill folder walk over a REAL directory: what the disk says is what the port reports. */

const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) {
    await chmod(join(root, 'locked'), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

async function skill(files: Readonly<Record<string, string>>): Promise<{ root: string; manifest: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-skill-'));
  roots.add(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return { root, manifest: join(root, 'SKILL.md') };
}

describe('the skill folder on disk', () => {
  it('should list every file below the folder with its size', async () => {
    const { manifest } = await skill({ 'SKILL.md': 'abc', 'refs/a.md': 'hello', 'refs/deep/b.md': 'x' });

    const listing = await new NodeSkillFolder().list(manifest, SKILL_WALK_LIMITS);

    should(listing?.truncated).equal(false);
    should(listing?.entries.map(entry => `${entry.path}:${entry.type}:${entry.size}`).toSorted()).deepEqual([
      'SKILL.md:file:3',
      'refs/a.md:file:5',
      'refs/deep/b.md:file:1',
    ]);
  });

  it('should report a symbolic link as one and never enter it', async () => {
    const { root, manifest } = await skill({ 'SKILL.md': 'abc' });
    const outside = await skill({ 'secret.txt': 'keep out' });
    await symlink(outside.root, join(root, 'out'));
    await symlink(join(outside.root, 'secret.txt'), join(root, 'leak.txt'));

    const listing = await new NodeSkillFolder().list(manifest, SKILL_WALK_LIMITS);

    const byPath = new Map(listing?.entries.map(entry => [entry.path, entry.type]));
    should(byPath.get('out')).equal('symlink');
    should(byPath.get('leak.txt')).equal('symlink');
    should([...byPath.keys()].some(path => path.startsWith('out/'))).equal(false);
  });

  it('should refuse to read through a link, and to read outside the folder', async () => {
    const { root, manifest } = await skill({ 'SKILL.md': 'abc' });
    const outside = await skill({ 'secret.txt': 'keep out' });
    await symlink(join(outside.root, 'secret.txt'), join(root, 'leak.txt'));
    await symlink(outside.root, join(root, 'out'));
    const folder = new NodeSkillFolder();

    should(await folder.read(manifest, 'leak.txt', 1_000)).deepEqual({ ok: false, reason: 'unreadable' });
    should(await folder.read(manifest, 'out/secret.txt', 1_000)).deepEqual({ ok: false, reason: 'unreadable' });
    should(await folder.read(manifest, '../x', 1_000)).deepEqual({ ok: false, reason: 'unreadable' });
  });

  it('should list a file with a second hard link as one and never read it', async () => {
    const { root, manifest } = await skill({ 'SKILL.md': 'abc' });
    const outside = await skill({ 'secret.txt': 'keep out' });
    await link(join(outside.root, 'secret.txt'), join(root, 'linked.txt'));
    const folder = new NodeSkillFolder();

    const listing = await folder.list(manifest, SKILL_WALK_LIMITS);
    const read = await folder.read(manifest, 'linked.txt', 1_000);

    const byPath = new Map(listing?.entries.map(entry => [entry.path, entry.type]));
    should(byPath.get('linked.txt')).equal('hardlink');
    should(byPath.get('SKILL.md')).equal('file');
    should(read).deepEqual({ ok: false, reason: 'unreadable' });
  });

  it('should read a file within the limit and say too_big beyond it', async () => {
    const { manifest } = await skill({ 'SKILL.md': 'abc', 'big.txt': 'x'.repeat(20) });
    const folder = new NodeSkillFolder();

    const small = await folder.read(manifest, 'SKILL.md', 10);
    const big = await folder.read(manifest, 'big.txt', 10);

    should(small.ok).equal(true);
    should(small.ok ? new TextDecoder().decode(small.bytes) : '').equal('abc');
    should(big).deepEqual({ ok: false, reason: 'too_big' });
  });

  it('should mark a folder at the depth limit as deep and not enter it', async () => {
    const segments = Array.from({ length: SKILL_WALK_LIMITS.depth + 2 }, (_, index) => `d${index}`);
    const { manifest } = await skill({ 'SKILL.md': 'abc', [`${segments.join('/')}/file.txt`]: 'x' });

    const listing = await new NodeSkillFolder().list(manifest, SKILL_WALK_LIMITS);

    should(listing?.entries.some(entry => entry.type === 'deep')).equal(true);
    should(listing?.entries.some(entry => entry.path.endsWith('file.txt'))).equal(false);
  });

  it('should stop at the entry limit and say it did', async () => {
    const files: Record<string, string> = { 'SKILL.md': 'abc' };
    for (let index = 0; index < 8; index += 1) files[`f${index}.txt`] = 'x';
    const { manifest } = await skill(files);

    const listing = await new NodeSkillFolder().list(manifest, { entries: 4, depth: 16 });

    should(listing?.truncated).equal(true);
    should(listing?.entries).have.length(4);
  });

  it('should count folders toward the entry limit, so a tree of empty folders is cut short too', async () => {
    const { root, manifest } = await skill({ 'SKILL.md': 'abc' });
    for (let index = 0; index < 8; index += 1) await mkdir(join(root, `d${index}`));

    const listing = await new NodeSkillFolder().list(manifest, { entries: 4, depth: 16 });

    should(listing?.truncated).equal(true);
    should(listing?.entries.length).be.belowOrEqual(4);
  });

  it('should answer undefined for a folder that is not there', async () => {
    should(await new NodeSkillFolder().list('/nonexistent-ferretry/skill/SKILL.md', SKILL_WALK_LIMITS)).equal(
      undefined,
    );
  });

  it('should report a folder it cannot read as one thing it could not look at', async () => {
    const { root, manifest } = await skill({ 'SKILL.md': 'abc' });
    await mkdir(join(root, 'locked'));
    await chmod(join(root, 'locked'), 0o000);

    const listing = await new NodeSkillFolder().list(manifest, SKILL_WALK_LIMITS);

    should(listing?.entries.find(entry => entry.path === 'locked')).deepEqual({
      path: 'locked',
      type: 'other',
      size: 0,
    });
  });

  it('should report an entry it can list but not look at as something it could not look at', async () => {
    const { root, manifest } = await skill({ 'SKILL.md': 'abc', 'locked/inside.txt': 'x' });
    await chmod(join(root, 'locked'), 0o444);

    const listing = await new NodeSkillFolder().list(manifest, SKILL_WALK_LIMITS);

    should(listing?.entries.find(entry => entry.path === 'locked/inside.txt')).deepEqual({
      path: 'locked/inside.txt',
      type: 'other',
      size: 0,
    });
  });

  it('should report a pipe as neither a file nor a folder', async () => {
    const { root, manifest } = await skill({ 'SKILL.md': 'abc' });
    execFileSync('mkfifo', [join(root, 'pipe')]);

    const listing = await new NodeSkillFolder().list(manifest, SKILL_WALK_LIMITS);

    should(listing?.entries.find(entry => entry.path === 'pipe')).deepEqual({ path: 'pipe', type: 'other', size: 0 });
  });

  it('should answer undefined when the place the manifest is said to be in is not a folder', async () => {
    const { root } = await skill({ 'plain.txt': 'x' });

    should(await new NodeSkillFolder().list(join(root, 'plain.txt', 'SKILL.md'), SKILL_WALK_LIMITS)).equal(undefined);
  });
});
