import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { SystemdUserSliceReader } from '../../../src/adapters/system/user-slice-reader.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const who = { uid: 1001, user: 'alice' } as const;

/** A temporary host: systemd present, one user's slice, and a linger directory. */
const host = async (systemd = true) => {
  const root = await mkdtemp(join(tmpdir(), 'fy-user-slice-'));
  directories.push(root);
  const places = { systemd: join(root, 'run-systemd'), cgroups: join(root, 'cgroup'), linger: join(root, 'linger') };
  const slice = join(places.cgroups, 'user.slice', 'user-1001.slice');
  await Promise.all([mkdir(slice, { recursive: true }), mkdir(places.linger, { recursive: true })]);
  if (systemd) await mkdir(places.systemd, { recursive: true });
  return { places, slice };
};

describe('systemd user slice reader', () => {
  it('should read the slice caps and linger from plain files', async () => {
    const { places, slice } = await host();
    await writeFile(join(slice, 'memory.max'), '12884901888\n');
    await writeFile(join(slice, 'pids.max'), 'max\n');
    await writeFile(join(places.linger, 'alice'), '');

    const value = await new SystemdUserSliceReader(who, places).read();

    should(value).eql({ ...who, memoryMax: '12884901888', tasksMax: 'max', linger: true });
  });

  it('should leave out a limit whose file is absent or empty, and report linger off', async () => {
    const { places, slice } = await host();
    await writeFile(join(slice, 'pids.max'), '\n');

    const value = await new SystemdUserSliceReader(who, places).read();

    should(value).eql({ ...who, linger: false });
  });

  it('should answer nothing where systemd is not running', async () => {
    const { places } = await host(false);

    should(await new SystemdUserSliceReader(who, places).read()).equal(undefined);
  });

  it('should give up rather than hold the report when a read hangs', async () => {
    const { places } = await host();

    const value = await new SystemdUserSliceReader(who, places, 20, () => new Promise<string>(() => undefined)).read();

    should(value).equal(undefined);
  });
});
