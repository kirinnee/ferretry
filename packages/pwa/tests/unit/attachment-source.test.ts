import { describe, expect, it } from 'bun:test';
import { loadAttachmentBlob } from '../../src/lib/attachment-source.ts';
import { bytesToBase64 } from '../../src/lib/attachment-upload.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { relayResponse } from '../../src/lib/relay-carrier.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';

const daemon = daemonConnection({
  daemonId: 'files-daemon',
  baseUrl: 'https://files.example.test',
  deviceId: 'files-token',
});
const scope = daemonSessionScope(daemon, 'files/session');

const other = daemonConnection({
  daemonId: 'other-daemon',
  baseUrl: 'https://other.example.test',
  deviceId: 'other-token',
});

/** A PNG signature and then every byte value, so any UTF-8 round trip is visible. */
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

/** The daemon's own answer: `{ attachment, base64 }`, never raw bytes. */
const download = (bytes: Uint8Array, mime = 'image/png'): string =>
  JSON.stringify({
    attachment: {
      id: 'a1',
      filename: 'shot.png',
      mime,
      size: bytes.byteLength,
      sha256: 'a'.repeat(64),
      createdAt: '2026-10-22T00:00:00.000Z',
    },
    base64: bytesToBase64(bytes),
  });

const bytesOf = async (blob: Blob): Promise<number[]> => Array.from(new Uint8Array(await blob.arrayBuffer()));

describe('loading an attachment blob', () => {
  it('reads from the daemon that owns the session and rebuilds a typed blob', async () => {
    const seen: string[] = [];
    const blob = await loadAttachmentBlob(daemon, scope, 'a 1', undefined, async (url, init) => {
      seen.push(String(url));
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(download(PNG), { headers: { 'content-type': 'application/json' } });
    });
    expect(blob.type).toBe('image/png');
    expect(await bytesOf(blob)).toEqual(Array.from(PNG));
    expect(seen).toEqual(['https://files.example.test/v1/sessions/files%2Fsession/attachments/a%201']);
  });

  it('takes the type from the attachment, not from the response header', async () => {
    const blob = await loadAttachmentBlob(
      daemon,
      scope,
      'a1',
      undefined,
      async () =>
        new Response(download(PNG, 'image/jpeg; charset=binary'), { headers: { 'content-type': 'text/plain' } }),
    );
    expect(blob.type).toBe('image/jpeg');
  });

  it('survives a NON-direct carrier whose answer is text (relay / tunnel)', async () => {
    // The relay's `res` record carries a STRING body. The daemon's JSON answer is text, so it crosses
    // unchanged; raw bytes could not (the lossy UTF-8 step below is what a binary body would suffer).
    const viaTunnel = async (): Promise<Response> => {
      const wire = new TextDecoder().decode(new TextEncoder().encode(download(PNG)));
      return relayResponse({
        kind: 'response',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: wire,
      });
    };
    const blob = await loadAttachmentBlob(daemon, scope, 'a1', undefined, viaTunnel);
    expect(blob.type).toBe('image/png');
    expect(await bytesOf(blob)).toEqual(Array.from(PNG));

    const lossy = new TextDecoder().decode(PNG);
    expect(Array.from(new TextEncoder().encode(lossy))).not.toEqual(Array.from(PNG));
  });

  it('refuses an answer that is not a download', async () => {
    await expect(
      loadAttachmentBlob(daemon, scope, 'a1', undefined, async () => new Response('bytes', { status: 200 })),
    ).rejects.toThrow('no attachment');
    await expect(
      loadAttachmentBlob(
        daemon,
        scope,
        'a1',
        undefined,
        async () => new Response(JSON.stringify({ ...JSON.parse(download(PNG)), base64: '***' }), { status: 200 }),
      ),
    ).rejects.toThrow('unreadable bytes');
  });

  it('uses the browser’s own fetch when no transport is injected', async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(download(PNG));
    }) as unknown as typeof fetch;
    try {
      expect((await loadAttachmentBlob(daemon, scope, 'a1')).size).toBe(PNG.byteLength);
      expect(seen).toEqual(['https://files.example.test/v1/sessions/files%2Fsession/attachments/a1']);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('refuses a scope belonging to another daemon', async () => {
    await expect(loadAttachmentBlob(other, scope, 'a1', undefined, async () => new Response(''))).rejects.toThrow(
      'attachment scope must belong to the requested daemon',
    );
  });

  it('surfaces a shaped daemon error and falls back to the status line', async () => {
    const shaped = loadAttachmentBlob(
      daemon,
      scope,
      'a1',
      undefined,
      async () =>
        new Response(JSON.stringify({ error: 'attachment expired', code: 'gone' }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(shaped).rejects.toBeInstanceOf(DaemonResponseError);
    await expect(shaped).rejects.toThrow('attachment expired');

    await expect(
      loadAttachmentBlob(daemon, scope, 'a1', undefined, async () => new Response('nope', { status: 500 })),
    ).rejects.toThrow('HTTP 500');
  });
});
