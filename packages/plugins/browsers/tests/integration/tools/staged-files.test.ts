import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FencedPath } from '@ferretry/kernel/contract';
import { nodeStagedFiles } from '../../../daemon/tools/adapters/staged-files.ts';
import { STAGED_FILE_TTL_MS } from '../../../daemon/tools/files-policy.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fresh = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'fy-staged-files-'));
  roots.push(root);
  return root;
};
const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;
const refusal = async (work: Promise<unknown>): Promise<unknown> =>
  await work.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('the copies staged for a page’s uploads', () => {
  test('a copy is placed in a private folder of its own, owner-only, and the same name twice never meets', async () => {
    const root = await fresh();
    const now = 1_000_000;
    const files = nodeStagedFiles(join(root, 'upload'), { nowMs: () => now });

    const first = await files.place('report.csv', new TextEncoder().encode('a,b'));
    const second = await files.place('report.csv', new TextEncoder().encode('c,d'));

    expect(first).not.toBe(second);
    expect(await readFile(first, 'utf8')).toBe('a,b');
    expect((await stat(first)).mode & 0o077).toBe(0);
    expect((await stat(join(first, '..'))).mode & 0o077).toBe(0);
    expect(first.startsWith(join(root, 'upload', `${String(now)}-`))).toBe(true);
  });

  test('copies past their time go the next time one is placed, recent ones stay, and strays with no time go too', async () => {
    const root = await fresh();
    const upload = join(root, 'upload');
    let now = 10 * STAGED_FILE_TTL_MS;
    const files = nodeStagedFiles(upload, { nowMs: () => now });
    const old = await files.place('old.txt', new Uint8Array([1]));
    await mkdir(join(upload, 'stray-folder'), { recursive: true });
    await writeFile(join(upload, 'stray-file'), 'x');

    now += STAGED_FILE_TTL_MS - 1;
    const recent = await files.place('recent.txt', new Uint8Array([2]));
    now += 2;
    const latest = await files.place('latest.txt', new Uint8Array([3]));

    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(latest)).toBe(true);
    expect((await readdir(upload)).sort()).toHaveLength(2);
  });
});

describe('a saved download copied out of its stage', () => {
  const staged = async () => {
    const root = await fresh();
    await mkdir(join(root, 'stage'), { recursive: true });
    const from = join(root, 'stage', 'dl-1-data.csv');
    await writeFile(from, 'a,b\n1,2\n');
    return {
      root,
      from,
      to: join(root, 'work', 'downloads', 'data.csv') as FencedPath,
      files: nodeStagedFiles(join(root, 'upload'), { nowMs: () => 0 }),
    };
  };

  test('the bytes are copied, never executable, the staged file stays, and a second save needs overwrite', async () => {
    const { from, to, files } = await staged();

    expect(await files.copy(from, to, { overwrite: false, maxBytes: 1024 })).toBe(8);
    expect(await refusal(files.copy(from, to, { overwrite: false, maxBytes: 1024 }))).toBeInstanceOf(Error);
    expect(await files.copy(from, to, { overwrite: true, maxBytes: 1024 })).toBe(8);

    expect(await readFile(to, 'utf8')).toBe('a,b\n1,2\n');
    expect((await stat(to)).mode & 0o111).toBe(0);
    expect(await exists(from)).toBe(true);
  });

  test('a staged file that is gone or grows past the limit leaves no half-made file behind', async () => {
    const { from, to, files } = await staged();

    expect(await refusal(files.copy(from, to, { overwrite: false, maxBytes: 4 }))).toHaveProperty(
      'message',
      'over the save size limit',
    );
    expect(await exists(to)).toBe(false);
    await rm(from);
    expect(await refusal(files.copy(from, to, { overwrite: false, maxBytes: 1024 }))).toBeInstanceOf(Error);
    expect(await exists(to)).toBe(false);
  });

  test('a link planted where the copy goes, or as the staged file, is never followed', async () => {
    const { root, from, to, files } = await staged();
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'untouched');
    await mkdir(join(root, 'work', 'downloads'), { recursive: true });
    await symlink(outside, to);

    expect(await refusal(files.copy(from, to, { overwrite: true, maxBytes: 1024 }))).toBeInstanceOf(Error);
    expect(await readFile(outside, 'utf8')).toBe('untouched');

    const target = join(root, 'work', 'downloads', 'other.csv') as FencedPath;
    const link = join(root, 'stage', 'dl-2-link.csv');
    await symlink(outside, link);
    expect(await refusal(files.copy(link, target, { overwrite: false, maxBytes: 1024 }))).toBeInstanceOf(Error);
    expect(await exists(target)).toBe(false);
  });
});
