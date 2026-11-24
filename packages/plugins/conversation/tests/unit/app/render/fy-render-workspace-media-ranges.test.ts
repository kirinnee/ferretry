/**
 * A media-folder file larger than the JSON read's mebibyte, read in ranges from the streamed route
 * (`GET /v1/ferrets/:ferretId/fs/media`, docs/fy-render.md rule 11). The client is a fake that serves what the daemon
 * serves (a `206` piece, clamped to what it was asked), so nothing here touches a network.
 */
import { DaemonCallError } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { describe, test } from 'bun:test';
import should from 'should';
import { MAX_MEDIA_BYTES, MEDIA_CHUNK_BYTES } from '@ferretry/core-ferrets/contract';
import { readWorkspaceMedia } from '../../../../app/render/fy-render-workspace-media.ts';

const MIB = 1024 * 1024;
const FILE = 'GET /v1/ferrets/:ferretId/fs/file';
const MEDIA = 'GET /v1/ferrets/:ferretId/fs/media';

interface Call {
  readonly route: string;
  readonly params: Readonly<Record<string, string>> | undefined;
  readonly query: Readonly<Record<string, string>> | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;
}

const patterned = (size: number): Uint8Array => Uint8Array.from({ length: size }, (_unused, at) => at % 251);

interface Served {
  /** What `fs/file` answers for the name. */
  readonly view: Record<string, unknown>;
  /** What each `fs/media` call answers (a piece, or a failure to throw); the default serves `bytes` as asked. */
  readonly piece?: (call: Call, index: number) => unknown;
  readonly bytes?: Uint8Array;
  /** The most one answer carries, like the daemon's clamp. */
  readonly clamp?: number;
}

const serving = (served: Served) => {
  const calls: Call[] = [];
  const client = {
    call: async (
      route: string,
      init?: { params?: Record<string, string>; query?: Record<string, string>; headers?: Record<string, string> },
    ) => {
      const call = { headers: init?.headers, params: init?.params, query: init?.query, route };
      calls.push(call);
      if (route === FILE) return served.view;
      const index = calls.filter(made => made.route === MEDIA).length - 1;
      if (served.piece !== undefined) return served.piece(call, index);
      const match = /^bytes=(\d+)-(\d+)$/u.exec(call.headers?.range ?? '');
      if (match === null || served.bytes === undefined) throw new Error('no range asked');
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), start + (served.clamp ?? Number.MAX_SAFE_INTEGER) - 1);
      return served.bytes.slice(start, end + 1);
    },
  } as unknown as PluginClient;
  return { calls, client };
};

const readMedia = async (client: PluginClient, name = 'clip.mp4', signal = new AbortController().signal) =>
  await readWorkspaceMedia(client, 'ferret-1', name, '/repo', signal, 'media');

