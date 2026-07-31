import { inflateRawSync } from 'node:zlib';
import type { RawDeflatePort } from '../../lib/attachments/document-extraction.ts';

/** Node's bounded raw-DEFLATE implementation, kept outside the pure document policy. */
export class NodeRawDeflate implements RawDeflatePort {
  inflateRaw(input: Uint8Array, maxOutputBytes: number): Uint8Array {
    return new Uint8Array(inflateRawSync(input, { maxOutputLength: maxOutputBytes }));
  }
}
