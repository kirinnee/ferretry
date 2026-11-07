import { describe, expect, it } from 'bun:test';
import {
  TRANSCRIPT_IMAGE_DECODE_SLICE,
  loadTranscriptImageBlob,
  transcriptImageCacheId,
  transcriptImageErrorMessage,
  transcriptImageHandleOf,
} from '../../../../app/chat/transcript-image-source.ts';
import { DaemonCallError } from '@ferretry/app';
import { bytesToBase64 } from '../../../../app/composer/attachment-upload.ts';
import { fakeClient } from '../../../support/app/fake-client.ts';

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

const answer = (
  bytes: Uint8Array,
  overrides: { handle?: string; mediaType?: string; base64?: string } = {},
): unknown => ({
  image: {
    handle: overrides.handle ?? spelled,
    mediaType: overrides.mediaType ?? 'image/png',
    byteLength: bytes.byteLength,
  },
  base64: overrides.base64 ?? bytesToBase64(bytes),
});

const bytesOf = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

const IMAGE = 'GET /v1/ferrets/:ferretId/transcript-images/:handle';

/** A client whose image route answers `body`, or refuses with `status` as the daemon would. */
const reply = (body: unknown, status = 200) =>
  fakeClient({
    [IMAGE]: () => {
      if (status !== 200) throw new DaemonCallError(status, 'refused', `HTTP ${status}`);
      return body;
    },
  });

const rejection = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

describe('loading a transcript image', () => {
  it('reads from the owning daemon by the handle it named, and rebuilds a Blob typed by the daemon, not the transcript', async () => {
    const client = reply(answer(PNG, { mediaType: 'image/webp' }));
    const blob = await loadTranscriptImageBlob(client, 'shots/ferret', handle);
    expect(blob.type).toBe('image/webp');
    expect(await bytesOf(blob)).toEqual(PNG);
    expect(client.calls).toEqual([{ route: IMAGE, init: { params: { ferretId: 'shots/ferret', handle: spelled } } }]);
  });

  it('decodes a payload over 1 MiB byte for byte across several slices', async () => {
    const big = new Uint8Array(1_300_000);
    for (let index = 0; index < big.length; index += 1) big[index] = (index * 31 + (index >> 8)) & 0xff;
    const base64 = bytesToBase64(big);
    expect(base64.length).toBeGreaterThan(2 * TRANSCRIPT_IMAGE_DECODE_SLICE);
    const blob = await loadTranscriptImageBlob(reply(answer(big)), 's', handle);
    expect(blob.size).toBe(big.length);
    expect(await bytesOf(blob)).toEqual(big);
  });

  it('answers 502 when the body is not the download schema', async () => {
    const error = await rejection(() => loadTranscriptImageBlob(reply({ image: 'nope' }), 's', handle));
    expect(error).toBeInstanceOf(DaemonCallError);
    expect((error as DaemonCallError).status).toBe(502);
  });

  it('answers 502 when the body is not an object at all', async () => {
    const error = await rejection(() => loadTranscriptImageBlob(reply('<html>'), 's', handle));
    expect((error as DaemonCallError).status).toBe(502);
  });

  it('refuses an answer that names a different image than the one asked for', async () => {
    const error = await rejection(() => loadTranscriptImageBlob(reply(answer(PNG, { handle: '1.2.0' })), 's', handle));
    expect((error as DaemonCallError).status).toBe(502);
  });

  it('refuses base64 whose length is not whole quanta', async () => {
    const error = await rejection(() => loadTranscriptImageBlob(reply(answer(PNG, { base64: 'AAAAA' })), 's', handle));
    expect((error as DaemonCallError).status).toBe(502);
  });

  it('refuses base64 with characters outside the alphabet', async () => {
    const error = await rejection(() => loadTranscriptImageBlob(reply(answer(PNG, { base64: '!!!!' })), 's', handle));
    expect((error as DaemonCallError).status).toBe(502);
  });

  it('surfaces a 404 and a 415 with their status', async () => {
    const gone = await rejection(() => loadTranscriptImageBlob(reply(null, 404), 's', handle));
    expect(gone).toBeInstanceOf(DaemonCallError);
    expect((gone as DaemonCallError).status).toBe(404);
    const unsupported = await rejection(() => loadTranscriptImageBlob(reply(null, 415), 's', handle));
    expect((unsupported as DaemonCallError).status).toBe(415);
  });

  it('stops when the signal aborts between slices', async () => {
    const big = new Uint8Array(900_000).fill(7);
    const controller = new AbortController();
    const first = loadTranscriptImageBlob(reply(answer(big)), 's', handle, controller.signal);
    controller.abort();
    const error = await rejection(() => first);
    expect((error as Error).name).toBe('AbortError');
  });

  it('stops before the request when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = reply(answer(PNG));
    const error = await rejection(() => loadTranscriptImageBlob(client, 's', handle, controller.signal));
    expect((error as Error).name).toBe('AbortError');
    expect(client.calls).toEqual([]);
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
    expect(transcriptImageErrorMessage(new DaemonCallError(404, 'refused', '/secret/path'))).toBe(
      'no longer in the transcript',
    );
    expect(transcriptImageErrorMessage(new DaemonCallError(415, 'refused', 'x'))).toBe('not a supported image');
    expect(transcriptImageErrorMessage(new DaemonCallError(500, 'refused', 'x'))).toBe('could not be loaded');
    expect(transcriptImageErrorMessage(new Error('network'))).toBe('could not be loaded');
    expect(transcriptImageErrorMessage(undefined)).toBe('could not be loaded');
    expect(transcriptImageErrorMessage('boom')).toBe('could not be loaded');
  });
});
