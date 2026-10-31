import { describe, it } from 'bun:test';
import { realpath, stat } from 'node:fs/promises';
import should from 'should';
import { SystemExecutables } from '../../../src/adapters/system/executables.ts';

/** Where a running program's executable is, and who owns it, read from the real system. */

describe('SystemExecutables', () => {
  it("should find this process's own executable on Linux, and its owner", async () => {
    const executables = new SystemExecutables('linux', async () => undefined);
    const path = await executables.path(process.pid);
    if (process.platform !== 'linux') return;
    should(path).be.a.String();
    should(await realpath(path as string)).equal(await realpath(process.execPath));
    const owner = await executables.owner(path as string);
    should(owner?.uid).equal((await stat(path as string)).uid);
  });

  it('should ask ps for the path on macOS, and answer nothing it cannot read', async () => {
    const asked: (readonly string[])[] = [];
    const mac = new SystemExecutables('darwin', async argv => {
      asked.push(argv);
      return '/usr/bin/sudo\n';
    });
    should(await mac.path(42)).equal('/usr/bin/sudo');
    should(asked).deepEqual([['ps', '-p', '42', '-o', 'comm=']]);
    should(await new SystemExecutables('darwin', async () => '  \n').path(42)).be.undefined();
    should(await new SystemExecutables('darwin', async () => undefined).path(42)).be.undefined();
    should(await new SystemExecutables('win32', async () => '/x').path(42)).be.undefined();
    should(await new SystemExecutables('linux', async () => undefined).path(2 ** 30)).be.undefined();
    should(await new SystemExecutables('linux', async () => undefined).owner('/no/such/file')).be.undefined();
  });
});
