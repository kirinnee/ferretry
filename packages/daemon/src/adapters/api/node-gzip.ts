import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { ResponseCompressor } from '../../lib/api/compression.ts';

const gzipAsync = promisify(gzip);

/** Level 4: within a few percent of the default's size on JSON, at roughly half its CPU. */
const GZIP_LEVEL = 4;

/** Node's gzip on the thread pool, so a 1.7 MB list never holds the event loop while it compresses. */
export class NodeGzip implements ResponseCompressor {
  async gzip(text: string): Promise<Uint8Array> {
    return new Uint8Array(await gzipAsync(text, { level: GZIP_LEVEL }));
  }
}
