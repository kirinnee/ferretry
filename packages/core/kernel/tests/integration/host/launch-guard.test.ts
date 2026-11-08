/** The launch guard is decided once at boot from the variable and the home, on the real filesystem's links. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { launchGuardFor, UNDECIDED_LAUNCH_GUARD } from '../../../host/adapters/launch-guard.ts';

const scratch: string[] = [];
afterAll(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

async function scratchDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(`${tmpdir()}/fy-guard-`));
  scratch.push(directory);
  return directory;
}

describe('launchGuardFor on the real filesystem', () => {
  test('a home under the machine temporary folder turns the guard on, and the search path is read each time it is asked', async () => {
    const home = await scratchDirectory();
    const environment: Record<string, string | undefined> = { PATH: '/first' };
    const guard = launchGuardFor({ home, environment });
    expect(guard()).toEqual({ active: true, searchPath: '/first' });
    environment['PATH'] = '/second';
    expect(guard().searchPath).toBe('/second');
    expect(Object.isFrozen(guard())).toBe(true);
  });

  test('a home reached through a link into a temporary folder is judged by where it really is', async () => {
    const real = await scratchDirectory();
    const elsewhere = await scratchDirectory();
    const link = `${elsewhere}/home-link`;
    await symlink(real, link);
    const guard = launchGuardFor({ home: link, environment: {}, temporaryRoots: [real] });
    expect(guard()).toEqual({ active: true });
  });

  test('a home outside every temporary folder leaves the guard off unless the runner said so, and no PATH means no search path', async () => {
    const outside = await scratchDirectory();
    const home = `${outside}/state`;
    await mkdir(home);
    const off = launchGuardFor({ home, environment: {}, temporaryRoots: ['/nonexistent-temporary-root'] });
    expect(off()).toEqual({ active: false });
    const flagged = launchGuardFor({
      home,
      environment: { FERRETRY_TEST: '1' },
      temporaryRoots: ['/nonexistent-temporary-root'],
    });
    expect(flagged().active).toBe(true);
  });

  test('a home that does not exist is judged by the name it was given', () => {
    const guard = launchGuardFor({
      home: '/nonexistent-fy-home/state',
      environment: {},
      temporaryRoots: ['/nonexistent-fy-home'],
    });
    expect(guard().active).toBe(true);
  });

  test('a host never told how the kernel decided holds the guard ON with no search path', () => {
    expect(UNDECIDED_LAUNCH_GUARD()).toEqual({ active: true });
  });
});
