import { describe, expect, it } from 'bun:test';
import {
  TRANSCRIPT_IMAGE_DECODE_SLICE,
  loadTranscriptImageBlob,
  transcriptImageCacheId,
  transcriptImageErrorMessage,
  transcriptImageHandleOf,
} from '../../src/lib/transcript-image-source.ts';
import { bytesToBase64 } from '../../src/lib/attachment-upload.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';

const daemon = daemonConnection({
  daemonId: 'shots-daemon',
  baseUrl: 'https://shots.example.test',
  deviceId: 'shots-token',
});

const handle = { recordOffset: 4096, recordLength: 3_145_728, ordinal: 0 };
const spelled = '4096.3145728.0';

const PNG = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...Array.from({ length: 256 }, (_, i) => i),
]);

const answer = (bytes: Uint8Array, overrides: { handle?: string; mediaType?: string; base64?: string } = {}): string =>
  JSON.stringify({
    image: {
      handle: overrides.handle ?? spelled,
      mediaType: overrides.mediaType ?? 'image/png',
      byteLength: bytes.byteLength,
    },
    base64: overrides.base64 ?? bytesToBase64(bytes),
  });

const bytesOf = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

const reply =
  (body: string, status = 200) =>
  async (): Promise<Response> =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } });

const rejection = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

describe('loading a transcript image', () => {
  it('reads from the owning daemon and rebuilds a Blob typed by the daemon, not the transcript', async () => {
    const seen: string[] = [];
    const blob = await loadTranscriptImageBlob(daemon, 'shots/session', handle, undefined, async (url, init) => {
      seen.push(String(url));
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(answer(PNG, { mediaType: 'image/webp' }));
    });
    expect(blob.type).toBe('image/webp');
    expect(await bytesOf(blob)).toEqual(PNG);
    expect(seen).toEqual([`https://shots.example.test/v1/sessions/shots%2Fsession/transcript-images/${spelled}`]);
  });

  it('decodes a payload over 1 MiB byte for byte across several slices', async () => {
    const big = new Uint8Array(1_300_000);
    for (let index = 0; index < big.length; index += 1) big[index] = (index * 31 + (index >> 8)) & 0xff;
    const base64 = bytesToBase64(big);
    expect(base64.length).toBeGreaterThan(2 * TRANSCRIPT_IMAGE_DECODE_SLICE);
    const blob = await loadTranscriptImageBlob(daemon, 's', handle, undefined, reply(answer(big)));
    expect(blob.size).toBe(big.length);
    expect(await bytesOf(blob)).toEqual(big);
  });

  it('answers 502 when the body is not the download schema', async () => {
    const error = await rejection(() =>
      loadTranscriptImageBlob(daemon, 's', handle, undefined, reply(JSON.stringify({ image: 'nope' }))),
    );
    expect(error).toBeInstanceOf(DaemonResponseError);
    expect((error as DaemonResponseError).status).toBe(502);
  });

  it('answers 502 when the body is not JSON at all', async () => {
    const error = await rejection(() => loadTranscriptImageBlob(daemon, 's', handle, undefined, reply('<html>')));
    expect((error as DaemonResponseError).status).toBe(502);
  });

  it('refuses an answer that names a different image than the one asked for', async () => {
    const error = await rejection(() =>
      loadTranscriptImageBlob(daemon, 's', handle, undefined, reply(answer(PNG, { handle: '1.2.0' }))),
    );
    expect((error as DaemonResponseError).status).toBe(502);
  });

  it('refuses base64 whose length is not whole quanta', async () => {
    const error = await rejection(() =>
      loadTranscriptImageBlob(daemon, 's', handle, undefined, reply(answer(PNG, { base64: 'AAAAA' }))),
    );
    expect((error as DaemonResponseError).status).toBe(502);
  });

  it('refuses base64 with characters outside the alphabet', async () => {
    const error = await rejection(() =>
      loadTranscriptImageBlob(daemon, 's', handle, undefined, reply(answer(PNG, { base64: '!!!!' }))),
    );
    expect((error as DaemonResponseError).status).toBe(502);
  });

  it('surfaces a 404 and a 415 with their status, and reads a non-JSON failure as plain HTTP', async () => {
    const gone = await rejection(() =>
      loadTranscriptImageBlob(daemon, 's', handle, undefined, reply(JSON.stringify({ error: 'gone', code: 'x' }), 404)),
    );
    expect(gone).toBeInstanceOf(DaemonResponseError);
    expect((gone as DaemonResponseError).status).toBe(404);
    const unsupported = await rejection(() =>
      loadTranscriptImageBlob(daemon, 's', handle, undefined, reply('not json', 415)),
    );
    expect((unsupported as DaemonResponseError).status).toBe(415);
    expect((unsupported as DaemonResponseError).message).toBe('HTTP 415');
  });

  it('stops when the signal aborts between slices', async () => {
    const big = new Uint8Array(900_000).fill(7);
    const controller = new AbortController();
    const first = loadTranscriptImageBlob(daemon, 's', handle, controller.signal, reply(answer(big)));
    controller.abort();
    const error = await rejection(() => first);
    expect((error as Error).name).toBe('AbortError');
  });

  it('stops before the request when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(() =>
      loadTranscriptImageBlob(daemon, 's', handle, controller.signal, async (_url, init) => {
        init?.signal?.throwIfAborted();
        return new Response(answer(PNG));
      }),
    );
    expect((error as Error).name).toBe('AbortError');
  });
});

describe('transcript image cache ids', () => {
  it('round-trips a handle and never matches a stored attachment id', () => {
    const id = transcriptImageCacheId(spelled);
    expect(transcriptImageHandleOf(id)).toEqual(handle);
    expect(transcriptImageHandleOf('att-1')).toBeUndefined();
    expect(transcriptImageHandleOf('transcript-image:not-a-handle')).toBeUndefined();
  });
});

describe('transcript image error copy', () => {
  it('names the reason without echoing the daemon', () => {
    expect(transcriptImageErrorMessage(new DaemonResponseError(404, '/secret/path'))).toBe(
      'no longer in the transcript',
    );
    expect(transcriptImageErrorMessage(new DaemonResponseError(415, 'x'))).toBe('not a supported image');
    expect(transcriptImageErrorMessage(new DaemonResponseError(500, 'x'))).toBe('could not be loaded');
    expect(transcriptImageErrorMessage(new Error('network'))).toBe('could not be loaded');
    expect(transcriptImageErrorMessage(undefined)).toBe('could not be loaded');
    expect(transcriptImageErrorMessage('boom')).toBe('could not be loaded');
  });
});
