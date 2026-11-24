import { describe, it } from 'bun:test';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import { type ApiResponse, ApiError } from '@ferretry/kernel/contract';
import should from 'should';
import {
  type FileBrowserDeps,
  sessionFilesystemRoutes,
} from '../../../../../daemon/lib/runtime/mounts/session-filesystem.ts';
import { AGENT_READ_FENCE, FsError, SessionFilesystem } from '../../../../../daemon/lib/session/filesystem/index.ts';
import { MAX_MEDIA_BYTES, MEDIA_CHUNK_BYTES } from '../../../../../contract/media-bytes.ts';
import { refusalOf } from '../../support/calls.ts';
import { jsonOf, requestOf } from '../../support/requests.ts';
import { FakeRootPinner, FakeSessionGit, textFile, treeOf, type FakeNode } from '../../session/filesystem/support.ts';

/**
 * `GET /v1/ferrets/:ferretId/fs/media`: one file of the ferret's MEDIA folder as raw bytes, in ranges (docs/fy-render.md
 * rule 11). It is the JSON read's walk and gates with a larger cap, so what is proved here is what is NEW: the bytes
 * and the headers they leave with, `Range`, the bare-name rule, the type allowlist, and the secrets rule.
 */

const MEDIA = 'GET /v1/ferrets/:ferretId/fs/media';
const WORK_CWD = '/work/ferretry';

const person: FileBrowserDeps['reach'] = async context => ({
  id: context.params.get('ferretId') ?? '',
  cwd: WORK_CWD,
});
const agent: FileBrowserDeps['reach'] = async context => ({
  id: context.params.get('ferretId') ?? '',
  cwd: WORK_CWD,
  fence: AGENT_READ_FENCE,
});

/** `size` bytes whose value at position `n` is `n % 251`, so a wrong slice cannot look right. */
const patterned = (size: number): Uint8Array => Uint8Array.from({ length: size }, (_unused, at) => at % 251);
const file = (bytes: Uint8Array, overrides: Partial<FakeNode> = {}): FakeNode => ({
  bytes,
  type: 'file',
  ...overrides,
});

function fixture(
  files: readonly (readonly [string, FakeNode])[],
  options: {
    readonly reach?: FileBrowserDeps['reach'];
    readonly secrets?: ReadonlyMap<never, string>;
    readonly mediaBound?: boolean;
    readonly git?: FakeSessionGit;
  } = {},
) {
  const work = new FakeRootPinner({ tree: treeOf(['clip.mp4', textFile('work tree bytes\n')]) });
  const media = new FakeRootPinner({ tree: treeOf(...files) });
  const git = options.git ?? new FakeSessionGit({ isTracked: () => true });
  const mediaFerrets: string[] = [];
  const routes = sessionFilesystemRoutes({
    filesystem: new SessionFilesystem(work, git),
    ...(options.mediaBound === false
      ? {}
      : {
          media: (ferret: string) => {
            mediaFerrets.push(ferret);
            return new SessionFilesystem(media, git);
          },
        }),
    reach: options.reach ?? person,
    redaction: new FakeRedaction(options.secrets ?? new Map()),
  });
  const ask = async (
    query: Record<string, string>,
    headers: Record<string, string> = {},
    ferretId = 's1',
  ): Promise<ApiResponse> => await routes[MEDIA](requestOf({ headers, params: { ferretId }, query }));
  return { ask, media, mediaFerrets, work };
}

const bytesOf = (response: ApiResponse): Uint8Array => response.bytes ?? new Uint8Array();

