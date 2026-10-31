import { randomBytes } from 'node:crypto';
import { access, lstat, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ICatalogFileWriter } from '../../lib/catalog/ports.ts';

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * Writes an exported catalog to disk. Without `overwrite` the open itself refuses a file that is there
 * (`wx`), so a file that appears between the check and the write is not replaced either. With `overwrite`
 * the text goes to a new file beside the destination and is renamed over it, so nothing that was planted
 * at the destination is ever opened for writing, and a destination that is a symbolic link is refused.
 */
export class FileCatalogWriter implements ICatalogFileWriter {
  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async write(path: string, text: string, overwrite: boolean): Promise<void> {
    if (overwrite) {
      await this.#replace(path, text);
      return;
    }
    try {
      await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (errno(error) === 'EEXIST') throw new Error(`${path} already exists — pass --force to replace it`);
      throw error;
    }
  }

  async #replace(path: string, text: string): Promise<void> {
    const present = await lstat(path).catch((error: unknown) => {
      if (errno(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (present?.isSymbolicLink() === true)
      throw new Error(`${path} is a symbolic link — refusing to write through it`);
    const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
