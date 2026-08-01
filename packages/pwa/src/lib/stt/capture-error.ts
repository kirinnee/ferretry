/**
 * What the microphone can refuse, as a closed vocabulary.
 *
 * Split out of kteam `ui/src/lib/stt/audio-capture.ts:168-202` so the utterance
 * lifecycle can classify a failure without importing the module that opens a
 * device. The DOMException NAMES are the stable part of the `getUserMedia`
 * contract; the messages are not, so the messages are ours.
 */

export type CaptureErrorCode =
  | 'no-media-devices'
  | 'permission-denied'
  | 'no-microphone'
  | 'audio-unavailable'
  | 'capture-failed';

export class CaptureError extends Error {
  readonly code: CaptureErrorCode;

  constructor(code: CaptureErrorCode, message: string) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
  }
}

/** Map the DOMException names `getUserMedia` throws onto something the UI can say out loud. */
export const captureErrorFrom = (error: unknown): CaptureError => {
  if (error instanceof CaptureError) return error;
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CaptureError('permission-denied', 'Microphone access was blocked for this site.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new CaptureError('no-microphone', 'No microphone was found on this device.');
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new CaptureError('audio-unavailable', 'The microphone is in use by something else.');
  }
  const message = error instanceof Error ? error.message : 'Recording could not start.';
  return new CaptureError('capture-failed', message);
};
