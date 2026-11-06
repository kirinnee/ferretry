import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { ResponseCompressor } from '../../lib/api/compression.ts';

const gzipAsync = promisify(gzip);

/** Level 4: within a few percent of the default's size on JSON, at roughly half its CPU. */
const GZIP_LEVEL = 4;

/**
 * Node's gzip on the thread pool, so a 1.7 MB list never holds the event loop while it compresses.
 *
 * THE LAST ANSWER IS KEPT. Compression runs on the pool, but handing it a string is not free: the text is
 * encoded into a buffer on the loop first, and on 2026-11-05 that encode of a ~6 MB session list showed in the
 * daemon's stall samples. The list route serves ONE body until a session moves, to every open app, so the
 * same text arrives again and again; one slot answers those repeats with the bytes already made. One slot,
 * not a cache keyed by body: it holds at most one body's gzip however long the daemon runs, and the body it
 * is keyed on is the one the route itself is already holding.
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
