import { describe, expect, it } from 'bun:test';
import { localQr } from '@ferretry/app';

import {
  MAX_IMAGE_SIDE,
  NO_QR_IN_IMAGE,
  QrImageError,
  type QrImageEnvironment,
  loadSoftwareDecoder,
  readQrImage,
} from '../../../app/features/pairing/qr-image.ts';
import { frameQrDetector } from '../../../app/lib/qr-frame-decoder.ts';

/** A fixed FAKE link: the shape of a pairing link with a made-up code, never a real one. */
const FAKE_LINK = 'https://pwa.example.test/pair#v1;url=https%3A%2F%2Fdaemon.example.test;code=FAKE-0000;fp=fy_fake';

/** The symbol as a picture: dark modules black on white with the four-module quiet zone, `scale` pixels per module. */
const pictureOf = (text: string, scale = 8) => {
  const matrix = localQr(text);
  const span = matrix.size + 8;
  const side = span * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.modules[y]?.[x] !== true) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const at = (((y + 4) * scale + dy) * side + (x + 4) * scale + dx) * 4;
          data[at] = 0;
          data[at + 1] = 0;
          data[at + 2] = 0;
        }
      }
    }
  }
  return { data, width: side, height: side };
};

const blankPicture = (side = 200) => ({
  data: new Uint8ClampedArray(side * side * 4).fill(255),
  width: side,
  height: side,
});

interface Log {
  readonly created: string[];
  readonly revoked: string[];
  readonly canvases: { width: number; height: number }[];
}

/** A page whose one picture is `picture`, or that cannot open it at all. */
const environmentFor = (
  picture: { data: Uint8ClampedArray; width: number; height: number } | 'unopenable',
  sourceSize?: { width: number; height: number },
): { environment: QrImageEnvironment; log: Log } => {
  const log: Log = { created: [], revoked: [], canvases: [] };
  const environment: QrImageEnvironment = {
    createObjectURL: () => {
      const url = `blob:fake-${String(log.created.length)}`;
      log.created.push(url);
      return url;
    },
    revokeObjectURL: url => {
      log.revoked.push(url);
    },
    loadImage: async () => {
      if (picture === 'unopenable') throw new Error('not an image');
      return { ...(sourceSize ?? { width: picture.width, height: picture.height }), source: 'picture' };
    },
    createCanvas: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => {
            log.canvases.push({ width: canvas.width, height: canvas.height });
          },
          getImageData: () => (picture === 'unopenable' ? blankPicture() : picture),
        }),
      };
      return canvas;
    },
    loadDecoder: loadSoftwareDecoder,
  };
  return { environment, log };
};

const file = new Blob(['not read by the fakes'], { type: 'image/png' });

describe('readQrImage', () => {
  it('decodes a fixed fake QR picture to the fake link, and revokes the object URL', async () => {
    const { environment, log } = environmentFor(pictureOf(FAKE_LINK));

    const text = await readQrImage(file, environment);

    expect(text).toBe(FAKE_LINK);
    expect(log.created).toEqual(['blob:fake-0']);
    expect(log.revoked).toEqual(log.created);
  });

  it('says "No QR code found in that image" for a picture with no code, and still revokes', async () => {
    const { environment, log } = environmentFor(blankPicture());

    const failure = await readQrImage(file, environment).catch((reason: unknown) => reason);

    expect(failure).toBeInstanceOf(QrImageError);
    expect((failure as QrImageError).code).toBe('no-qr');
    expect((failure as QrImageError).message).toBe(NO_QR_IN_IMAGE);
    expect(NO_QR_IN_IMAGE).toBe('No QR code found in that image.');
    expect(log.revoked).toEqual(log.created);
  });

  it('refuses a file the browser cannot open, without leaking the URL', async () => {
    const { environment, log } = environmentFor('unopenable');

    const failure = await readQrImage(file, environment).catch((reason: unknown) => reason);

    expect((failure as QrImageError).code).toBe('unreadable');
    expect(log.created).toHaveLength(1);
    expect(log.revoked).toEqual(log.created);
  });

  it('never decodes at more than the size cap, however large the picture', async () => {
    const { environment, log } = environmentFor(pictureOf(FAKE_LINK), { width: 8000, height: 4000 });

    await readQrImage(file, environment);

    expect(log.canvases).toEqual([{ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE / 2 }]);
  });

  it('says nothing of the link in a refusal', async () => {
    const { environment } = environmentFor(blankPicture());

    const failure = (await readQrImage(file, environment).catch((reason: unknown) => reason)) as Error;

    expect(failure.message).not.toContain('code=');
    expect(failure.message).not.toContain('FAKE');
  });
});

describe('the WebKit camera path', () => {
  it('decodes a camera frame with jsqr when the browser has no BarcodeDetector', async () => {
    const frame = pictureOf(FAKE_LINK);
    const detector = frameQrDetector({
      createCanvas: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {}, getImageData: () => frame }),
      }),
      loadDecoder: loadSoftwareDecoder,
    });

    await detector.prepare?.();
    const found = await detector.detect({ videoWidth: frame.width, videoHeight: frame.height });

    expect(found).toEqual([{ rawValue: FAKE_LINK }]);
  });
});
