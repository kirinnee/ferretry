import { describe, expect, it } from 'bun:test';

import {
  browserQrScanHost,
  type QrDetectorLike,
  type QrPreview,
  type QrScanEnvironment,
  ScanError,
  scanErrorFrom,
  SCAN_FRAME_INTERVAL_MS,
} from '../../src/lib/pair-scan.ts';

interface FakeTrack {
  stopped: boolean;
}

const fakeStream = (tracks: FakeTrack[]) => ({
  getTracks: () => tracks.map(track => ({ stop: () => (track.stopped = true) })),
});

interface Recorder {
  readonly shown: unknown[];
  cleared: number;
  readonly preview: QrPreview;
}

const recordingPreview = (source: unknown = 'video-element'): Recorder => {
  const recorder: Recorder = {
    shown: [],
    cleared: 0,
    preview: {
      show: stream => {
        recorder.shown.push(stream);
        return source;
      },
      clear: () => {
        recorder.cleared += 1;
      },
    },
  };
  return recorder;
};

const named = (name: string): Error => Object.assign(new Error(name), { name });

const environment = (overrides: Partial<QrScanEnvironment> = {}): QrScanEnvironment => ({
  media: { getUserMedia: async () => fakeStream([]) },
  detector: () => ({ detect: async () => [{ rawValue: 'scanned' }] }),
  delay: async () => {},
  ...overrides,
});

describe('scanErrorFrom', () => {
  it('passes a ScanError through rather than re-wrapping its code', () => {
    const original = new ScanError('cancelled', 'stopped');
    expect(scanErrorFrom(original)).toBe(original);
  });

  it('maps every getUserMedia refusal name onto a sentence a reader can act on', () => {
    expect(scanErrorFrom(named('NotAllowedError')).code).toBe('permission-denied');
    expect(scanErrorFrom(named('SecurityError')).code).toBe('permission-denied');
    expect(scanErrorFrom(named('NotFoundError')).code).toBe('no-camera');
    expect(scanErrorFrom(named('OverconstrainedError')).code).toBe('no-camera');
    expect(scanErrorFrom(named('NotReadableError')).code).toBe('camera-busy');
    expect(scanErrorFrom(named('AbortError')).code).toBe('camera-busy');
    expect(scanErrorFrom(named('NotAllowedError')).message).toBe('Camera access was blocked for this site.');
  });

  it('keeps an unrecognised error message, and invents one for a non-error', () => {
    expect(scanErrorFrom(new Error('the lens is covered')).message).toBe('the lens is covered');
    expect(scanErrorFrom(null).code).toBe('scan-failed');
    expect(scanErrorFrom('nope').message).toBe('The camera could not be started.');
  });
});

describe('browserQrScanHost support', () => {
  it('is unsupported without a camera API, without a decoder, and supported with both', () => {
    expect(browserQrScanHost(environment({ media: undefined })).supported).toBe(false);
    expect(browserQrScanHost(environment({ media: {} })).supported).toBe(false);
    expect(browserQrScanHost(environment({ detector: undefined })).supported).toBe(false);
    expect(browserQrScanHost(environment()).supported).toBe(true);
  });

  it('refuses both missing capabilities before it ever opens the camera', async () => {
    const recorder = recordingPreview();
    const noCamera = browserQrScanHost(environment({ media: undefined }));
    await expect(noCamera.scan(recorder.preview, new AbortController().signal)).rejects.toThrow(
      'This browser cannot open a camera here.',
    );

    let opened = 0;
    const noDecoder = browserQrScanHost(
      environment({
        detector: undefined,
        media: {
          getUserMedia: async () => {
            opened += 1;
            return fakeStream([]);
          },
        },
      }),
    );
    await expect(noDecoder.scan(recorder.preview, new AbortController().signal)).rejects.toThrow(
      'This browser cannot read a QR code.',
    );
    expect(opened).toBe(0);
    expect(recorder.shown).toEqual([]);
  });
});

