/**
 * A software QR reader for browsers that have no `BarcodeDetector`.
 *
 * WHY THIS EXISTS. Chromium ships `BarcodeDetector`; WebKit does not, so an iPhone's Safari and its
 * installed home-screen app used to get NO in-app scanner at all — the scan button was disabled, the
 * camera was never asked for, and the permission prompt never appeared. That was not a permission bug
 * to fix with a different `getUserMedia` call; there was nothing to prompt FOR. This is the decoder
 * that gives that platform something to prompt for, handed to `QrScanEnvironment.detector` — the seam
 * `pair-scan.ts` kept for exactly this.
 *
 * LOADED ONLY WHEN NEEDED. `loadDecoder` is an `import()` the composition root supplies, so a
 * Chromium visitor, who has a native detector, never downloads these bytes; neither does anybody who
 * never taps Scan.
 *
 * NOTHING LEAVES THE TAB. A frame is drawn to an off-screen canvas, read as pixels and decoded in
 * place. No frame, and no decoded text, is stored or sent anywhere.
 */

import type { QrDetectorLike } from './pair-scan.ts';

/** The widest a frame is decoded at. Scanning a phone screen needs no more, and decode cost is per pixel. */
export const DECODE_FRAME_WIDTH = 640;

/** The video, narrowed to what framing needs. */
interface FrameSource {
  readonly videoWidth?: number;
  readonly videoHeight?: number;
}

/** The pixels `getImageData` hands back. */
interface FramePixels {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** A 2-D canvas context, as the two calls a frame grab needs. */
interface FrameContext {
  drawImage(source: unknown, dx: number, dy: number, width: number, height: number): void;
  getImageData(x: number, y: number, width: number, height: number): FramePixels;
}

/** An off-screen canvas. `getContext` is a method so a real `HTMLCanvasElement` satisfies it. */
export interface FrameCanvas {
  width: number;
  height: number;
  getContext(kind: '2d', options: { readonly willReadFrequently: boolean }): FrameContext | null;
}

/** The decoder: raw RGBA pixels in, the symbol's text out, or `null` for "no symbol in this frame". */
export type DecodePixels = (data: Uint8ClampedArray, width: number, height: number) => { readonly data: string } | null;

export interface FrameDetectorEnvironment {
  /** A fresh off-screen canvas. */
  readonly createCanvas: () => FrameCanvas;
  /** Resolves the decoder on first use — an `import()`, so the bytes arrive only when somebody scans. */
  readonly loadDecoder: () => Promise<DecodePixels>;
}

/**
 * A `QrDetectorLike` that reads frames from a playing video through a canvas.
 *
 * A frame the camera has not produced yet (`videoWidth` of 0 while the stream warms up) is an empty
 * answer, never an error: the scan loop treats "nothing yet" as the normal case.
 */
export const frameQrDetector = (environment: FrameDetectorEnvironment): QrDetectorLike => {
  const canvas = environment.createCanvas();
  let decoder: Promise<DecodePixels> | undefined;
  const ensureDecoder = async (): Promise<DecodePixels> => {
    decoder ??= environment.loadDecoder();
    try {
      return await decoder;
    } catch (reason) {
      // A failed download is retried by the next scan rather than remembered for the tab's life.
      decoder = undefined;
      throw reason;
    }
  };
  return {
    prepare: async () => {
      await ensureDecoder();
    },
    detect: async source => {
      const { videoWidth = 0, videoHeight = 0 } = source as FrameSource;
      if (videoWidth <= 0 || videoHeight <= 0) return [];
      const width = Math.min(videoWidth, DECODE_FRAME_WIDTH);
      const height = Math.max(1, Math.round((videoHeight * width) / videoWidth));
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) return [];
      context.drawImage(source, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      const decode = await ensureDecoder();
      const found = decode(pixels.data, pixels.width, pixels.height);
      return found === null ? [] : [{ rawValue: found.data }];
    },
  };
};
