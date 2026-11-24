import { createHash } from 'node:crypto';
import { VoiceEngineError } from '../../../contract/index.ts';
import { ENGINE_FILES, type EngineFile } from './catalog.ts';
import type { EngineFilesPort, HttpPort } from './ports.ts';

const MAX_REDIRECTS = 5;

/** GET `url`, following redirects by hand (the port never follows one), each hop through the same declared-hosts guard. */
async function get(http: HttpPort, url: string): Promise<Response> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await http.request(target);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) break;
      target = new URL(location, target).href;
      continue;
    }
    return response;
  }
  throw new VoiceEngineError('download_failed', 'A speech file kept redirecting; the download was stopped.');
}

/**
 * Downloads ONE pinned file into memory, hashing as it arrives. The buffer is allocated at the pinned size, so a
 * server that sends more is refused as soon as it overruns and the file never needs a second copy. Only bytes whose
 * size AND SHA-256 equal the pin are returned.
 */
export async function download(
  http: HttpPort,
  file: EngineFile,
  onBytes: (received: number) => void,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await get(http, file.url);
  } catch (error) {
    if (error instanceof VoiceEngineError) throw error;
    throw new VoiceEngineError('download_failed', `${file.label} could not be downloaded.`, { cause: error });
  }
  if (!response.ok || response.body === null)
    throw new VoiceEngineError(
      'download_failed',
      `${file.label} could not be downloaded (the server said ${response.status}).`,
    );
  const bytes = new Uint8Array(file.bytes);
  const hash = createHash('sha256');
  let received = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (received + chunk.byteLength > file.bytes)
        throw new VoiceEngineError(
          'hash_mismatch',
          `${file.label} is not the file this version expects, so it was thrown away.`,
        );
      bytes.set(chunk, received);
      hash.update(chunk);
      received += chunk.byteLength;
      onBytes(chunk.byteLength);
    }
  } catch (error) {
    if (error instanceof VoiceEngineError) throw error;
    throw new VoiceEngineError('download_failed', `${file.label} stopped downloading part way.`, { cause: error });
  }
  if (received !== file.bytes || hash.digest('hex') !== file.sha256)
    throw new VoiceEngineError(
      'hash_mismatch',
      `${file.label} is not the file this version expects, so it was thrown away.`,
    );
  return bytes;
}

/** Room left on the disk after the files are saved, so Install never fills it. */
export const DISK_MARGIN_BYTES = 1_000_000_000;

/** "1.7 GB" / "340 MB": sizes a person reads. */
function sized(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

/** The files of `catalog` that are not on disk at their pinned size. */
export async function missingOf(files: EngineFilesPort, catalog: readonly EngineFile[]): Promise<EngineFile[]> {
  const missing: EngineFile[] = [];
  for (const file of catalog) if ((await files.size(file)) !== file.bytes) missing.push(file);
  return missing;
}

/**
 * Refuses with `no_disk` (and a sentence that says how much is needed and how much is free) unless the models folder has
 * room for `missing` plus {@link DISK_MARGIN_BYTES}. A host that cannot say how much is free is not blocked on a guess.
 */
export async function ensureRoom(files: EngineFilesPort, missing: readonly EngineFile[]): Promise<void> {
  const downloadBytes = missing.reduce((sum, file) => sum + file.bytes, 0);
  if (downloadBytes === 0) return;
  const free = await files.freeBytes();
  if (free !== undefined && free < downloadBytes + DISK_MARGIN_BYTES)
    throw new VoiceEngineError(
      'no_disk',
      `There is not enough free disk space for speech. It needs ${sized(downloadBytes + DISK_MARGIN_BYTES)} free (${sized(downloadBytes)} to download plus ${sized(DISK_MARGIN_BYTES)} to spare) and this machine has ${sized(free)} free.`,
    );
}

/**
 * Installs every missing file, one at a time (peak memory is the largest file, 652 MB), writing each only after it
 * verified. A file already present at its pinned size is kept: it was verified when written. Before anything is
 * downloaded the models folder must have room for the MISSING files plus {@link DISK_MARGIN_BYTES}, or the install
 * refuses with `no_disk` and a sentence that says how much is needed and how much is free. `onBytes` is called with
 * each chunk's size for the progress bar.
 */
export async function installFiles(
  http: HttpPort,
  files: EngineFilesPort,
  onBytes: (received: number) => void,
  catalog: readonly EngineFile[] = ENGINE_FILES,
): Promise<void> {
  const missing = await missingOf(files, catalog);
  for (const file of catalog) if (!missing.includes(file)) onBytes(file.bytes);
  if (missing.length === 0) return;
  await ensureRoom(files, missing);
  for (const file of missing) {
    const bytes = await download(http, file, onBytes);
    try {
      await files.write(file, bytes);
    } catch (error) {
      throw new VoiceEngineError('write_failed', `${file.label} could not be saved on this machine.`, { cause: error });
    }
  }
}
