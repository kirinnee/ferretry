import { inflateRawSync } from 'node:zlib';
import type { RawDeflatePort } from '../lib/document-extraction.ts';

/**
 * Node's bounded raw-DEFLATE implementation, kept outside the pure document policy: `maxOutputLength` is what keeps
 * DOCX extraction from being fed a zip bomb.
 */
export class NodeRawDeflate implements RawDeflatePort {
  inflateRaw(input: Uint8Array, maxOutputBytes: number): Uint8Array {
    return new Uint8Array(inflateRawSync(input, { maxOutputLength: maxOutputBytes }));
  }
}
