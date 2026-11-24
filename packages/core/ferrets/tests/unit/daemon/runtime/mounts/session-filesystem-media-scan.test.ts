import { describe, it } from 'bun:test';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import { type ApiResponse, type Redaction } from '@ferretry/kernel/contract';
import should from 'should';
import {
  type FileBrowserDeps,
  sessionFilesystemRoutes,
} from '../../../../../daemon/lib/runtime/mounts/session-filesystem.ts';
import { MediaScanCache } from '../../../../../daemon/lib/runtime/mounts/media-scan-cache.ts';
import { SessionFilesystem } from '../../../../../daemon/lib/session/filesystem/index.ts';
import { MEDIA_CHUNK_BYTES } from '../../../../../contract/media-bytes.ts';
import { refusalOf } from '../../support/calls.ts';
import { requestOf } from '../../support/requests.ts';
import { FakeRootPinner, FakeSessionGit, treeOf, type FakeNode } from '../../session/filesystem/support.ts';

/**
 * `fs/media` scans a file for vault values ONCE and keeps the verdict, instead of reading and scanning every byte for
 * every 4 MiB piece it serves. What is proved here is the memory and its limits: the file and the vault are both part of
 * what a verdict is about, a file whose scan has not finished is never served from, and the refusal still holds per range.
 */

const MEDIA = 'GET /v1/ferrets/:ferretId/fs/media';
const SECRET = 'sk-live-not-for-chat-0123456789';

const person: FileBrowserDeps['reach'] = async context => ({
  id: context.params.get('ferretId') ?? '',
  cwd: '/work/ferretry',
});

/** `size` bytes whose value at position `n` is `n % 251`, so a wrong slice cannot look right. */
const patterned = (size: number): Uint8Array => Uint8Array.from({ length: size }, (_unused, at) => at % 251);
const file = (bytes: Uint8Array, overrides: Partial<FakeNode> = {}): FakeNode => ({
  bytes,
  type: 'file',
  ...overrides,
});
const bytesOf = (response: ApiResponse): Uint8Array => response.bytes ?? new Uint8Array();

/** The 9 MiB clip every test below serves in pieces: three 4 MiB pieces, the last one short. */
const CLIP = patterned(2 * MEDIA_CHUNK_BYTES + MEDIA_CHUNK_BYTES / 4);

function fixture(
  node: FakeNode,
  options: { readonly secrets?: Map<never, string>; readonly redaction?: Pick<Redaction, 'read'> } = {},
) {
  const tree = treeOf(['clip.mp4', node]);
  const media = new FakeRootPinner({ tree });
  const secrets = options.secrets ?? new Map<never, string>();
  const redaction = options.redaction ?? new FakeRedaction(secrets);
  const routes = sessionFilesystemRoutes({
    filesystem: new SessionFilesystem(new FakeRootPinner({ tree: treeOf() }), new FakeSessionGit({})),
    media: () => new SessionFilesystem(media, new FakeSessionGit({ isTracked: () => true })),
    reach: person,
    redaction,
  });
  const ask = async (range?: string): Promise<ApiResponse> =>
    await routes[MEDIA](
      requestOf({
        params: { ferretId: 's1' },
        query: { name: 'clip.mp4' },
        ...(range === undefined ? {} : { headers: { range } }),
      }),
    );
  /** Every read the media folder's files served: how many bytes each handed back and whether a span was asked for. */
  const reads = () => media.roots.flatMap(root => root.targets.flatMap(target => target.reads));
  /** The reads that took the whole file: what a scan costs. */
  const scans = () => reads().filter(read => read.window === undefined);
  return { ask, media, reads, scans, secrets, tree };
}

