import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type { TranscriptImageFiles } from '../lib/session/image-reader.ts';

/**
 * The transcript files an image handle names, read through the read-only `harness-history` root. The root's reads are
 * whole-or-prefix (`readBytes(path, limit)`), so a range is a prefix read to its end and a slice of it: bounded by the
 * record's own size, which the image reader keeps small.
 */
export function historyFiles(root: RootHandle): TranscriptImageFiles {
  const path = (file: string): FencedPath | undefined => {
    const resolved = root.resolve(file);
    return resolved.ok ? resolved.value : undefined;
  };
  return {
    async fingerprint(file) {
      const fenced = path(file);
      if (fenced === undefined) return undefined;
      const stat = await root.stat(fenced);
      if (stat === undefined || stat.kind !== 'file') return undefined;
      return { size: stat.size, mtimeMs: Date.parse(stat.modified) };
    },
    async readRange(file, byteOffset, byteLength) {
      const fenced = path(file);
      if (fenced === undefined) return new Uint8Array(0);
      const bytes = await root.readBytes(fenced, byteOffset + byteLength);
      return bytes.subarray(byteOffset, byteOffset + byteLength);
    },
  };
}
