import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { ResponseCompressor } from '../compression.ts';

const gzipAsync = promisify(gzip);

/** Level 4: within a few percent of the default's size on JSON, at roughly half its CPU. */
const GZIP_LEVEL = 4;

/**
 * Node's gzip on the thread pool, so a large list never holds the event loop while it compresses (today's
 * `NodeGzip`). THE LAST ANSWER IS KEPT: one slot answers a repeat of the same body with the bytes already made.
 */
export class NodeGzip implements ResponseCompressor {
  #last: { readonly text: string; readonly gzip: Promise<Uint8Array> } | undefined;

  async gzip(text: string): Promise<Uint8Array> {
    const last = this.#last;
    if (last?.text === text) return await last.gzip;
    const made = gzipAsync(text, { level: GZIP_LEVEL }).then(buffer => new Uint8Array(buffer));
    this.#last = { text, gzip: made };
    try {
      return await made;
    } catch (error) {
      if (this.#last?.gzip === made) this.#last = undefined;
      throw error;
    }
  }
}
