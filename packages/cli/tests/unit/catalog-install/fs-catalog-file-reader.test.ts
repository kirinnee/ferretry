import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FsCatalogFileReader } from '../../../src/adapters/catalog-install/fs-catalog-file-reader.ts';

describe('FsCatalogFileReader', () => {
  it('should answer the size of a file and then its text, and refuse a folder or a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fy-catalog-reader-'));
    try {
      const file = join(dir, 'c.json');
      await writeFile(file, 'héllo');
      const reader = new FsCatalogFileReader();

      should(await reader.size(file)).equal(6);
      should(await reader.read(file, 6)).equal('héllo');
      await should(reader.read(file, 5)).be.rejectedWith(/grew past 5 bytes/u);
      await should(reader.read(join(dir, 'missing'), 5)).be.rejected();
      await mkdir(join(dir, 'sub'));
      await should(reader.size(join(dir, 'sub'))).be.rejectedWith(/is not a file/u);
      await should(reader.size(join(dir, 'missing'))).be.rejected();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
