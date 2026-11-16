import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { writePictureFile } from '../../../cli/adapters/picture-file.ts';

describe('writePictureFile', () => {
  let folder = '';
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'fy-picture-'));
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('writes the screenshot bytes to the chosen path, byte for byte', async () => {
    const path = join(folder, 'shot.png');
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    await writePictureFile(path, bytes);
    should(new Uint8Array(await readFile(path))).deepEqual(bytes);
  });

  it('refuses a path whose folder does not exist, and writes nothing', async () => {
    await should(writePictureFile(join(folder, 'missing', 'shot.png'), new Uint8Array([1]))).be.rejectedWith({
      code: 'ENOENT',
    });
  });
});
