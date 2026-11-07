import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FencedPath } from '@ferretry/kernel/contract';
import { nodeStagedFiles } from '../../../daemon/tools/adapters/staged-files.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function folder(): Promise<{ readonly root: string; readonly staged: string; readonly saved: FencedPath }> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-staged-files-'));
  roots.push(root);
  await mkdir(join(root, 'stage'), { recursive: true });
  const staged = join(root, 'stage', 'dl-1-data.csv');
  await writeFile(staged, 'a,b\n1,2\n');
  return { root, staged, saved: join(root, 'work', 'downloads', 'data.csv') as FencedPath };
}

const mover = (root: string) => nodeStagedFiles(join(root, 'upload'), { nowMs: () => 0 });
const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;

describe('nodeStagedFiles.copy', () => {
  it('should keep the staged file, so the same download can be saved again with overwrite', async () => {
    // Arrange
    const { root, staged, saved } = await folder();
    const files = mover(root);

    // Act
    const first = await files.copy(staged, saved, { overwrite: false, maxBytes: 1024 });
    const refused = await files.copy(staged, saved, { overwrite: false, maxBytes: 1024 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const second = await files.copy(staged, saved, { overwrite: true, maxBytes: 1024 });

    // Assert
    expect(first).toBe(8);
    expect(refused).toBeInstanceOf(Error);
    expect(second).toBe(8);
    expect(await readFile(saved, 'utf8')).toBe('a,b\n1,2\n');
    expect(await exists(staged)).toBe(true);
    expect((await stat(saved)).mode & 0o111).toBe(0);
  });

  it('should leave no half-made file, and no open handle, when the staged file is gone', async () => {
    // Arrange
    const { root, staged, saved } = await folder();
    await rm(staged);

    // Act
    const failed = await mover(root)
      .copy(staged, saved, { overwrite: false, maxBytes: 1024 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Assert
    expect(failed).toBeInstanceOf(Error);
    expect(await exists(saved)).toBe(false);
  });

  it('should remove the saved file when the staged one grows past the limit', async () => {
    // Arrange
    const { root, staged, saved } = await folder();

    // Act
    const failed = await mover(root)
      .copy(staged, saved, { overwrite: false, maxBytes: 4 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Assert
    expect(failed).toBeInstanceOf(Error);
    expect(await exists(saved)).toBe(false);
    expect(await exists(staged)).toBe(true);
  });
});
