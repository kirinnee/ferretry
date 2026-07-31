import type { SttWorkerRequest } from '@ferretry/protocol';
import { fileURLToPath } from 'node:url';
import type { SpawnSttWorkerOptions, SttWorkerHandle, SttWorkerSpawner } from './worker-client.ts';

/** The worker entry point shipped beside the daemon. */
export function defaultWorkerEntry(): string {
  return fileURLToPath(new URL('../../../bin/stt-worker.ts', import.meta.url));
}

export interface BunSttWorkerSpawnerOptions {
  /** Absolute path to the worker entry; defaults to the one we ship. */
  readonly entry?: string;
  /** The runtime that executes the entry; defaults to this Bun. */
  readonly runtime?: string;
  /** Extra environment for the child, merged over the daemon's own. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

/**
 * Spawns the worker with Bun's advanced IPC, so Float32Array audio crosses the
 * boundary without a JSON copy. The child is never detached: it dies with the
 * daemon, and `kill()` is safe to call after it has already exited.
 */
export class BunSttWorkerSpawner implements SttWorkerSpawner {
  constructor(private readonly options: BunSttWorkerSpawnerOptions = {}) {}

  spawn(handlers: SpawnSttWorkerOptions): SttWorkerHandle {
    const entry = this.options.entry ?? defaultWorkerEntry();
    const runtime = this.options.runtime ?? process.execPath;
    const child = Bun.spawn([runtime, entry], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.environment },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      ipc: message => {
        handlers.onMessage(message);
      },
      serialization: 'advanced',
      onExit: (_subprocess, exitCode, signalCode) => {
        handlers.onExit(exitCode, signalCode);
      },
    });

    void pumpStderr(child.stderr, handlers.onStderr);

    return {
      pid: child.pid,
      send: (message: SttWorkerRequest) => {
        child.send(message);
      },
      terminate: () => {
        safely(() => child.kill('SIGTERM'));
      },
      kill: () => {
        safely(() => child.kill('SIGKILL'));
      },
    };
  }
}

function safely(act: () => void): void {
  try {
    act();
  } catch {
    // The child is already gone; there is nothing left to signal.
  }
}

async function pumpStderr(stream: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) onChunk(decoder.decode(chunk, { stream: true }));
  } catch {
    // A closed pipe just means the child is gone.
  }
}
