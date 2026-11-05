import { createHash } from 'node:crypto';
import { VOICE_ENGINE_CODES, type VoiceArchive } from '@ferretry/protocol';
import { VoiceInstallError } from './errors.ts';
import type { VoiceFetch, VoiceInstallFiles } from './ports.ts';

/** Progress is reported at most this often, in bytes, so a fast link does not spend its time reporting. */
const PROGRESS_STEP_BYTES = 256 * 1024;

export interface DownloadDeps {
  readonly files: VoiceInstallFiles;
  readonly fetch: VoiceFetch;
}

/** The bytes of a file, hashed as they stream. */
async function hashFile(files: VoiceInstallFiles, path: string, into = createHash('sha256')) {
  for await (const chunk of files.read(path)) into.update(chunk);
  return into;
}

/** `bytes <start>-<end>/<total>` → `start`, or `undefined` when the header is absent or not that shape. */
function contentRangeStart(header: string | null): number | undefined {
  const match = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(header ?? '');
  return match === null ? undefined : Number.parseInt(match[1] ?? '', 10);
}

/**
 * Fetches `archive` into `destination`, RESUMING from the first missing byte, and leaves a file whose SHA-256
 * is the pin or no file at all.
 *
 *  - Whatever is already at `destination` is kept: a download that was cancelled or cut off resumes with an
 *    HTTP `Range` request from its size. A server that answers `200` instead of `206` ignored the range, so
 *    the partial file is emptied and the download starts again — never appended to.
 *  - The hash is taken WHILE it downloads (the partial bytes are read back through the hasher first, since a
 *    digest cannot be saved), and the finished file is read back from the disk once more: what is trusted is
 *    what is on the disk, not what the network said.
 *  - A cancel (the `signal`) or a network failure keeps the partial file. A size or hash that is wrong DELETES
 *    it — the bytes cannot be trusted and resuming them would only repeat the failure.
 */
export async function downloadArchive(
  deps: DownloadDeps,
  archive: VoiceArchive,
  destination: string,
  onProgress: (bytesDone: number) => void,
  onPhase: (phase: 'downloading' | 'verifying') => void,
  signal: AbortSignal,
): Promise<void> {
  const { files } = deps;
  let have = (await files.size(destination)) ?? 0;
  if (have > archive.bytes) {
    await files.remove(destination);
    have = 0;
  }
  onProgress(have);

  if (have < archive.bytes) {
    onPhase('downloading');
    await fetchInto(deps, archive, destination, have, onProgress, signal);
  }

  onPhase('verifying');
  const size = await files.size(destination);
  if (size !== archive.bytes) {
    await files.remove(destination);
    throw new VoiceInstallError(
      VOICE_ENGINE_CODES.hashMismatch,
      `the download is ${String(size ?? 0)} bytes, not the ${String(archive.bytes)} it should be; it was deleted — try again`,
    );
  }
  const digest = (await hashFile(files, destination)).digest('hex');
  if (digest !== archive.sha256) {
    await files.remove(destination);
    throw new VoiceInstallError(
      VOICE_ENGINE_CODES.hashMismatch,
      `the download does not match its pinned SHA-256 (got ${digest.slice(0, 12)}…, expected ${archive.sha256.slice(0, 12)}…); it was deleted — try again`,
    );
  }
}

async function fetchInto(
  deps: DownloadDeps,
  archive: VoiceArchive,
  destination: string,
  start: number,
  onProgress: (bytesDone: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const { files } = deps;
  let offset = start;
  let response: Response;
  try {
    response = await deps.fetch(archive.url, {
      headers: offset > 0 ? { range: `bytes=${String(offset)}-` } : {},
      signal,
    });
  } catch (error) {
    throw downloadFailure(error, signal);
  }

  if (response.status === 416 && offset > 0) {
    // The partial file is no longer a prefix of anything the server has: begin again, once.
    await response.body?.cancel().catch(() => undefined);
    await files.remove(destination);
    return await fetchInto(deps, archive, destination, 0, onProgress, signal);
  }
  const resumed = response.status === 206 && contentRangeStart(response.headers.get('content-range')) === offset;
  if (response.status !== 200 && !resumed) {
    await response.body?.cancel().catch(() => undefined);
    throw new VoiceInstallError(
      VOICE_ENGINE_CODES.download,
      `the download server answered ${String(response.status)} for ${archive.url}`,
    );
  }
  if (response.body === null)
    throw new VoiceInstallError(VOICE_ENGINE_CODES.download, 'the download server sent no data');

  // A `200` to a ranged request, or a `206` for some other range: the bytes are the whole file (or the wrong
  // piece), so what was kept cannot be appended to.
  const restart = offset > 0 && !resumed;
  if (restart) offset = 0;
  const hasher = createHash('sha256');
  if (offset > 0) await hashFile(files, destination, hasher);

  const sink = await files.openAppend(destination, { truncate: restart });
  let reported = offset;
  try {
    onProgress(offset);
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (offset + chunk.length > archive.bytes) {
        throw new VoiceInstallError(
          VOICE_ENGINE_CODES.hashMismatch,
          `the server sent more than the ${String(archive.bytes)} bytes this download should be`,
        );
      }
      await sink.write(chunk);
      hasher.update(chunk);
      offset += chunk.length;
      if (offset - reported >= PROGRESS_STEP_BYTES) {
        reported = offset;
        onProgress(offset);
      }
    }
  } catch (error) {
    await sink.close().catch(() => undefined);
    if (error instanceof VoiceInstallError) {
      await files.remove(destination);
      throw error;
    }
    throw downloadFailure(error, signal);
  }
  await sink.close();
  onProgress(offset);
  if (offset !== archive.bytes) {
    // The connection ended early: keep what arrived, so the next try resumes.
    throw new VoiceInstallError(
      VOICE_ENGINE_CODES.download,
      `the connection ended after ${String(offset)} of ${String(archive.bytes)} bytes; the part is kept, so Install resumes from there`,
    );
  }
  if (hasher.digest('hex') !== archive.sha256) {
    await files.remove(destination);
    throw new VoiceInstallError(
      VOICE_ENGINE_CODES.hashMismatch,
      `the download does not match its pinned SHA-256 (expected ${archive.sha256.slice(0, 12)}…); it was deleted — try again`,
    );
  }
}

/** Distinguishes a cancel from a network failure. Both keep the partial file. */
function downloadFailure(error: unknown, signal: AbortSignal): VoiceInstallError {
  if (signal.aborted)
    return new VoiceInstallError(
      VOICE_ENGINE_CODES.cancelled,
      'the install was cancelled; what was downloaded is kept',
    );
  const reason = error instanceof Error ? error.message : String(error);
  return new VoiceInstallError(
    VOICE_ENGINE_CODES.download,
    `the download failed (${reason}); the part is kept, so Install resumes from there`,
  );
}
