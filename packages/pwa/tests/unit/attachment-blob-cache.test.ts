import { describe, it } from 'bun:test';
import should from 'should';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  DaemonAttachmentBlobCache,
  daemonAttachmentKey,
  daemonAttachmentScope,
  type AttachmentBlobUrlPort,
} from '../../src/lib/attachment-blob-cache.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });
const attachmentA = daemonAttachmentScope(daemonSessionScope(daemonA, 'same/session'), 'same-attachment');
const attachmentB = daemonAttachmentScope(daemonSessionScope(daemonB, 'same/session'), 'same-attachment');

class ObjectUrls implements AttachmentBlobUrlPort {
  readonly created: Blob[] = [];
  readonly revoked: string[] = [];

  create(blob: Blob): string {
    this.created.push(blob);
    return `blob:${this.created.length}`;
  }

  revoke(url: string): void {
    this.revoked.push(url);
  }
}

const deferred = (): { readonly promise: Promise<Blob>; resolve(value: Blob): void } => {
  let resolve!: (value: Blob) => void;
  const promise = new Promise<Blob>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('daemon attachment blob cache', () => {
  it('should make the daemon part of every attachment key and query', async () => {
    const urls = new ObjectUrls();
    const cache = new DaemonAttachmentBlobCache(urls);
    let loads = 0;

    const [first, duplicate, otherDaemon] = await Promise.all([
      cache.acquire(attachmentA, async () => {
        loads += 1;
        return new Blob(['a']);
      }),
      cache.acquire(attachmentA, async () => {
        loads += 1;
        return new Blob(['duplicate']);
      }),
      cache.acquire(attachmentB, async () => {
        loads += 1;
        return new Blob(['b']);
      }),
    ]);

    should(first).equal(duplicate);
    should(first).equal('blob:1');
    should(otherDaemon).equal('blob:2');
    should(loads).equal(2);
    should(daemonAttachmentKey(attachmentA)).not.equal(daemonAttachmentKey(attachmentB));
  });

  it('should evict only released LRU entries and revoke their URL', async () => {
    const urls = new ObjectUrls();
    const cache = new DaemonAttachmentBlobCache(urls, 1);
    const second = daemonAttachmentScope(daemonSessionScope(daemonA, 'second-session'), 'second-attachment');

    await cache.acquire(attachmentA, async () => new Blob(['first']));
    cache.release(attachmentA);
    await cache.acquire(second, async () => new Blob(['second']));

    should(urls.revoked).deepEqual(['blob:1']);
    cache.release(second);
    cache.dispose();
    should(urls.revoked).deepEqual(['blob:1', 'blob:2']);
  });

  it('should clear only its daemon and fence a late object URL after unpairing', async () => {
    const urls = new ObjectUrls();
    const cache = new DaemonAttachmentBlobCache(urls);
    const slow = deferred();
    const stale = cache.acquire(attachmentA, async () => slow.promise);
    const live = await cache.acquire(attachmentB, async () => new Blob(['b']));

    cache.clearDaemon(daemonA.daemonId);
    slow.resolve(new Blob(['a']));

    await should(stale).be.rejectedWith('attachment request is no longer needed');
    should(live).equal('blob:1');
    should(urls.revoked).deepEqual(['blob:2']);
    cache.clearDaemon(daemonB.daemonId);
    should(urls.revoked).deepEqual(['blob:2', 'blob:1']);
  });

  it('should reject missing attachment ids and non-positive capacity', () => {
    should(() => daemonAttachmentScope(daemonSessionScope(daemonA, 'session'), ' ')).throw(
      'attachmentId must not be empty',
    );
    should(() => new DaemonAttachmentBlobCache(new ObjectUrls(), 0)).throw(
      'attachment cache capacity must be a positive integer',
    );
  });
});