describe('the media byte route: the bytes and how they leave', () => {
  it('should answer a small file whole with 200, its type and no sniffing', async () => {
    // Arrange
    const clip = patterned(2_000);
    const { ask } = fixture([['clip.mp4', file(clip)]]);

    // Act
    const response = await ask({ name: 'clip.mp4' });

    // Assert
    should(response.status).eql(200);
    should([...bytesOf(response)]).eql([...clip]);
    should(response.body).eql('');
    should(response.headers.get('content-type')).eql('video/mp4');
    should(response.headers.get('accept-ranges')).eql('bytes');
    should(response.headers.get('x-content-type-options')).eql('nosniff');
    should(response.headers.get('content-security-policy')).eql("default-src 'none'; sandbox");
    should(response.headers.get('cross-origin-resource-policy')).eql('same-origin');
    should(response.headers.has('content-range')).be.false();
  });

  it('should answer a range with 206, exactly those bytes and a Content-Range naming the whole size', async () => {
    // Arrange
    const song = patterned(3 * 1024 * 1024);
    const { ask } = fixture([['song.mp3', file(song)]]);

    // Act
    const response = await ask({ name: 'song.mp3' }, { range: 'bytes=1000-1999' });

    // Assert
    should(response.status).eql(206);
    should(response.headers.get('content-range')).eql(`bytes 1000-1999/${song.byteLength}`);
    should(response.headers.get('content-type')).eql('audio/mpeg');
    should([...bytesOf(response)]).eql([...song.subarray(1000, 2000)]);
  });

  it('should serve a file of three mebibytes in one range from its first byte to its last', async () => {
    // Arrange
    const clip = patterned(3 * 1024 * 1024 + 17);
    const { ask } = fixture([['clip.webm', file(clip)]]);

    // Act
    const response = await ask({ name: 'clip.webm' }, { range: `bytes=0-${clip.byteLength - 1}` });

    // Assert
    should(response.status).eql(206);
    should(response.headers.get('content-range')).eql(`bytes 0-${clip.byteLength - 1}/${clip.byteLength}`);
    should(bytesOf(response).byteLength).eql(clip.byteLength);
    should(Buffer.compare(Buffer.from(bytesOf(response)), Buffer.from(clip))).eql(0);
  });

  it('should clamp an open range to one piece and say where the piece ends', async () => {
    // Arrange
    const clip = patterned(MEDIA_CHUNK_BYTES * 2 + 5);
    const { ask } = fixture([['clip.mp4', file(clip)]]);

    // Act
    const first = await ask({ name: 'clip.mp4' }, { range: 'bytes=0-' });
    const last = await ask({ name: 'clip.mp4' }, { range: `bytes=${MEDIA_CHUNK_BYTES * 2}-` });

    // Assert
    should(first.status).eql(206);
    should(first.headers.get('content-range')).eql(`bytes 0-${MEDIA_CHUNK_BYTES - 1}/${clip.byteLength}`);
    should(bytesOf(first).byteLength).eql(MEDIA_CHUNK_BYTES);
    should(last.headers.get('content-range')).eql(
      `bytes ${MEDIA_CHUNK_BYTES * 2}-${MEDIA_CHUNK_BYTES * 2 + 4}/${clip.byteLength}`,
    );
    should(bytesOf(last).byteLength).eql(5);
  });

  it('should answer a suffix range with the last bytes', async () => {
    // Arrange
    const clip = patterned(5_000);
    const { ask } = fixture([['clip.mp4', file(clip)]]);

    // Act
    const response = await ask({ name: 'clip.mp4' }, { range: 'bytes=-100' });

    // Assert
    should(response.status).eql(206);
    should(response.headers.get('content-range')).eql('bytes 4900-4999/5000');
    should([...bytesOf(response)]).eql([...clip.subarray(4900)]);
  });

  it('should answer a start past the end with 416 and the size in Content-Range, and no bytes', async () => {
    // Arrange
    const { ask } = fixture([['clip.mp4', file(patterned(1_000))]]);

    // Act
    const response = await ask({ name: 'clip.mp4' }, { range: 'bytes=1000-' });

    // Assert
    should(response.status).eql(416);
    should(response.headers.get('content-range')).eql('bytes */1000');
    should(response.headers.get('x-content-type-options')).eql('nosniff');
    should(response.bytes).be.undefined();
    should(jsonOf(response)).have.property('code', 'range_not_satisfiable');
  });

  it('should ignore a range it does not understand and answer a small file whole', async () => {
    // Arrange
    const clip = patterned(100);
    const { ask } = fixture([['clip.mp4', file(clip)]]);

    // Act
    const multiple = await ask({ name: 'clip.mp4' }, { range: 'bytes=0-9,20-29' });
    const backwards = await ask({ name: 'clip.mp4' }, { range: 'bytes=9-2' });

    // Assert
    for (const response of [multiple, backwards]) {
      should(response.status).eql(200);
      should(bytesOf(response).byteLength).eql(100);
    }
  });

  it('should refuse a large file asked for with no range, rather than send a body one session cannot carry', async () => {
    // Arrange
    const { ask } = fixture([['clip.mp4', file(patterned(MEDIA_CHUNK_BYTES + 1))]]);

    // Act
    const refusal = await refusalOf(ask({ name: 'clip.mp4' }));

    // Assert
    should(refusal).eql({ code: 'range_required', status: 413 });
  });

  it('should serve a file exactly at the cap, and refuse one a byte over with 413 too_large', async () => {
    // Arrange
    const atCap = file(new Uint8Array(0), { size: MAX_MEDIA_BYTES });
    const { ask } = fixture([
      ['exact.mp4', { ...atCap, bytes: patterned(MAX_MEDIA_BYTES) }],
      ['over.mp4', file(new Uint8Array(0), { size: MAX_MEDIA_BYTES + 1 })],
    ]);

    // Act
    const exact = await ask({ name: 'exact.mp4' }, { range: `bytes=${MAX_MEDIA_BYTES - 3}-` });
    const over = await refusalOf(ask({ name: 'over.mp4' }, { range: 'bytes=0-9' }));

    // Assert
    should(exact.status).eql(206);
    should(exact.headers.get('content-range')).eql(
      `bytes ${MAX_MEDIA_BYTES - 3}-${MAX_MEDIA_BYTES - 1}/${MAX_MEDIA_BYTES}`,
    );
    should(over).eql({ code: 'too_large', status: 413 });
  });

  it('should answer an empty file whole and refuse any range of it with 416', async () => {
    // Arrange
    const { ask } = fixture([['empty.wav', file(new Uint8Array(0))]]);

    // Act
    const whole = await ask({ name: 'empty.wav' });
    const ranged = await ask({ name: 'empty.wav' }, { range: 'bytes=0-0' });

    // Assert
    should(whole.status).eql(200);
    should(bytesOf(whole).byteLength).eql(0);
    should(ranged.status).eql(416);
    should(ranged.headers.get('content-range')).eql('bytes */0');
  });
});

