import { STT_BITS_PER_SAMPLE, STT_CHANNELS, STT_MAX_PCM_BYTES, STT_SAMPLE_RATE } from '@ferretry/protocol';

/** The two audio encodings the daemon accepts, and the content type each is sent as. */
export const WAV_CONTENT_TYPE = 'audio/wav';
export const PCM_CONTENT_TYPE = `audio/L16; rate=${STT_SAMPLE_RATE}; channels=${STT_CHANNELS}`;

/**
 * A WAV container carries a header the raw sample budget does not, so a file at exactly the sample
 * limit is still legal. The daemon allows the same slack; refusing it here would reject audio the
 * daemon would have accepted.
 */
export const WAV_CONTAINER_OVERHEAD_LIMIT = 4_096;

/** How the bytes on disk are encoded, decided by extension and confirmed by the daemon. */
export type SttAudioEncoding = 'wav' | 'pcm';

const WAV_EXTENSIONS = new Set(['wav', 'wave']);
const PCM_EXTENSIONS = new Set(['pcm', 'raw', 'l16']);

/** The extension of a path, lowercased, or nothing when the name carries none. */
function extensionOf(path: string): string | undefined {
  const name = path.split(/[/\\]/u).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? undefined : name.slice(dot + 1).toLowerCase();
}

/**
 * Which encoding a file holds.
 *
 * The extension decides, and an unknown one is refused rather than guessed at: kteam's browser
 * client sent whatever it had and let the daemon fail with `bad_audio` after the whole body had
 * already crossed the wire.
 */
export function encodingOf(path: string): SttAudioEncoding {
  const extension = extensionOf(path);
  if (extension !== undefined && WAV_EXTENSIONS.has(extension)) return 'wav';
  if (extension !== undefined && PCM_EXTENSIONS.has(extension)) return 'pcm';
  throw new Error(
    `cannot tell how "${path}" is encoded — use a .wav file, or raw 16-bit ${STT_SAMPLE_RATE} Hz mono named .pcm`,
  );
}

/** The content type the daemon expects for an encoding. */
export function contentTypeFor(encoding: SttAudioEncoding): string {
  return encoding === 'wav' ? WAV_CONTENT_TYPE : PCM_CONTENT_TYPE;
}

/** The largest body the daemon will read for an encoding. */
export function byteLimitFor(encoding: SttAudioEncoding): number {
  return encoding === 'wav' ? STT_MAX_PCM_BYTES + WAV_CONTAINER_OVERHEAD_LIMIT : STT_MAX_PCM_BYTES;
}

/** Seconds of audio a raw PCM payload of this many bytes holds. */
export function pcmSeconds(bytes: number): number {
  return bytes / (STT_SAMPLE_RATE * STT_CHANNELS * (STT_BITS_PER_SAMPLE / 8));
}

/**
 * Refuses audio the daemon would reject, before it is uploaded.
 *
 * Reporting the length locally turns a 413 with no detail into a message naming how long the clip is
 * and how long it may be.
 */
export function assertWithinLimits(path: string, encoding: SttAudioEncoding, bytes: number): void {
  if (bytes === 0) throw new Error(`"${path}" is empty`);
  const limit = byteLimitFor(encoding);
  if (bytes > limit) {
    const seconds = Math.round(pcmSeconds(bytes));
    const allowed = Math.round(pcmSeconds(STT_MAX_PCM_BYTES));
    throw new Error(`"${path}" holds about ${seconds}s of audio; the daemon transcribes at most ${allowed}s`);
  }
}
