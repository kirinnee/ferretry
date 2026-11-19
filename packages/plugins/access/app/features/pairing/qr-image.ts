/**
 * Reading a pairing QR from a picture the person already has (a screenshot, a photo, a saved image).
 *
 * THE THIRD WAY IN, beside the camera and the pasted link. Where the browser has no `BarcodeDetector` (WebKit) the
 * same software decoder reads camera frames, so this is also the decoder's one production loader.
 *
 * WHAT HAPPENS TO THE PICTURE. It is drawn into an off-screen canvas, read as pixels, decoded and let go, all in this
 * tab. It is never uploaded, never stored, never logged and never put in React state. The object URL that lets the
 * browser open it is revoked in a `finally`, so every exit (a decode, a refusal, a corrupt file) releases it.
 *
 * WHAT HAPPENS TO THE TEXT. It is handed straight back to the caller, which treats it exactly like a pasted link: parsed
 * on use, never rendered. A single-use code lives in no sentence this module can say, including its refusals, which name
 * the picture's problem and never its content.
 */

import type { DecodePixels, FrameCanvas } from '../../lib/qr-frame-decoder.ts';

/** The longest side a picture is decoded at: bounds memory for a 48-megapixel photo, and is far more than a QR needs. */
export const MAX_IMAGE_SIDE = 1600;

/** Why a picture produced no link. */
export type QrImageErrorCode = 'no-qr' | 'unreadable';

export class QrImageError extends Error {
  readonly code: QrImageErrorCode;

  constructor(code: QrImageErrorCode, message: string) {
    super(message);
    this.name = 'QrImageError';
    this.code = code;
  }
}

/** The sentence for a picture with no QR code in it (also the one a test pins). */
export const NO_QR_IN_IMAGE = 'No QR code found in that image.';

/** The sentence for a file the browser could not open as a picture. */
const UNREADABLE_IMAGE = 'That file could not be opened as an image.';

/** What a loaded picture offers: its size, and itself as a drawable. */
export interface LoadedImage {
  readonly width: number;
  readonly height: number;
  readonly source: unknown;
}

/** The browser objects a picture read touches, so a test can hand fakes in. */
export interface QrImageEnvironment {
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  /** Opens the URL as a decoded picture; rejects for a file that is not one. */
  readonly loadImage: (url: string) => Promise<LoadedImage>;
  readonly createCanvas: () => FrameCanvas;
  /** The software decoder, fetched when the first picture is read. */
  readonly loadDecoder: () => Promise<DecodePixels>;
}

/** The picture's pixels, fitted inside {@link MAX_IMAGE_SIDE}. The object URL is revoked before this returns or throws. */
const pixelsOf = async (file: Blob, environment: QrImageEnvironment) => {
  const url = environment.createObjectURL(file);
  try {
    let loaded: LoadedImage;
    try {
      loaded = await environment.loadImage(url);
    } catch {
      throw new QrImageError('unreadable', UNREADABLE_IMAGE);
    }
    if (loaded.width <= 0 || loaded.height <= 0) throw new QrImageError('unreadable', UNREADABLE_IMAGE);
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(loaded.width, loaded.height));
    const width = Math.max(1, Math.round(loaded.width * scale));
    const height = Math.max(1, Math.round(loaded.height * scale));
    const canvas = environment.createCanvas();
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new QrImageError('unreadable', UNREADABLE_IMAGE);
    context.drawImage(loaded.source, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } finally {
    environment.revokeObjectURL(url);
  }
};

/**
 * The raw text of the first QR code in `file`. Rejects with a {@link QrImageError} whose message is safe to show.
 */
export const readQrImage = async (file: Blob, environment: QrImageEnvironment): Promise<string> => {
  const pixels = await pixelsOf(file, environment);
  let decode: DecodePixels;
  try {
    decode = await environment.loadDecoder();
  } catch {
    throw new QrImageError('unreadable', 'The QR reader could not be loaded. Check your connection and try again.');
  }
  const found = decode(pixels.data, pixels.width, pixels.height);
  if (found === null || found.data === '') throw new QrImageError('no-qr', NO_QR_IN_IMAGE);
  return found.data;
};

/**
 * The software QR decoder (`jsqr`), fetched on first use so a Chromium visitor who only ever scans with the camera, or
 * pastes, never downloads it. This is the loader `pair-page.tsx` hands the camera as well.
 */
export const loadSoftwareDecoder = async (): Promise<DecodePixels> => {
  const { default: jsQR } = await import('jsqr');
  return (data, width, height) => jsQR(data, width, height);
};

/** The page's own objects. Only called in a browser, on a person's action. */
const browserQrImageEnvironment = (): QrImageEnvironment => ({
  createObjectURL: blob => URL.createObjectURL(blob),
  revokeObjectURL: url => URL.revokeObjectURL(url),
  loadImage: async url =>
    await new Promise<LoadedImage>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight, source: image });
      image.onerror = () => reject(new Error('image'));
      image.src = url;
    }),
  createCanvas: () => document.createElement('canvas'),
  loadDecoder: loadSoftwareDecoder,
});

/** Read one picture with the page's own objects. */
export const readQrImageInBrowser = async (file: Blob): Promise<string> =>
  await readQrImage(file, browserQrImageEnvironment());
