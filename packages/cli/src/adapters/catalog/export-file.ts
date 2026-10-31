import { access, writeFile } from 'node:fs/promises';
import type { ICatalogFileWriter } from '../../lib/catalog/ports.ts';

const exists = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';

/**
 * Writes an exported catalog to disk. Without `overwrite` the open itself refuses a file that is there
 * (`wx`), so a file that appears between the check and the write is not replaced either.
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
    try {
      await writeFile(path, text, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
    } catch (error) {
      if (exists(error)) throw new Error(`${path} already exists — pass --force to replace it`);
      throw error;
    }
  }
}