describe('the media scan: a file is scanned once, not once per piece', () => {
  it('should scan eight ranges of one clip once, and read only the range for the other seven', async () => {
    // Arrange
    const { ask, reads, scans } = fixture(file(CLIP));
    const ranges = [
      'bytes=0-1023',
      `bytes=${MEDIA_CHUNK_BYTES}-${MEDIA_CHUNK_BYTES + 99}`,
      `bytes=${2 * MEDIA_CHUNK_BYTES}-`,
      'bytes=5-9',
      `bytes=${MEDIA_CHUNK_BYTES - 1}-${MEDIA_CHUNK_BYTES}`,
      'bytes=0-',
      'bytes=-100',
      `bytes=${CLIP.byteLength - 1}-${CLIP.byteLength - 1}`,
    ];

    // Act
    const answers: ApiResponse[] = [];
    for (const range of ranges) answers.push(await ask(range));

    // Assert
    should(scans().length).eql(1);
    should(scans()[0]?.bytes).eql(CLIP.byteLength);
    should(reads().length).eql(8);
    should(
      reads()
        .filter(read => read.window !== undefined)
        .every(read => read.bytes <= MEDIA_CHUNK_BYTES),
    ).be.true();
    should(answers.map(answer => answer.status)).eql([206, 206, 206, 206, 206, 206, 206, 206]);
    should(bytesOf(answers[0] as ApiResponse)).eql(CLIP.subarray(0, 1024));
    should(bytesOf(answers[2] as ApiResponse)).eql(CLIP.subarray(2 * MEDIA_CHUNK_BYTES));
    should(bytesOf(answers[4] as ApiResponse)).eql(CLIP.subarray(MEDIA_CHUNK_BYTES - 1, MEDIA_CHUNK_BYTES + 1));
    should(bytesOf(answers[6] as ApiResponse)).eql(CLIP.subarray(CLIP.byteLength - 100));
    should(answers[1]?.headers.get('content-range')).eql(
      `bytes ${MEDIA_CHUNK_BYTES}-${MEDIA_CHUNK_BYTES + 99}/${CLIP.byteLength}`,
    );
  });

  it('should answer a range past the end and a file too large for one answer from the verdict, with no new scan', async () => {
    // Arrange
    const { ask, scans } = fixture(file(CLIP));
    await ask('bytes=0-9');

    // Act
    const past = await ask(`bytes=${CLIP.byteLength}-`);
    const whole = await refusalOf(ask());

    // Assert
    should(past.status).eql(416);
    should(past.headers.get('content-range')).eql(`bytes */${CLIP.byteLength}`);
    should(whole).eql({ code: 'range_required', status: 413 });
    should(scans().length).eql(1);
  });

  it('should share one scan between requests that arrive together for a file nobody has judged', async () => {
    // Arrange
    const { ask, scans } = fixture(file(CLIP));

    // Act
    const answers = await Promise.all([
      ask('bytes=0-99'),
      ask(`bytes=${MEDIA_CHUNK_BYTES}-${MEDIA_CHUNK_BYTES + 99}`),
      ask('bytes=-50'),
      ask('bytes=7-8'),
    ]);

    // Assert
    should(scans().length).eql(1);
    should(answers.map(answer => answer.status)).eql([206, 206, 206, 206]);
    should(bytesOf(answers[3] as ApiResponse)).eql(CLIP.subarray(7, 9));
  });
});

describe('the media scan: a small file asked for whole', () => {
  it('should be answered whole from the verdict the second time, opening the vault once and not scanning again', async () => {
    // Arrange
    const small = patterned(2_000);
    const redaction = new FakeRedaction(new Map());
    const { ask } = fixture(file(small), { redaction });
    const first = await ask();
    const opensAfterFirst = redaction.opens;

    // Act
    const second = await ask();

    // Assert
    should(bytesOf(first)).eql(small);
    should(bytesOf(second)).eql(small);
    should(second.status).eql(200);
    should(opensAfterFirst).eql(2); // which vault, then the scan
    should(redaction.opens - opensAfterFirst).eql(1); // which vault only: the verdict answers the rest
  });
});

