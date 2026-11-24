import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { EnginePathsPort } from '../../daemon/lib/engine/ports.ts';
import { type NativeParts, nativeTargetFor, nativeThreads } from '../../daemon/lib/native/catalog.ts';

/**
 * The engines' files on a real disk, one file per role in `dir`, as `StateEngineFiles` keeps them: the native engine reads
 * its library and models by PATH, so a realworld test of it cannot hold them in memory. The same folder is kept between
 * runs when a test is given one, so a 700 MB download is made once.
 */
export class DiskFiles implements EnginePathsPort {
  constructor(private readonly dir: string) {}
  pathOf(file: { role: string }): string {
    return join(this.dir, file.role);
  }
  async size(file: { role: string }): Promise<number | undefined> {
    return await stat(this.pathOf(file)).then(
      s => s.size,
      () => undefined,
    );
  }
  async read(file: { role: string }): Promise<Uint8Array | undefined> {
    return await readFile(this.pathOf(file)).then(
      buffer => new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
      () => undefined,
    );
  }
  async write(file: { role: string }, bytes: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathOf(file), bytes);
  }
  async remove(file: { role: string }): Promise<void> {
    await unlink(this.pathOf(file)).catch(() => undefined);
  }
  async freeBytes(): Promise<undefined> {
    return undefined;
  }
}

/** The native engine this machine can run, or none when `wasm` is asked for (`FY_*_ENGINE=wasm` measures the fallback). */
export function nativeFor(engine: string | undefined): NativeParts {
  return {
    target: engine === 'wasm' ? undefined : nativeTargetFor(process.platform, process.arch),
    threads: () => nativeThreads(availableParallelism()),
    platform: `${process.platform}-${process.arch}`,
  };
}
