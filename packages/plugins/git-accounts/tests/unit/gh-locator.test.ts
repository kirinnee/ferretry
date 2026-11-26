import { describe, expect, test } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import { ghLocator } from '../../daemon/lib/gh-locator.ts';
import { testClient } from './run-folder.ts';

const HOME = '/h/.fy';

/** Ports over a made-up machine: `found` maps a directory list to nothing, the first folder holding a `gh` wins. */
function locator(
  path: string | undefined,
  hasGh: readonly string[],
  fenced: (path: string) => string | undefined = () => undefined,
) {
  const asked: { directories: readonly string[] }[] = [];
  const checked: string[] = [];
  const run = ghLocator({
    bindProgram: async program => testClient(program),
    daemonPath: () => path,
    which: async (_name, options) => {
      asked.push(options);
      const dirs = [...options.directories, ...(path ?? '').split(':')];
      const folder = dirs.find(dir => hasGh.includes(dir));
      return folder === undefined ? undefined : `${folder}/gh`;
    },
    stateHomeHolding: async candidate => {
      checked.push(candidate);
      return fenced(candidate);
    },
  });
  return { run, asked, checked };
}
const inHome = (path: string) => (path === HOME || path.startsWith(`${HOME}/`) ? HOME : undefined);

describe('which gh runs with a token', () => {
  test('the first gh outside the state home, as an absolute path; state-home, relative, empty and repeated entries are never offered', async () => {
    const { run, asked } = locator(
      `${HOME}/shims:rel/bin::/opt/bin:/opt/bin:/usr/bin`,
      [`${HOME}/shims`, '/usr/bin'],
      inHome,
    );
    // The child's `PATH` is the same filtered list: no state-home folder (the shim folder) in it.
    expect(await run()).toMatchObject({ program: '/usr/bin/gh', path: '/usr/bin:/bin' });
    expect(asked[0]?.directories).toEqual(['/opt/bin', '/usr/bin']);
  });

  test('the folder gh was found in is always on the child PATH, even one the kernel reached by its own fallback', async () => {
    const run = ghLocator({
      bindProgram: async program => testClient(program),
      daemonPath: () => `${HOME}/shims`,
      which: async () => '/opt/gh/bin/gh',
      stateHomeHolding: async candidate => inHome(candidate),
    });
    expect(await run()).toMatchObject({ program: '/opt/gh/bin/gh', path: '/usr/bin:/bin' });
  });

  test('a PATH the daemon does not have still searches (the kernel falls back to its own list)', async () => {
    const { run, asked } = locator(undefined, []);
    await expect(run()).rejects.toMatchObject({ status: 403, code: 'invalid_request' });
    expect(asked[0]?.directories).toEqual([]);
  });

  test('no gh anywhere refuses in a sentence', async () => {
    await expect(locator('/usr/bin', []).run()).rejects.toThrow('no gh program was found outside');
  });

  test('a gh the kernel found inside the state home (by the fallback to the whole PATH) is refused', async () => {
    const { run, checked } = locator(`${HOME}/shims:/usr/bin`, [`${HOME}/shims`], inHome);
    await expect(run()).rejects.toThrow("inside Ferretry's own folders");
    expect(checked.at(-1)).toBe(`${HOME}/shims/gh`);
  });

  test('a fence that cannot be built is a refusal, not a guess, and the error is always an ApiError', async () => {
    const run = ghLocator({
      bindProgram: async program => testClient(program),
      daemonPath: () => '/usr/bin',
      which: async () => '/usr/bin/gh',
      stateHomeHolding: async () => {
        throw new Error('fence');
      },
    });
    const error = await run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('could not check where the gh program is');
  });
});
