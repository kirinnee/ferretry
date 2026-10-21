import { describe, expect, it } from 'bun:test';

import {
  DECODE_FRAME_WIDTH,
  type DecodePixels,
  type FrameCanvas,
  frameQrDetector,
} from '../../src/lib/qr-frame-decoder.ts';

interface Drawn {
  readonly width: number;
  readonly height: number;
}

const pixels = { data: new Uint8ClampedArray(4), width: 2, height: 3 };

const fakeCanvas = (context: 'none' | 'ok' = 'ok') => {
  const drawn: Drawn[] = [];
  const canvas: FrameCanvas = {
    width: 0,
    height: 0,
    getContext: () =>
      context === 'none'
        ? null
        : {
            drawImage: (_source, _x, _y, width, height) => {
              drawn.push({ width, height });
            },
            getImageData: () => pixels,
          },
  };
  return { canvas, drawn };
};

describe('frameQrDetector', () => {
  it('answers an empty list while the camera has produced no frame yet', async () => {
    const { canvas } = fakeCanvas();
    let loads = 0;
    const detector = frameQrDetector({
      createCanvas: () => canvas,
      loadDecoder: async () => {
        loads += 1;
        return () => null;
      },
    });

    expect(await detector.detect({})).toEqual([]);
    expect(await detector.detect({ videoWidth: 0, videoHeight: 480 })).toEqual([]);
    expect(await detector.detect({ videoWidth: 640, videoHeight: 0 })).toEqual([]);
    expect(loads).toBe(0);
  });

  it('answers an empty list when a 2-D context cannot be had', async () => {
    const { canvas } = fakeCanvas('none');
    const detector = frameQrDetector({ createCanvas: () => canvas, loadDecoder: async () => () => null });

    expect(await detector.detect({ videoWidth: 640, videoHeight: 480 })).toEqual([]);
  });

  it('scales a wide frame down to the decode width and hands the pixels to the decoder', async () => {
    const { canvas, drawn } = fakeCanvas();
    const seen: unknown[] = [];
    const decode: DecodePixels = (data, width, height) => {
      seen.push([data, width, height]);
      return { data: 'the code' };
    };
    const detector = frameQrDetector({ createCanvas: () => canvas, loadDecoder: async () => decode });

    expect(await detector.detect({ videoWidth: 1920, videoHeight: 1080 })).toEqual([{ rawValue: 'the code' }]);
    expect(drawn).toEqual([{ width: DECODE_FRAME_WIDTH, height: 360 }]);
    expect(canvas.width).toBe(DECODE_FRAME_WIDTH);
    expect(seen).toEqual([[pixels.data, 2, 3]]);
  });

  it('keeps a small frame at its own size, and answers an empty list when no symbol is found', async () => {
    const { canvas, drawn } = fakeCanvas();
    const detector = frameQrDetector({ createCanvas: () => canvas, loadDecoder: async () => () => null });

    expect(await detector.detect({ videoWidth: 320, videoHeight: 240 })).toEqual([]);
    expect(drawn).toEqual([{ width: 320, height: 240 }]);
  });

  it('loads the decoder once, however many frames and prepares there are', async () => {
    const { canvas } = fakeCanvas();
    let loads = 0;
    const detector = frameQrDetector({
      createCanvas: () => canvas,
      loadDecoder: async () => {
        loads += 1;
        return () => null;
      },
    });

    await detector.prepare?.();
    await detector.detect({ videoWidth: 320, videoHeight: 240 });
    await detector.detect({ videoWidth: 320, videoHeight: 240 });
    expect(loads).toBe(1);
  });

  it('forgets a failed download so the next scan tries again', async () => {
    const { canvas } = fakeCanvas();
    let loads = 0;
    const detector = frameQrDetector({
      createCanvas: () => canvas,
      loadDecoder: async () => {
        loads += 1;
        if (loads === 1) throw new Error('offline');
        return () => ({ data: 'back online' });
      },
    });

    await expect(detector.prepare?.()).rejects.toThrow('offline');
    await detector.prepare?.();
    expect(await detector.detect({ videoWidth: 320, videoHeight: 240 })).toEqual([{ rawValue: 'back online' }]);
    expect(loads).toBe(2);
  });
});