describe('browserQrScanHost scan', () => {
  it('resolves the first decoded value, releasing the camera and the preview', async () => {
    const tracks = [{ stopped: false }, { stopped: false }];
    const stream = fakeStream(tracks);
    const recorder = recordingPreview();
    const host = browserQrScanHost(
      environment({
        media: { getUserMedia: async () => stream },
        detector: () => ({ detect: async () => [{ rawValue: 'https://app.test/pair#v1;…' }] }),
      }),
    );

    await expect(host.scan(recorder.preview, new AbortController().signal)).resolves.toBe('https://app.test/pair#v1;…');
    expect(recorder.shown).toEqual([stream]);
    expect(recorder.cleared).toBe(1);
    expect(tracks.every(track => track.stopped)).toBe(true);
  });

  it('asks the rear camera for video, and reads frames from what the preview returned', async () => {
    const constraints: unknown[] = [];
    const sources: unknown[] = [];
    const host = browserQrScanHost(
      environment({
        media: {
          getUserMedia: async asked => {
            constraints.push(asked);
            return fakeStream([]);
          },
        },
        detector: () => ({
          detect: async source => {
            sources.push(source);
            return [{ rawValue: 'code' }];
          },
        }),
      }),
    );

    await host.scan(recordingPreview('the-video').preview, new AbortController().signal);
    expect(constraints).toEqual([{ video: { facingMode: 'environment' } }]);
    expect(sources).toEqual(['the-video']);
  });

  it('keeps aiming through empty frames, unreadable values and a rejected decode', async () => {
    const waits: number[] = [];
    const frames: Array<Promise<readonly { readonly rawValue?: unknown }[]>> = [
      Promise.resolve([]),
      Promise.reject(new Error('frame decode blew up')),
      Promise.resolve([{ rawValue: 42 }, { rawValue: '' }]),
      Promise.resolve([{ rawValue: 'the code' }]),
    ];
    const detector = (): QrDetectorLike => ({ detect: async () => await (frames.shift() ?? Promise.resolve([])) });
    const host = browserQrScanHost(
      environment({
        detector,
        delay: async milliseconds => {
          waits.push(milliseconds);
        },
      }),
    );

    await expect(host.scan(recordingPreview().preview, new AbortController().signal)).resolves.toBe('the code');
    expect(waits).toEqual([SCAN_FRAME_INTERVAL_MS, SCAN_FRAME_INTERVAL_MS, SCAN_FRAME_INTERVAL_MS]);
  });

  it('refuses a scan that was already aborted, without touching the camera', async () => {
    let opened = 0;
    const controller = new AbortController();
    controller.abort();
    const host = browserQrScanHost(
      environment({
        media: {
          getUserMedia: async () => {
            opened += 1;
            return fakeStream([]);
          },
        },
      }),
    );

    await expect(host.scan(recordingPreview().preview, controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(opened).toBe(0);
  });

  it('ends an in-flight scan on abort and still releases the device', async () => {
    const tracks = [{ stopped: false }];
    const controller = new AbortController();
    const recorder = recordingPreview();
    const host = browserQrScanHost(
      environment({
        media: { getUserMedia: async () => fakeStream(tracks) },
        detector: () => ({ detect: async () => [] }),
        delay: async () => controller.abort(),
      }),
    );

    await expect(host.scan(recorder.preview, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(recorder.cleared).toBe(1);
    expect(tracks[0]?.stopped).toBe(true);
  });

  it('reports a refused camera as its mapped refusal', async () => {
    const host = browserQrScanHost(
      environment({
        media: {
          getUserMedia: async () => {
            throw named('NotAllowedError');
          },
        },
      }),
    );

    await expect(host.scan(recordingPreview().preview, new AbortController().signal)).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('survives a stream that reports no tracks to stop', async () => {
    const host = browserQrScanHost(environment({ media: { getUserMedia: async () => ({}) } }));
    await expect(host.scan(recordingPreview().preview, new AbortController().signal)).resolves.toBe('scanned');
  });
});
