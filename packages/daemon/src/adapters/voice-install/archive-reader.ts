import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import type { VoiceArchiveFormat } from '@ferretry/protocol';
import { NoDecompressorError, type VoiceArchiveReader } from '../../lib/voice-install/index.ts';

/**
 * Turns an archive file into the tar stream inside it.
 *
 * `.tgz` is gunzipped in-process. `.tar.bz2` — the format every sherpa-onnx model is published in — goes
 * through the machine's own `bzip2 -dc`: Bun and Node have no bzip2, and a hand-written decompressor in a
 * daemon would be a worse thing to trust than the one every Linux and macOS ships. Only the DECOMPRESSION
 * is delegated; what is inside the stream is read and written by `unpackTar`, which never runs `tar`.
 */
export class SystemVoiceArchiveReader implements VoiceArchiveReader {
  tarStream(path: string, format: VoiceArchiveFormat, signal: AbortSignal): AsyncIterable<Uint8Array> {
    return format === 'tgz' ? gunzipped(path, signal) : bunzipped(path, signal);
  }
}

async function* gunzipped(path: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  signal.throwIfAborted();
  const stream = createReadStream(path).pipe(createGunzip());
  const abort = (): void => void stream.destroy(new DOMException('aborted', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) yield chunk as Uint8Array;
  } finally {
    signal.removeEventListener('abort', abort);
    stream.destroy();
  }
}

async function* bunzipped(path: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  signal.throwIfAborted();
  const child = spawn('bzip2', ['-dc', '--', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  let missing = false;
  let stderr = '';
  child.once('error', error => {
    missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 2_000) stderr += chunk.toString('utf8');
  });
  const exited = new Promise<number | null>(resolve => {
    child.once('close', code => resolve(code));
    child.once('error', () => resolve(null));
  });
  const stop = (): void => void child.kill('SIGTERM');
  signal.addEventListener('abort', stop, { once: true });
  try {
    for await (const chunk of child.stdout) yield chunk as Uint8Array;
    const code = await exited;
    if (missing) throw new NoDecompressorError('bzip2');
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (code !== 0) throw new Error(`bzip2 could not unpack the archive (exit ${String(code)}): ${stderr.trim()}`);
  } finally {
    signal.removeEventListener('abort', stop);
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}
