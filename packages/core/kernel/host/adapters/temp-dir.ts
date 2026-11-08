import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** A selftest's own scratch directory: made fresh (owner-only, as `mkdtemp` does) and removed whole afterwards. */
export interface TempDirs {
  make(): Promise<string>;
  remove(path: string): Promise<void>;
  /**
   * Removes every directory this object ever made, again. A selftest that outlived its timeout can recreate its
   * directory after the first removal; the host calls this just before it exits.
   */
  removeAll(): Promise<void>;
}

/** The temporary root used when `$TMPDIR` points inside the state home. */
const FALLBACK_ROOT = '/tmp';

const settled = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
};

/** Whether `child` is `parent` or lies below it (links resolved where they exist). */
async function isInside(parent: string, child: string): Promise<boolean> {
  const between = relative(await settled(parent), await settled(child));
  return (
    between === '' ||
    (between !== '..' && !between.startsWith('..\\') && !between.startsWith('../') && !isAbsolute(between))
  );
}

/**
 * Scratch directories under the operating system's temporary root, never inside the state `home`: an odd
 * `TMPDIR=$FY_HOME/x` would otherwise make and delete files in the home, which `--check` promises not to touch.
 */
export function nodeTempDirs(home: string, root: () => string = tmpdir): TempDirs {
  const made = new Set<string>();
  const chooseRoot = async (): Promise<string> => {
    for (const candidate of [root(), FALLBACK_ROOT]) if (!(await isInside(home, candidate))) return candidate;
    throw new Error('no temporary folder outside the state home is available');
  };
  return {
    make: async () => {
      const path = await mkdtemp(join(await chooseRoot(), 'fyd-selftest-'));
      made.add(path);
      return path;
    },
    remove: async path => await rm(path, { recursive: true, force: true }),
    removeAll: async () => {
      await Promise.all(
        [...made].map(async path => {
          try {
            await rm(path, { recursive: true, force: true });
          } catch {
            // best effort: the process is about to exit
          }
        }),
      );
    },
  };
}
