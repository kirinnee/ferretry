import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { IStateHomeFilePort, StateHomeEntry } from '../../lib/state-home/ports.ts';

/**
 * The state home on disk, for the one purpose of claiming it.
 *
 * This is the only adapter in this package that writes at the top level of `<FY_HOME>`, and it
 * writes exactly one file. Everything else the client puts under the home goes through the fleet
 * provisioner or the service supervisor, into a subdirectory those own.
 */
export class FileStateHomeClaim implements IStateHomeFilePort {
  async listHome(home: string): Promise<readonly StateHomeEntry[] | undefined> {
    try {
      const entries = await readdir(home, { withFileTypes: true });
      return entries.map(entry => ({ name: entry.name, directory: entry.isDirectory() }));
    } catch (error) {
      // An absent home is the normal first-run answer, not a failure. Anything else — a permission
      // denial, a path that is a file — is a real problem and must not read as "nothing there".
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async readMarker(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async ensureDirectory(path: string, mode: number): Promise<void> {
    await mkdir(path, { recursive: true, mode });
  }

  /**
   * Write the marker through a scratch file in the same directory, then rename over the target.
   *
   * Same directory because a rename is only atomic within one filesystem, and the mode is set again
   * after the rename because the process umask masks the mode `writeFile` is given — an owner-only
   * file that arrives as `0o644` under a permissive umask is not the file that was asked for. The
   * scratch name matches the pattern the daemon's own bootstrap recovery recognises, so a crash
   * between write and rename leaves a home that is still adoptable rather than one that reads as
   * foreign.
   */
  async writeMarkerAtomic(path: string, contents: string, mode: number): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { encoding: 'utf8', mode });
      await chmod(temporary, mode);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
