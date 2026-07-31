import type { IAudioFileReader } from '../../lib/stt/ports.ts';

/**
 * Reads an audio clip off the local disk.
 *
 * A missing or unreadable file is reported with its path: Bun's own error names the syscall, which
 * tells the person at the terminal nothing about which argument they mistyped.
 */
export class BunAudioFileReader implements IAudioFileReader {
  async read(path: string): Promise<Uint8Array> {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`no audio file at "${path}"`);
    try {
      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      throw new Error(`cannot read "${path}": ${(error as Error).message}`);
    }
  }
}
