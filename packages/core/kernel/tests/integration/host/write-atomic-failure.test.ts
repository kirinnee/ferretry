import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeFs } from '../../../host/adapters/node-fs.ts';

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const fs = nodeFs(() => 'r');

async function folder(): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/fy-atomic-`);
  folders.push(path);
  return path;
}

describe('a failed atomic write leaves nothing partial behind', () => {
  test('a write that cannot be put in place (the name is a full folder) leaves no `<name>.<rand>.tmp`', async () => {
    const at = await folder();
    await mkdir(`${at}/model`);
    await writeFile(`${at}/model/keep`, 'x');
    await expect(fs.writeAtomic(`${at}/model`, new Uint8Array(4096))).rejects.toBeDefined();
    expect(await readdir(at)).toEqual(['model']);
  });

  test('a write that fails part way (the data cannot be written) leaves no temp file', async () => {
    const at = await folder();
    await expect(fs.writeAtomic(`${at}/model`, { not: 'bytes' } as unknown as Uint8Array)).rejects.toBeDefined();
    expect(await readdir(at)).toEqual([]);
  });

  test('a write that succeeds still replaces the file whole and leaves only it', async () => {
    const at = await folder();
    await fs.writeAtomic(`${at}/model`, new Uint8Array([1, 2, 3]));
    await fs.writeAtomic(`${at}/model`, new Uint8Array([4, 5]));
    expect(await readdir(at)).toEqual(['model']);
    expect([...(await fs.readBytes(`${at}/model`))]).toEqual([4, 5]);
  });
});
