import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileCatalogWriter } from '../../../cli/adapters/export-file.ts';

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'fy-catalog-export-'));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('the catalog export file writer (v4 FileCatalogWriter)', () => {
  it('should write a new file and report that it exists afterwards', async () => {
    // Arrange
    const writer = new FileCatalogWriter();
    const path = join(folder, 'team.fycat');

    // Act
    const before = await writer.exists(path);
    await writer.write(path, '{"signed":true}\n', false);

    // Assert
    should(before).be.false();
    should(await writer.exists(path)).be.true();
    should(await readFile(path, 'utf8')).equal('{"signed":true}\n');
  });

  it('should refuse to replace a file that is there unless told to, and leave it as it was', async () => {
    // Arrange
    const writer = new FileCatalogWriter();
    const path = join(folder, 'team.fycat');
    await writeFile(path, 'old');

    // Act / Assert
    await should(writer.write(path, 'new', false)).be.rejectedWith(/already exists — pass --force to replace it/u);
    should(await readFile(path, 'utf8')).equal('old');
  });

  it('should replace a file beside a temporary one and leave no temporary behind', async () => {
    // Arrange
    const writer = new FileCatalogWriter();
    const path = join(folder, 'team.fycat');
    await writeFile(path, 'old');

    // Act
    await writer.write(path, 'new', true);

    // Assert
    should(await readFile(path, 'utf8')).equal('new');
    should(await readdir(folder)).eql(['team.fycat']);
  });

  it('should refuse to write through a symbolic link', async () => {
    // Arrange
    const writer = new FileCatalogWriter();
    const target = join(folder, 'elsewhere');
    await writeFile(target, 'outside');
    const path = join(folder, 'team.fycat');
    await symlink(target, path);

    // Act / Assert
    await should(writer.write(path, 'new', true)).be.rejectedWith(/symbolic link/u);
    should(await readFile(target, 'utf8')).equal('outside');
  });

  it('should say what went wrong, not that the file exists, when a new file cannot be written for another reason', async () => {
    // Arrange
    const writer = new FileCatalogWriter();
    const path = join(folder, 'no-such-folder', 'team.fycat');

    // Act / Assert
    await should(writer.write(path, 'new', false)).be.rejectedWith(/ENOENT/u);
  });

  it('should pass on a destination that cannot even be looked at, and write nothing', async () => {
    // Arrange: the "folder" it would sit in is a plain file.
    const writer = new FileCatalogWriter();
    await writeFile(join(folder, 'plain'), 'x');

    // Act / Assert
    await should(writer.write(join(folder, 'plain', 'team.fycat'), 'new', true)).be.rejectedWith(/ENOTDIR/u);
    should(await readdir(folder)).eql(['plain']);
  });

  it('should leave no temporary file behind when the new one cannot be moved over the destination', async () => {
    // Arrange: a folder sits where the file would go, so the rename is refused.
    const writer = new FileCatalogWriter();
    const path = join(folder, 'team.fycat');
    await mkdir(path);

    // Act / Assert
    await should(writer.write(path, 'new', true)).be.rejected();
    should(await readdir(folder)).eql(['team.fycat']);
  });
});