describe('a media file over the JSON read, in ranges', () => {
  test('should read a three-megabyte clip as one range of exactly its size and hand over every byte', async () => {
    // Arrange
    const clip = patterned(3 * MIB + 123);
    const { calls, client } = serving({
      bytes: clip,
      view: { path: 'clip.mp4', size: clip.byteLength, tooLarge: true },
    });

    // Act
    const actual = await readMedia(client);

    // Assert
    should(actual.ok).be.true();
    if (!actual.ok) return;
    should(Buffer.compare(Buffer.from(actual.bytes), Buffer.from(clip))).equal(0);
    const media = calls.filter(call => call.route === MEDIA);
    should(media).deepEqual([
      {
        headers: { range: `bytes=0-${clip.byteLength - 1}` },
        params: { ferretId: 'ferret-1' },
        query: { name: 'clip.mp4' },
        route: MEDIA,
      },
    ]);
  });

  test('should ask the JSON route first for the media scope, so the gates and the size come from the one read', async () => {
    // Arrange
    const clip = patterned(2 * MIB);
    const { calls, client } = serving({
      bytes: clip,
      view: { path: 'clip.mp4', size: clip.byteLength, tooLarge: true },
    });

    // Act
    await readMedia(client);

    // Assert
    should(calls[0]).deepEqual({
      headers: undefined,
      params: { ferretId: 'ferret-1' },
      query: { format: 'base64', path: 'clip.mp4', scope: 'media' },
      route: FILE,
    });
  });

  test('should ask in pieces of at most four mebibytes for a larger file and join them in order', async () => {
    // Arrange
    const song = patterned(10 * MIB + 7);
    const { calls, client } = serving({
      bytes: song,
      view: { path: 'song.mp3', size: song.byteLength, tooLarge: true },
    });

    // Act
    const actual = await readMedia(client, 'song.mp3');

    // Assert
    should(actual.ok).be.true();
    if (!actual.ok) return;
    should(Buffer.compare(Buffer.from(actual.bytes), Buffer.from(song))).equal(0);
    should(calls.filter(call => call.route === MEDIA).map(call => call.headers?.range)).deepEqual([
      `bytes=0-${4 * MIB - 1}`,
      `bytes=${4 * MIB}-${8 * MIB - 1}`,
      `bytes=${8 * MIB}-${song.byteLength - 1}`,
    ]);
    should(MEDIA_CHUNK_BYTES).equal(4 * MIB);
  });

  test('should go on from where the bytes stop when the daemon answers with less than was asked', async () => {
    // Arrange
    const clip = patterned(3 * MIB);
    const { calls, client } = serving({
      bytes: clip,
      clamp: MIB,
      view: { path: 'clip.mp4', size: clip.byteLength, tooLarge: true },
    });

    // Act
    const actual = await readMedia(client);

    // Assert
    should(actual.ok).be.true();
    if (!actual.ok) return;
    should(Buffer.compare(Buffer.from(actual.bytes), Buffer.from(clip))).equal(0);
    should(calls.filter(call => call.route === MEDIA)).have.length(3);
  });

  test('should read nothing from the streamed route for a file the JSON read served whole', async () => {
    // Arrange
    const { calls, client } = serving({ view: { base64: 'AAEC', path: 'a.png', size: 3 } });

    // Act
    const actual = await readMedia(client, 'a.png');

    // Assert
    should(actual).deepEqual({ bytes: new Uint8Array([0, 1, 2]), ok: true });
    should(calls.filter(call => call.route === MEDIA)).have.length(0);
  });

  test('should keep the mebibyte for a working-tree file: no streamed read, the same row as before', async () => {
    // Arrange
    const { calls, client } = serving({ view: { path: 'rec.mp4', size: 3 * MIB, tooLarge: true } });

    // Act
    const actual = await readWorkspaceMedia(client, 'ferret-1', 'rec.mp4', '/repo', new AbortController().signal);

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'too-large' });
    should(calls.filter(call => call.route === MEDIA)).have.length(0);
  });

  test('should answer too-large without a streamed read for a media file over its own cap', async () => {
    // Arrange
    const { calls, client } = serving({
      view: { path: 'big.mp4', size: MAX_MEDIA_BYTES + 1, tooLarge: true },
    });

    // Act
    const actual = await readMedia(client, 'big.mp4');

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'too-large' });
    should(calls.filter(call => call.route === MEDIA)).have.length(0);
  });

  test('should answer too-large when the JSON read gives no size to read by', async () => {
    // Arrange
    const { client } = serving({ view: { path: 'big.mp4', tooLarge: true } });

    // Act
    const actual = await readMedia(client, 'big.mp4');

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'too-large' });
  });
});

describe('a streamed read that goes wrong', () => {
  const view = { path: 'clip.mp4', size: 2 * MIB, tooLarge: true };

  test.each([
    ['an empty piece', () => new Uint8Array(0)],
    ['a piece that is not bytes', () => '{"error":"x"}'],
    ['a piece that runs past the size', () => new Uint8Array(2 * MIB + 1)],
  ])('should answer unavailable rather than show a short or damaged file: %s', async (_name, piece) => {
    // Arrange
    const { client } = serving({ piece, view });

    // Act
    const actual = await readMedia(client);

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'unavailable' });
  });

  test.each([
    [403, 'holds_secret', { ok: false, reason: 'not-served', rule: 'it holds a private value' }],
    [403, 'denied', { ok: false, reason: 'not-served', rule: 'the protected-secrets list refuses this name' }],
    [403, 'forbidden', { ok: false, reason: 'denied' }],
    [404, 'not_found', { ok: false, reason: 'missing' }],
    [413, 'too_large', { ok: false, reason: 'too-large' }],
    [416, 'range_not_satisfiable', { ok: false, reason: 'unavailable' }],
    [415, 'unsupported_type', { ok: false, reason: 'unavailable' }],
    [500, 'boom', { ok: false, reason: 'unavailable' }],
  ])('should turn the daemon refusing a piece with %d %s into the row for it', async (status, code, expected) => {
    // Arrange
    const { client } = serving({
      piece: () => {
        throw new DaemonCallError(status, code, 'refused');
      },
      view,
    });

    // Act
    const actual = await readMedia(client);

    // Assert
    should(actual).deepEqual(expected);
  });

  test('should rethrow the caller leaving, not turn it into a refusal', async () => {
    // Arrange
    const controller = new AbortController();
    const { client } = serving({
      piece: () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      },
      view,
    });

    // Act
    const reading = readMedia(client, 'clip.mp4', controller.signal);

    // Assert
    await should(reading).be.rejectedWith({ name: 'AbortError' });
  });
});
