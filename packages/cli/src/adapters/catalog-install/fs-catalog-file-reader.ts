import { open, stat } from 'node:fs/promises';
import type { ICatalogFileReader } from '../../lib/catalog-install/ports.ts';

export class FsCatalogFileReader implements ICatalogFileReader {
  async size(path: string): Promise<number> {
    const stats = await stat(path);
    if (!stats.isFile()) throw new Error(`${path} is not a file`);
    return stats.size;
  }

  async read(path: string, maxBytes: number): Promise<string> {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled > maxBytes) throw new Error(`${path} grew past ${maxBytes} bytes while being read`);
      return buffer.toString('utf8', 0, filled);
    } finally {
      await handle.close();
    }
  }
}
