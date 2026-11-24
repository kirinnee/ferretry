import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { startChildThread } from '../../daemon/adapters/child-speech-thread.ts';
import { nativeHostCommand } from '../../daemon/adapters/worker-speech-thread.ts';
import { processSpawn } from '../support/daemon/process-spawn.ts';
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

/** The pids of the native hosts these tests started, so a test can check none is left after an unload. */
const hostPids: number[] = [];

/**
 * A native engine's host as the daemon starts it (a child process of `speech-host.ts`), over a real `Bun.spawn`. A bare Nix
 * shell has no C++ runtime for the library to find, so `FY_NATIVE_LD` (the folder of a `libstdc++.so.6`) is handed to the
 * child here: the daemon's own spawn is sealed and passes nothing, which is the point of it.
 */
export function nativeHost<Call extends { readonly kind: string }, Reply extends { readonly ok: true }>(
  engine: 'speech' | 'reply',
) {
  const ld = process.env.FY_NATIVE_LD;
  return startChildThread<Call, Reply>({
    spawn: processSpawn({ pids: hostPids }, ld === undefined ? {} : { LD_LIBRARY_PATH: ld }),
    clock: {
      after: (delay, fn) => {
        const timer = setTimeout(fn, delay);
        return () => clearTimeout(timer);
      },
    },
    command: nativeHostCommand(engine),
    words: engine === 'speech' ? 'speech engine' : 'reply voice',
  });
}

/** The native hosts started by these tests that are still running (after an unload there must be none: no orphan). */
export function liveHosts(): number[] {
  return hostPids.filter(pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}