describe('the media scan: a request that meets a scan in flight', () => {
  it('should wait for it, serve from its verdict, and never read the whole file itself', async () => {
    // Arrange: the leader's scan (the vault's second open) is held until the follower has reached the file
    const inner = new FakeRedaction(new Map());
    let opens = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const gated: Pick<Redaction, 'read'> = {
      read: async fn => {
        opens += 1;
        if (opens === 2) await held;
        return await inner.read(fn);
      },
    };
    const { ask, scans } = fixture(file(CLIP), { redaction: gated });
    const settle = async (until: () => boolean): Promise<void> => {
      while (!until()) await new Promise<void>(resolve => setImmediate(resolve));
    };

    // Act
    const leader = ask('bytes=0-9');
    await settle(() => opens === 2); // the leader owes the scan and is inside it
    const follower = ask('bytes=100-109');
    await settle(() => opens === 3); // the follower has asked which vault it is under, and now waits
    const reads = scans().length;
    release();
    const [first, second] = await Promise.all([leader, follower]);

    // Assert
    should(reads).eql(1); // nothing but the leader had read the file when the follower arrived
    should(scans().length).eql(1);
    should(bytesOf(first)).eql(CLIP.subarray(0, 10));
    should(bytesOf(second)).eql(CLIP.subarray(100, 110));
  });
});

describe('the media scan: what makes a verdict stale', () => {
  it('should scan again when the vault changes, and refuse a file that holds a value stored since', async () => {
    // Arrange
    const withSecret = new Uint8Array([...patterned(500), ...new TextEncoder().encode(SECRET), ...patterned(500)]);
    const { ask, scans, secrets } = fixture(file(withSecret));
    const first = await ask('bytes=0-9');

    // Act: the same file, the same bytes, a vault that has gained the value it holds
    secrets.set('API_KEY' as never, SECRET);
    const refused = await refusalOf(ask('bytes=0-9'));

    // Assert
    should(first.status).eql(206);
    should(refused).eql({ code: 'holds_secret', status: 403 });
    should(scans().length).eql(2);
  });

  it('should scan again for a vault change that does not touch the file, then keep the new verdict', async () => {
    // Arrange
    const { ask, scans, secrets } = fixture(file(CLIP));
    await ask('bytes=0-9');
    await ask('bytes=10-19');
    should(scans().length).eql(1);

    // Act
    secrets.set('OTHER' as never, 'a-value-the-clip-does-not-hold');
    await ask('bytes=20-29');
    await ask('bytes=30-39');

    // Assert
    should(scans().length).eql(2);
  });

  it('should let a refused file go again once the value is removed from the vault', async () => {
    // Arrange
    const withSecret = new Uint8Array([...patterned(500), ...new TextEncoder().encode(SECRET)]);
    const { ask, secrets } = fixture(file(withSecret), { secrets: new Map([['API_KEY' as never, SECRET]]) });
    const refused = await refusalOf(ask('bytes=0-9'));

    // Act
    secrets.clear();
    const served = await ask('bytes=0-9');

    // Assert
    should(refused?.code).eql('holds_secret');
    should(served.status).eql(206);
  });

  it('should scan again when the file is rewritten: new size, new mtime or a new inode', async () => {
    // Arrange
    const { ask, scans, tree } = fixture(file(CLIP));
    await ask('bytes=0-9');
    should(scans().length).eql(1);

    // Act + Assert, one rewrite at a time
    tree.set('clip.mp4', file(CLIP, { mtime: '2031-01-01T00:00:00.000Z' }));
    await ask('bytes=0-9');
    should(scans().length).eql(2);

    tree.set('clip.mp4', file(CLIP.subarray(0, CLIP.byteLength - 1), { mtime: '2031-01-01T00:00:00.000Z' }));
    await ask('bytes=0-9');
    should(scans().length).eql(3);

    tree.set(
      'clip.mp4',
      file(CLIP.subarray(0, CLIP.byteLength - 1), {
        mtime: '2031-01-01T00:00:00.000Z',
        identities: [
          { dev: 1n, ino: 100n, ctimeNs: 1_000_000_000n, mode: 0o40755 },
          { dev: 1n, ino: 999n, ctimeNs: 1_000_000_000n, mode: 0o100644 },
        ],
      }),
    );
    await ask('bytes=0-9');
    should(scans().length).eql(4);

    tree.set(
      'clip.mp4',
      file(CLIP.subarray(0, CLIP.byteLength - 1), {
        mtime: '2031-01-01T00:00:00.000Z',
        identities: [
          { dev: 1n, ino: 100n, ctimeNs: 1_000_000_000n, mode: 0o40755 },
          { dev: 1n, ino: 999n, ctimeNs: 2_000_000_000n, mode: 0o100644 },
        ],
      }),
    );
    await ask('bytes=0-9');
    should(scans().length).eql(5);

    // ...and an unchanged file is not scanned again
    await ask('bytes=10-19');
    should(scans().length).eql(5);
  });

  it('should refuse a rewritten file that now holds a value, though the old bytes were clean', async () => {
    // Arrange
    const { ask, tree } = fixture(file(CLIP), { secrets: new Map([['API_KEY' as never, SECRET]]) });
    await ask('bytes=0-9');
    const dirty = new Uint8Array([
      ...CLIP.subarray(0, CLIP.byteLength - SECRET.length),
      ...new TextEncoder().encode(SECRET),
    ]);

    // Act
    tree.set('clip.mp4', file(dirty, { mtime: '2031-01-01T00:00:00.000Z' }));
    const refused = await refusalOf(ask('bytes=0-9'));

    // Assert
    should(refused).eql({ code: 'holds_secret', status: 403 });
  });
});

