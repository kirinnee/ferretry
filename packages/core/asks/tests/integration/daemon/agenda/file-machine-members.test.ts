import { describe, it } from 'bun:test';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { FileMachineMembers } from '../../../src/adapters/agenda/file-machine-members.ts';
import { withTempRoot } from '../atomic-file/fixtures.ts';

const files = {
  readText: (path: string) => readFile(path, 'utf8'),
  writeTextAtomic: async (path: string, text: string) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(`${path}.tmp`, text);
    await rename(`${path}.tmp`, path);
  },
};

describe('FileMachineMembers', () => {
  it('should read an empty record when nothing was written', async () => {
    await withTempRoot(async root => {
      should(await new FileMachineMembers(files, join(root, 'members.json')).read()).eql({});
    });
  });

  it('should read back what it wrote', async () => {
    await withTempRoot(async root => {
      const store = new FileMachineMembers(files, join(root, 'members.json'));
      await store.write({ 'warden:orphans': ['F1', 'F2'] });
      should(await store.read()).eql({ 'warden:orphans': ['F1', 'F2'] });
    });
  });

  it('should read an empty record from a file that is not JSON or not the right shape', async () => {
    await withTempRoot(async root => {
      const path = join(root, 'members.json');
      const store = new FileMachineMembers(files, path);
      await writeFile(path, '{nope');
      should(await store.read()).eql({});
      await writeFile(path, '{"a": 3}');
      should(await store.read()).eql({});
    });
  });
});
