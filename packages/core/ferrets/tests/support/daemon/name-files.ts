import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Real temporary files for name-store tests; no host bootstrap or real state home is involved. */
export const nameFiles = {
  async readText(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  async writeTextAtomic(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const pending = `${path}.pending`;
    await writeFile(pending, text, { mode: 0o600 });
    await rename(pending, path);
  },
};