describe('the media scan: a file cut short after it was judged', () => {
  it('should refuse a piece shorter than the range it named, never serve it short', async () => {
    // Arrange: the descriptor says the file is whole, and the bytes under it have gone (a truncation under the read)
    const { ask, tree } = fixture(file(CLIP));
    await ask('bytes=0-9');
    tree.set('clip.mp4', file(CLIP.subarray(0, 100), { size: CLIP.byteLength }));

    // Act
    const refused = await refusalOf(ask('bytes=1000-1999'));

    // Assert
    should(refused).eql({ code: 'changed', status: 409 });
  });
});

describe('the media scan: a refused file stays refused, range by range', () => {
  it('should refuse every range of a file that holds a value, and serve none of its bytes', async () => {
    // Arrange
    const withSecret = new Uint8Array([...patterned(500), ...new TextEncoder().encode(SECRET), ...patterned(500)]);
    const { ask, reads, scans } = fixture(file(withSecret), { secrets: new Map([['API_KEY' as never, SECRET]]) });

    // Act
    const refusals = [];
    for (const range of ['bytes=0-9', 'bytes=0-', 'bytes=-5', 'bytes=2000-'])
      refusals.push(await refusalOf(ask(range)));

    // Assert
    should(refusals.every(refusal => refusal?.code === 'holds_secret' && refusal?.status === 403)).be.true();
    should(scans().length).eql(1);
    should(reads().length).eql(1);
  });

  it('should serve no range to a request that waited on a scan that found a value', async () => {
    // Arrange
    const withSecret = new Uint8Array([...patterned(500), ...new TextEncoder().encode(SECRET), ...patterned(500)]);
    const { ask, scans } = fixture(file(withSecret), { secrets: new Map([['API_KEY' as never, SECRET]]) });

    // Act
    const settled = await Promise.allSettled([ask('bytes=0-9'), ask('bytes=10-19'), ask('bytes=20-29')]);

    // Assert
    should(settled.map(result => result.status)).eql(['rejected', 'rejected', 'rejected']);
    should(scans().length).eql(1);
  });

  it('should say the file is not served, not that it is not served to an agent, to a person', async () => {
    // Arrange
    const withSecret = new Uint8Array([...patterned(10), ...new TextEncoder().encode(SECRET)]);
    const { ask } = fixture(file(withSecret), { secrets: new Map([['API_KEY' as never, SECRET]]) });

    // Act
    const error = await ask('bytes=0-1').catch((caught: unknown) => caught);

    // Assert
    should((error as Error).message).eql('clip.mp4 holds a private value, so it is not served.');
  });
});

