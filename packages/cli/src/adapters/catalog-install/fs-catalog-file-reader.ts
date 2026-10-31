import { readFile, stat } from 'node:fs/promises';
import type { ICatalogFileReader } from '../../lib/catalog-install/ports.ts';

export class FsCatalogFileReader implements ICatalogFileReader {
  async size(path: string): Promise<number> {
    const stats = await stat(path);
    if (!stats.isFile()) throw new Error(`${path} is not a file`);
    return stats.size;
  }

  async read(path: string): Promise<string> {
    return await readFile(path, 'utf8');
  }
}