describe('the media byte route: what it will serve', () => {
  it.each(['../clip.mp4', 'sub/clip.mp4', '/clip.mp4', 'a\\clip.mp4', '..', '.', ''])(
    'should refuse the name %j before any walk starts',
    async name => {
      // Arrange
      const { ask, media, mediaFerrets } = fixture([['clip.mp4', file(patterned(10))]]);

      // Act
      const refusal = await refusalOf(ask({ name }));

      // Assert
      should(refusal).eql({ code: 'invalid_path', status: 400 });
      should(media.pinnedCwds).eql([]);
      should(mediaFerrets).eql([]);
    },
  );

  it('should refuse a request that names no file', async () => {
    // Arrange
    const { ask } = fixture([]);

    // Act
    const refusal = await refusalOf(ask({}));

    // Assert
    should(refusal).eql({ code: 'invalid_path', status: 400 });
  });

  it('should refuse a path query: the folder is chosen by the route, a caller names only a file', async () => {
    // Arrange
    const { ask } = fixture([['clip.mp4', file(patterned(10))]]);

    // Act
    const refusal = await refusalOf(ask({ path: 'clip.mp4' }));

    // Assert
    should(refusal).eql({ code: 'invalid_path', status: 400 });
  });

  it.each(['page.html', 'logo.svg', 'run.js', 'data.json', 'noextension'])(
    'should refuse %s with 415: its type is not on the allowlist, so nothing is walked',
    async name => {
      // Arrange
      const { ask, media } = fixture([[name, file(patterned(10))]]);

      // Act
      const refusal = await refusalOf(ask({ name }));

      // Assert
      should(refusal).eql({ code: 'unsupported_type', status: 415 });
      should(media.pinnedCwds).eql([]);
    },
  );

  it('should read the ferret media folder and never its working tree', async () => {
    // Arrange
    const { ask, media, mediaFerrets, work } = fixture([['clip.mp4', file(patterned(10))]]);

    // Act
    const response = await ask({ name: 'clip.mp4' }, {}, 'ferret-7');

    // Assert
    should(response.status).eql(200);
    should(mediaFerrets).eql(['ferret-7']);
    should(media.pinnedCwds).have.length(1);
    should(work.pinnedCwds).eql([]);
  });

  it('should answer 404 when this daemon keeps no media folder', async () => {
    // Arrange
    const { ask, work } = fixture([], { mediaBound: false });

    // Act
    const refusal = await refusalOf(ask({ name: 'clip.mp4' }));

    // Assert
    should(refusal).eql({ code: 'not_found', status: 404 });
    should(work.pinnedCwds).eql([]);
  });

  it('should answer 404 for a file that is not there', async () => {
    // Arrange
    const { ask } = fixture([]);

    // Act
    const refusal = await refusalOf(ask({ name: 'gone.mp4' }));

    // Assert
    should(refusal?.status).eql(404);
  });

  it('should refuse a link that points out of the folder with 403 escapes_root', async () => {
    // Arrange
    const { ask } = fixture([
      ['link.mp4', { error: new FsError('escapes_root', 'link leaves the folder'), type: 'file' }],
    ]);

    // Act
    const refusal = await refusalOf(ask({ name: 'link.mp4' }));

    // Assert
    should(refusal).eql({ code: 'escapes_root', status: 403 });
  });

  it('should refuse a name the protected-secrets list denies, naming the rule', async () => {
    // Arrange
    const { ask } = fixture([['.env.mp4', file(patterned(10))]]);

    // Act
    const failure = await ask({ name: '.env.mp4' }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceOf(ApiError);
    should((failure as ApiError).status).eql(403);
    should(['denied', 'ignored']).containEql((failure as ApiError).code);
  });
});

describe('the media byte route: who may read it, and secrets', () => {
  it('should serve an agent the media folder behind the same fence, and refuse a hard-linked file', async () => {
    // Arrange
    const { ask } = fixture(
      [
        ['clip.mp4', file(patterned(10))],
        ['linked.mp4', file(patterned(10), { links: 2 })],
      ],
      { reach: agent },
    );

    // Act
    const served = await ask({ name: 'clip.mp4' });
    const linked = await refusalOf(ask({ name: 'linked.mp4' }));

    // Assert
    should(served.status).eql(200);
    should(linked?.status).eql(403);
  });

  it('should refuse reaching another ferret before any walk, as the file route does', async () => {
    // Arrange
    const refusing: FileBrowserDeps['reach'] = async () => {
      throw new ApiError(403, 'not your ferret', 'not_own_ferret');
    };
    const { ask, media, mediaFerrets } = fixture([['clip.mp4', file(patterned(10))]], { reach: refusing });

    // Act
    const refusal = await refusalOf(ask({ name: 'clip.mp4' }));

    // Assert
    should(refusal).eql({ code: 'not_own_ferret', status: 403 });
    should(media.pinnedCwds).eql([]);
    should(mediaFerrets).eql([]);
  });

  it('should refuse a file holding a vault value to a person and to an agent, never masked', async () => {
    // Arrange
    const secret = 'sk-live-not-for-chat-0123456789';
    const withSecret = new Uint8Array([...patterned(100), ...new TextEncoder().encode(secret), ...patterned(100)]);
    const secrets = new Map([['API_KEY' as never, secret]]);
    const asPerson = fixture([['clip.mp4', file(withSecret)]], { secrets });
    const asAgent = fixture([['clip.mp4', file(withSecret)]], { reach: agent, secrets });

    // Act
    const person403 = await refusalOf(asPerson.ask({ name: 'clip.mp4' }, { range: 'bytes=0-9' }));
    const agent403 = await refusalOf(asAgent.ask({ name: 'clip.mp4' }, { range: 'bytes=0-9' }));

    // Assert
    should(person403).eql({ code: 'holds_secret', status: 403 });
    should(agent403).eql({ code: 'holds_secret', status: 403 });
  });

  it('should open the vault only after every gate, and not at all for a refused name', async () => {
    // Arrange
    const redaction = new FakeRedaction(new Map());
    const media = new FakeRootPinner({ tree: treeOf(['clip.mp4', file(patterned(10))]) });
    const routes = sessionFilesystemRoutes({
      filesystem: new SessionFilesystem(new FakeRootPinner({ tree: treeOf() }), new FakeSessionGit({})),
      media: () => new SessionFilesystem(media, new FakeSessionGit({ isTracked: () => true })),
      reach: person,
      redaction,
    });

    // Act
    await refusalOf(routes[MEDIA](requestOf({ params: { ferretId: 's1' }, query: { name: '../x.mp4' } })));
    await refusalOf(routes[MEDIA](requestOf({ params: { ferretId: 's1' }, query: { name: 'x.html' } })));
    const opensBefore = redaction.opens;
    await routes[MEDIA](requestOf({ params: { ferretId: 's1' }, query: { name: 'clip.mp4' } }));

    // Assert
    should(opensBefore).eql(0);
    should(redaction.opens).eql(1);
  });
});
