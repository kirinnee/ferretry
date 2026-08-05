/**
 * Camera pairing: the QR scan behind a port.
 *
 * THE ONE INVARIANT THAT MATTERS, and the reason dictation hands its microphone
 * to the browser: a camera that outlives the scan lights the device's
 * recording indicator with nothing the reader can do about it. Every exit from
 * `scan` — a decode, an abort, a rejection — runs the same release, and the
 * release is idempotent.
 *
 * WHY A PORT. `BarcodeDetector` and `getUserMedia` are browser globals no test
 * can construct, and the interesting rules are not in either of them: they are
 * "a frame that will not decode is not a failure", "an aborted scan releases
 * the device", and "a refusal is a sentence a reader can act on". Those live
 * here and are executed by tests with no camera. `browserQrScanHost` is the one
 * function that touches the real APIs, and even it takes them as an argument.
 *
 * THE CODE IS NEVER READ HERE. A decoded QR is raw text handed straight back to
 * the caller, which parses it with `pairingSeedFromUrl`. This module has no
 * opinion about pairing and never holds a single-use code.
 *
 * NO SOFTWARE DECODER, DELIBERATELY. `BarcodeDetector` is Chromium-only, so
 * WebKit gets no in-app scanner. That is not the blocked path it looks like:
 * the design's carrier is a QR scanned with the phone's OWN camera app, which
 * opens this PWA already pre-filled on every platform, and the in-app scanner
 * only serves someone who opened the app first. Those readers get the paste
 * field instead of a bundled decoder that every visitor would have to download.
 * If that trade ever changes, `QrScanEnvironment.detector` is the seam: hand it
 * a decoder built over a canvas grab and nothing else here moves.
 */

/** Why a scan ended without a code, as a closed vocabulary. */
export type ScanErrorCode =
  | 'no-camera-api'
  | 'no-decoder'
  | 'permission-denied'
  | 'no-camera'
  | 'camera-busy'
  | 'cancelled'
  | 'scan-failed';

export class ScanError extends Error {
  readonly code: ScanErrorCode;

  constructor(code: ScanErrorCode, message: string) {
    super(message);
    this.name = 'ScanError';
    this.code = code;
  }
}

/**
 * Map the DOMException names `getUserMedia` throws onto something the UI can
 * say out loud. The NAMES are the stable part of that contract; the messages
 * are not, so the messages are ours.
 */
export const scanErrorFrom = (error: unknown): ScanError => {
  if (error instanceof ScanError) return error;
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new ScanError('permission-denied', 'Camera access was blocked for this site.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new ScanError('no-camera', 'No camera was found on this device.');
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new ScanError('camera-busy', 'The camera is in use by something else.');
  }
  const message = error instanceof Error ? error.message : 'The camera could not be started.';
  return new ScanError('scan-failed', message);
};

/**
 * The surface a scan aims through.
 *
 * `show` returns the thing the decoder reads, so the element that displays the
 * stream and the element frames are decoded from can never drift apart.
 */
export interface QrPreview {
  /** Attach the live camera stream; returns the source the decoder should read. */
  show(stream: unknown): unknown;
  /** Detach the stream. The host stops the tracks itself. */
  clear(): void;
}

/** One camera scan, owned by whoever can talk to the browser. */
export interface QrScanHost {
  /** False when this browser cannot scan at all, so the UI never offers it. */
  readonly supported: boolean;
  /**
   * Open the camera into `preview` and resolve the first decoded text.
   * Rejects with a `ScanError`; releases the camera on every exit.
   */
  scan(preview: QrPreview, signal: AbortSignal): Promise<string>;
}

/** A decoded symbol, narrowed to the only field this module reads. */
interface DetectedCode {
  readonly rawValue?: unknown;
}

/** `BarcodeDetector`, as the two members a scan needs. */
export interface QrDetectorLike {
  detect(source: unknown): Promise<readonly DetectedCode[]>;
}

interface MediaTrackLike {
  stop?: () => void;
}

interface MediaStreamLike {
  getTracks?: () => readonly MediaTrackLike[];
}

/**
 * `navigator.mediaDevices`, as the one member a scan needs.
 *
 * A METHOD signature rather than a property holding an arrow: the DOM's own
 * `getUserMedia` takes `MediaStreamConstraints`, and only a method position is
 * lax enough about its parameter for the real one to satisfy this port.
 */
export interface QrMediaLike {
  getUserMedia?(constraints: unknown): Promise<MediaStreamLike>;
}

export interface QrScanEnvironment {
  /** `navigator.mediaDevices`, absent rather than restricted in an insecure context. */
  readonly media?: QrMediaLike | undefined;
  /** Builds a QR decoder, or `undefined` where the browser has none. */
  readonly detector?: (() => QrDetectorLike) | undefined;
  /** Waits between decode attempts. Injected so a test never waits. */
  readonly delay: (milliseconds: number) => Promise<void>;
}

/**
 * How long to wait between decode attempts.
 *
 * A tight loop pins a phone's CPU and drains the battery for no gain: hand-held
 * aim does not change meaningfully inside 100 ms, and `detect` itself takes
 * tens of milliseconds on a mid-range Android.
 */
export const SCAN_FRAME_INTERVAL_MS = 120;

/** The rear camera is the one pointed at someone else's screen. */
const SCAN_CONSTRAINTS = { video: { facingMode: 'environment' } } as const;

const stopTracks = (stream: MediaStreamLike): void => {
  for (const track of stream.getTracks?.() ?? []) track.stop?.();
};

const decodedText = (codes: readonly DetectedCode[]): string | undefined => {
  for (const code of codes) {
    if (typeof code.rawValue === 'string' && code.rawValue !== '') return code.rawValue;
  }
  return undefined;
};

/**
 * The one implementation that touches real browser capture.
 *
 * Both capabilities are checked before the camera is opened, so a browser
 * without a decoder never lights the camera indicator to discover that it
 * cannot use what it sees.
 */
export const browserQrScanHost = (environment: QrScanEnvironment): QrScanHost => {
  const getUserMedia = environment.media?.getUserMedia;
  const detector = environment.detector;
  return {
    supported: typeof getUserMedia === 'function' && detector !== undefined,
    scan: async (preview, signal) => {
      if (typeof getUserMedia !== 'function') {
        throw new ScanError('no-camera-api', 'This browser cannot open a camera here.');
      }
      if (detector === undefined) {
        throw new ScanError('no-decoder', 'This browser cannot read a QR code.');
      }
      if (signal.aborted) throw new ScanError('cancelled', 'The scan was stopped.');

      let stream: MediaStreamLike;
      try {
        stream = await getUserMedia.call(environment.media, SCAN_CONSTRAINTS);
      } catch (reason) {
        throw scanErrorFrom(reason);
      }

      try {
        const source = preview.show(stream);
        const engine = detector();
        while (!signal.aborted) {
          // A frame that will not decode is the NORMAL case — the reader is
          // still aiming — so a rejected or empty detect keeps the loop alive.
          // Only an abort ends it, which is what makes the stop control honest.
          const found = await engine.detect(source).catch(() => []);
          const text = decodedText(found);
          if (text !== undefined) return text;
          await environment.delay(SCAN_FRAME_INTERVAL_MS);
        }
        throw new ScanError('cancelled', 'The scan was stopped.');
      } finally {
        preview.clear();
        stopTracks(stream);
      }
    },
  };
};
