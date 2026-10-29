import type { TranscriptImageFiles } from '../../lib/session/transcript/image-reader.ts';
import { NodeTranscriptFileRuntime, type TranscriptFileRuntime } from './file-source.ts';

/** The transcript file's size, modification time and byte ranges for the image reader, over the daemon's own file runtime. */
export class NodeTranscriptImageFiles implements TranscriptImageFiles {
  constructor(private readonly runtime: TranscriptFileRuntime = new NodeTranscriptFileRuntime()) {}

  async fingerprint(file: string): Promise<{ readonly size: number; readonly mtimeMs: number } | undefined> {
    const info = await this.runtime.info(file);
    return info === undefined || !info.isFile ? undefined : { size: info.size, mtimeMs: info.modifiedMs };
  }

  async readRange(file: string, byteOffset: number, byteLength: number): Promise<Uint8Array> {
    return await this.runtime.readRange(file, byteOffset, byteLength);
  }
}
