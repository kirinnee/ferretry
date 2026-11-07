import { describe, expect, it } from 'bun:test';
import { loadAttachmentBlob } from '../../../../app/composer/attachment-source.ts';
import { bytesToBase64 } from '../../../../app/composer/attachment-upload.ts';
import { DaemonCallError, daemonConnection, daemonFerretScope } from '../../../../app/composer/seam.ts';
import { fakeClient, refusal } from './fake-client.ts';

const daemon = daemonConnection('files-daemon');
const scope = daemonFerretScope(daemon, 'files/ferret');

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
const download = (bytes: Uint8Array, mime = 'image/png') => ({
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
  it('reads from the daemon that owns the ferret and rebuilds a typed blob', async () => {
    const { client, calls } = fakeClient(() => download(PNG));
    const blob = await loadAttachmentBlob(client, scope, 'a 1');
    expect(blob.type).toBe('image/png');
    expect(await bytesOf(blob)).toEqual(Array.from(PNG));
    expect(calls.map(call => [call.route, call.params])).toEqual([
      ['GET /v1/ferrets/:ferretId/attachments/:attachmentId', { ferretId: 'files/ferret', attachmentId: 'a 1' }],
    ]);
  });

  it('takes the type from the attachment, not from anything else', async () => {
    const { client } = fakeClient(() => download(PNG, 'image/jpeg; charset=binary'));
    expect((await loadAttachmentBlob(client, scope, 'a1')).type).toBe('image/jpeg');
  });

  it('refuses an answer that is not a download', async () => {
    await expect(loadAttachmentBlob(fakeClient(() => 'bytes').client, scope, 'a1')).rejects.toThrow('no attachment');
    await expect(
      loadAttachmentBlob(fakeClient(() => ({ ...download(PNG), base64: '***' })).client, scope, 'a1'),
    ).rejects.toThrow('unreadable bytes');
  });

  it('passes a shaped daemon refusal on', async () => {
    const { client } = fakeClient(() => {
      throw refusal(410, 'gone', 'attachment expired');
    });
    const shaped = loadAttachmentBlob(client, scope, 'a1');
    await expect(shaped).rejects.toBeInstanceOf(DaemonCallError);
    await expect(shaped).rejects.toThrow('attachment expired');
  });
});
