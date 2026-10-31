import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCatalogWriter } from '../../../src/adapters/catalog/export-file';

/** The one place `fy catalog export` touches the disk. */

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fy-catalog-export-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('writing an exported catalog', () => {
  it('should create the file with exactly the text given', async () => {
    const path = join(directory, 'team.catalog.json');
    await new FileCatalogWriter().write(path, '{"a":1}\n', false);
    expect(await readFile(path, 'utf8')).toBe('{"a":1}\n');
  });

  it('should report whether a file is there', async () => {
    const writer = new FileCatalogWriter();
    const path = join(directory, 'team.catalog.json');
    expect(await writer.exists(path)).toBe(false);
    await writeFile(path, 'x');
    expect(await writer.exists(path)).toBe(true);
  });

  it('should refuse to replace a file without overwrite, leaving it untouched', async () => {
    const path = join(directory, 'team.catalog.json');
    await writeFile(path, 'precious');
    await expect(new FileCatalogWriter().write(path, 'new', false)).rejects.toThrow(/already exists — pass --force/u);
    expect(await readFile(path, 'utf8')).toBe('precious');
  });

  it('should replace a file with overwrite', async () => {
    const path = join(directory, 'team.catalog.json');
    await writeFile(path, 'old');
    await new FileCatalogWriter().write(path, 'new', true);
    expect(await readFile(path, 'utf8')).toBe('new');
  });

  it('should let any other failure through as it is', async () => {
    await expect(new FileCatalogWriter().write(join(directory, 'no', 'such', 'dir.json'), 'x', false)).rejects.toThrow(
      /ENOENT/u,
    );
  });
});

describe('replacing an exported catalog', () => {
  it('should write beside it and rename, leaving no temporary file behind', async () => {
    const path = join(directory, 'team.catalog.json');
    await writeFile(path, 'old');
    await new FileCatalogWriter().write(path, 'new', true);
    expect(await readdir(directory)).toEqual(['team.catalog.json']);
  });

  it('should create the file with overwrite when nothing is there yet', async () => {
    const path = join(directory, 'fresh.json');
    await new FileCatalogWriter().write(path, 'new', true);
    expect(await readFile(path, 'utf8')).toBe('new');
  });

  it('should refuse a destination that is a symbolic link, leaving its target untouched', async () => {
    const target = join(directory, 'target.json');
    const path = join(directory, 'team.catalog.json');
    await writeFile(target, 'precious');
    await symlink(target, path);
    await expect(new FileCatalogWriter().write(path, 'new', true)).rejects.toThrow(/symbolic link/u);
    expect(await readFile(target, 'utf8')).toBe('precious');
  });

  it('should leave nothing behind when the folder is missing, and let a failed look through', async () => {
    const missing = join(directory, 'no', 'such');
    await expect(new FileCatalogWriter().write(join(missing, 'x.json'), 'x', true)).rejects.toThrow(/ENOENT/u);
    await writeFile(join(directory, 'file'), 'x');
    await expect(new FileCatalogWriter().write(join(directory, 'file', 'x.json'), 'x', true)).rejects.toThrow(
      /ENOTDIR/u,
    );
  });
});
