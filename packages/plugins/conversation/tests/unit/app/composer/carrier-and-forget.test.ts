import { describe, expect, it, spyOn } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import half from '../../../../app/index.ts';
import { DaemonAttachmentBlobCache } from '../../../../app/composer/attachment-blob-cache.ts';
import { documentDraftStore, documentRestoreStore } from '../../../../app/composer/drafts.ts';
import { carrierDelivery } from '../../../../app/composer/seam.ts';

describe('S12 a send that died on the carrier', () => {
  const outage = new DaemonCallError(0, 'carrier_outage', 'the session closed', undefined, true);

  it('reads "checking whether it arrived" — the client cannot prove the request never left', () => {
    expect(carrierDelivery(outage)).toBe('unknown');
    expect(carrierDelivery(new Error('wrapped', { cause: outage }))).toBe('unknown');
  });

  it('a delivery mark found down the chain still wins', () => {
    expect(carrierDelivery(Object.assign(new Error('x'), { delivery: 'unsent' }))).toBe('unsent');
  });

  it('a daemon’s refusal, or anything else, is not an outage', () => {
    expect(carrierDelivery(new DaemonCallError(409, 'conflict', 'no'))).toBeUndefined();
    expect(carrierDelivery(new Error('plain'))).toBeUndefined();
    expect(carrierDelivery('text')).toBeUndefined();
  });
});

describe('S12 unpairing a machine clears its unsent words', () => {
  it('clears both the drafts and the words waiting to be restored, for that machine only', () => {
    const drafts = spyOn(documentDraftStore, 'clearDaemon').mockImplementation(() => {});
    const restores = spyOn(documentRestoreStore, 'clearDaemon').mockImplementation(() => {});
    try {
      (half.shell as { forget: (daemon: string) => void }).forget('d1');
      expect(drafts.mock.calls).toEqual([['d1']]);
      expect(restores.mock.calls).toEqual([['d1']]);
    } finally {
      drafts.mockRestore();
      restores.mockRestore();
    }
  });

  it('m5 drops the cached attachment images of that machine, in every open cache, and no other machine’s', async () => {
    const revoked: string[] = [];
    const urls = { create: (blob: Blob) => `blob:${blob.size}`, revoke: (url: string) => void revoked.push(url) };
    const first = new DaemonAttachmentBlobCache(urls);
    const second = new DaemonAttachmentBlobCache(urls);
    const gone = new DaemonAttachmentBlobCache(urls);
    gone.dispose();
    const scope = (daemonId: string, attachmentId: string) => ({
      daemonId: daemonId as never,
      ferretId: 'f1' as never,
      attachmentId,
    });
    await first.acquire(scope('d1', 'a'), async () => new Blob(['1']));
    await second.acquire(scope('d1', 'b'), async () => new Blob(['22']));
    await second.acquire(scope('d2', 'c'), async () => new Blob(['333']));
    (half.shell as { forget: (daemon: string) => void }).forget('d1');
    // The two d1 images are revoked (sizes 1 and 2); d2's (size 3) and a disposed cache are untouched.
    expect(revoked.sort()).toEqual(['blob:1', 'blob:2']);
    first.dispose();
    second.dispose();
  });
});