describe('the media scan: a redactor that cannot name its values keeps nothing', () => {
  it('should read and scan the whole file for every request, as before', async () => {
    // Arrange
    const inner = new FakeRedaction(new Map());
    const blind: Pick<Redaction, 'read'> = {
      read: async fn => await inner.read(scope => fn({ text: scope.text, cells: scope.cells, lines: scope.lines })),
    };
    const { ask, scans } = fixture(file(CLIP), { redaction: blind });

    // Act
    const first = await ask('bytes=0-9');
    const second = await ask('bytes=10-19');

    // Assert
    should(first.status).eql(206);
    should(second.status).eql(206);
    should(scans().length).eql(2);
  });
});

describe('the verdict memory', () => {
  const key = (n: number): string => `1:${n}:10:t:1`;

  it('should keep a verdict until the vault changes, then say nothing about the file', () => {
    // Arrange
    const cache = new MediaScanCache();
    const claim = cache.claim(key(1), 'vault-a');
    if (claim.kind !== 'scan') throw new Error('the first claim owes the scan');

    // Act
    claim.settle({ secret: false, fingerprint: 'vault-a' });

    // Assert
    should(cache.claim(key(1), 'vault-a')).eql({ kind: 'verdict', secret: false });
    should(cache.claim(key(1), 'vault-b').kind).eql('scan');
  });

  it('should hold at most its capacity, dropping the least recently used', () => {
    // Arrange
    const cache = new MediaScanCache(2);
    const settle = (n: number): void => {
      const claim = cache.claim(key(n), 'v');
      if (claim.kind === 'scan') claim.settle({ secret: false, fingerprint: 'v' });
    };
    settle(1);
    settle(2);
    cache.claim(key(1), 'v'); // 1 is now the more recently used

    // Act
    settle(3);

    // Assert
    should(cache.kept).eql(2);
    should(cache.claim(key(1), 'v').kind).eql('verdict');
    should(cache.claim(key(3), 'v').kind).eql('verdict');
    should(cache.claim(key(2), 'v').kind).eql('scan');
  });

  it('should hand the scan to a waiter when the one that owed it fails, and never read a failure as clean', async () => {
    // Arrange
    const cache = new MediaScanCache();
    const owner = cache.claim(key(1), 'v');
    const waiter = cache.claim(key(1), 'v');
    if (owner.kind !== 'scan' || waiter.kind !== 'wait') throw new Error('one owes the scan, the other waits');

    // Act
    owner.settle(undefined);

    // Assert
    should(await waiter.until).be.undefined();
    should(cache.claim(key(1), 'v').kind).eql('scan');
  });

  it('should key a file on its device, inode, size, mtime and ctime', () => {
    // Arrange
    const base = { identity: { dev: 1n, ino: 2n, ctimeNs: 3n, mode: 0o100644 }, size: 4, mtime: 't' };

    // Act + Assert
    const keys = new Set([
      MediaScanCache.keyOf(base),
      MediaScanCache.keyOf({ ...base, identity: { ...base.identity, dev: 9n } }),
      MediaScanCache.keyOf({ ...base, identity: { ...base.identity, ino: 9n } }),
      MediaScanCache.keyOf({ ...base, identity: { ...base.identity, ctimeNs: 9n } }),
      MediaScanCache.keyOf({ ...base, size: 9 }),
      MediaScanCache.keyOf({ ...base, mtime: 'u' }),
    ]);
    should(keys.size).eql(6);
  });
});
