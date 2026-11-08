import { describe, it } from 'bun:test';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import { ApiError, type ApiResponse, type Redaction } from '@ferretry/kernel/contract';
import { SessionFileIndexResponseSchema } from '../../../../../daemon/lib/protocol/session-search.ts';
import should from 'should';
import {
  type FileBrowserDeps,
  type FileBrowserRouteKey,
  sessionFilesystemRoutes,
} from '../../../../../daemon/lib/runtime/mounts/session-filesystem.ts';
import { FsError, SessionFilesystem } from '../../../../../daemon/lib/session/filesystem/index.ts';
import { type RequestOf, jsonOf, requestOf } from '../../support/requests.ts';
import { refusalOf } from '../../support/calls.ts';
import {
  directory,
  type FakeRootOptions,
  FakeRootPinner,
  FakeSessionGit,
  type SessionGitScript,
  textFile,
  treeOf,
} from '../../session/filesystem/support.ts';

/**
 * The HTTP shape of the working-tree read.
 *
 * Two things are asserted that the domain cannot assert for itself: the cwd comes from the ferret the host's
 * `reach` resolves rather than from anything a caller sent, and every refusal arrives as a status a client can act
 * on. Which ferret a caller may reach, and the no-store spine, are the host's and the kernel's.
 */

const SESSION_CWD = '/work/ferretry';

/** The host's reach as a person sees it: the path's ferret, in its working folder, behind no fence. */
const person: FileBrowserDeps['reach'] = async context => ({
  id: context.params.get('ferretId') ?? '',
  cwd: SESSION_CWD,
});

type Ask = Omit<RequestOf, 'method' | 'path' | 'params'> & { readonly ferretId?: string };

/** A FAKE fixture secret, never a real credential. Tests assert on booleans so a failure never prints it. */
const FIXTURE_SECRET = 'fixture-diff-secret-value-0001';
const FIXTURE_NAME = 'DIFF_FIXTURE' as never;
const noSecrets = (): Pick<Redaction, 'read'> => new FakeRedaction(new Map());
const withSecret = (): Pick<Redaction, 'read'> => new FakeRedaction(new Map([[FIXTURE_NAME, FIXTURE_SECRET]]));

function fixture(
  root: FakeRootOptions = {},
  git: SessionGitScript = {},
  reach: FileBrowserDeps['reach'] = person,
  redaction: Pick<Redaction, 'read'> = noSecrets(),
) {
  const pinner = new FakeRootPinner(root);
  const filesystem = new SessionFilesystem(pinner, new FakeSessionGit(git));
  const routes = sessionFilesystemRoutes({ filesystem, reach, redaction });
  const ask = async (key: FileBrowserRouteKey, { ferretId = 's1', ...spec }: Ask = {}): Promise<ApiResponse> =>
    await routes[key](requestOf({ ...spec, params: { ferretId } }));
  return { pinner, filesystem, ask };
}

const tree = () => treeOf(['', directory([{ name: 'a.ts', type: 'file' }])], ['a.ts', textFile('body\n')]);

const LIST = 'GET /v1/ferrets/:ferretId/fs';
const INDEX = 'GET /v1/ferrets/:ferretId/fs/index';
const CHANGES = 'GET /v1/ferrets/:ferretId/fs/changes';
const FILE = 'GET /v1/ferrets/:ferretId/fs/file';
const DIFF = 'GET /v1/ferrets/:ferretId/fs/diff';
const ALL: readonly FileBrowserRouteKey[] = [INDEX, CHANGES, DIFF, LIST];

describe('the working-tree listing route', () => {
  it('should list the session root from the cwd the host resolves', async () => {
    // Arrange
    const { pinner, ask } = fixture({ tree: tree() });

    // Act
    const response = await ask(LIST);

    // Assert
    should(response.status).eql(200);
    should(pinner.pinnedCwds).eql([SESSION_CWD]);
    should(jsonOf(response)).have.property('entries');
  });

  it('should list a subdirectory named by the path parameter', async () => {
    // Arrange
    const { ask } = fixture({ tree: treeOf(['src', directory([{ name: 'b.ts', type: 'file' }])]) });

    // Act
    const response = await ask(LIST, { query: { path: 'src' } });

    // Assert
    should(response.status).eql(200);
    should(jsonOf(response)).have.property('path', 'src');
  });

  it('should refuse to enumerate a denied directory with a 403', async () => {
    // Arrange
    const { ask } = fixture({ tree: treeOf(['.git', directory([])]) });

    // Act
    const refusal = await refusalOf(ask(LIST, { query: { path: '.git' } }));

    // Assert
    should(refusal).eql({ status: 403, code: 'denied' });
  });

  it('should report a failure that is NOT a domain refusal as a server fault', async () => {
    // Arrange: a genuine bug must not be reported as the client's mistake.
    const { ask } = fixture({ pinError: new TypeError('a genuine bug') });

    // Act
    const thrown = await ask(LIST).catch((error: unknown) => error);

    // Assert: not restated as a refusal; the kernel answers it as a 500.
    should(thrown).be.instanceOf(TypeError);
    should(thrown).not.be.instanceOf(ApiError);
  });

  it('should map each refusal code onto the status a client can act on', async () => {
    // Arrange
    const cases: readonly (readonly [FsError, number])[] = [
      [new FsError('invalid_path', 'bad'), 400],
      [new FsError('not_found', 'gone'), 404],
      [new FsError('not_a_directory', 'file'), 400],
      [new FsError('not_a_file', 'directory'), 400],
      [new FsError('escapes_root', 'outside'), 403],
      [new FsError('denied', 'never'), 403],
      [new FsError('ignored', 'ignored'), 403],
      // Not a 403: the caller's authority is not what is missing, the implementation is.
      [new FsError('unsupported', 'this machine cannot'), 501],
    ];

    // Act / Assert
    for (const [error, status] of cases) {
      const { ask } = fixture({ pinError: error });
      should(await refusalOf(ask(LIST))).eql({ status, code: error.code });
    }
  });
});

describe('the host reach', () => {
  it('should answer the refusal the host raises, on every route, before anything is pinned', async () => {
    // Arrange: the host refuses an absent ferret and an id that decodes to a traversal step.
    const reach: FileBrowserDeps['reach'] = async context => {
      const id = context.params.get('ferretId');
      if (id === '%2e%2e') throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
      throw new ApiError(404, `no session ${String(id)}`, 'not-found');
    };
    const { pinner, ask } = fixture({ tree: tree() }, {}, reach);

    // Act
    const absent = await Promise.all(ALL.map(async key => await refusalOf(ask(key, { ferretId: 'absent' }))));
    const traversal = await Promise.all(ALL.map(async key => await refusalOf(ask(key, { ferretId: '%2e%2e' }))));

    // Assert
    should(absent).eql(ALL.map(() => ({ status: 404, code: 'not-found' })));
    should(traversal).eql(ALL.map(() => ({ status: 400, code: 'invalid_session_id' })));
    should(pinner.pinnedCwds).eql([]);
  });
});

describe('a daemon whose file browser is not built', () => {
  it('should answer 503 on every route, after the host has decided who may ask', async () => {
    // Arrange
    const reached: string[] = [];
    const routes = sessionFilesystemRoutes({
      filesystem: undefined,
      redaction: noSecrets(),
      reach: async context => {
        const id = context.params.get('ferretId') ?? '';
        reached.push(id);
        if (id === 'other') throw new ApiError(403, 'not your ferret', 'not_own_session');
        return { id, cwd: SESSION_CWD };
      },
    });
    const at = (ferretId: string) => requestOf({ params: { ferretId }, query: { path: 'a.ts' } });

    // Act
    const unbuilt = await Promise.all(ALL.map(async key => await refusalOf(routes[key](at('s1')))));
    const refused = await refusalOf(routes[LIST](at('other')));

    // Assert
    should(unbuilt).eql(ALL.map(() => ({ status: 503, code: 'plugin_unavailable' })));
    should(refused).eql({ status: 403, code: 'not_own_session' });
    should(reached).eql(['s1', 's1', 's1', 's1', 'other']);
  });
});

describe('the changes route', () => {
  it('should serve the change list', async () => {
    // Arrange
    const { ask } = fixture(
      { tree: tree() },
      { changes: () => ({ repo: true, branch: 'main', changes: [{ path: 'a.ts', status: ' M' }] }) },
    );

    // Act
    const response = await ask(CHANGES);

    // Assert
    should(response.status).eql(200);
    should(jsonOf(response)).match({ repo: true, branch: 'main' });
  });

  it('should surface a pinner refusal as its own status', async () => {
    // Arrange
    const { ask } = fixture({ pinError: new FsError('denied', 'session cwd is not served') });

    // Act
    const refusal = await refusalOf(ask(CHANGES));

    // Assert
    should(refusal).eql({ status: 403, code: 'denied' });
  });
});

describe('the diff route', () => {
  it('should serve the diff as plain text', async () => {
    // Arrange
    const { ask } = fixture(
      { tree: tree() },
      { isTracked: () => true, diffSnapshots: () => ({ diff: 'DIFF BODY', truncated: false }) },
    );

    // Act
    const response = await ask(DIFF, { query: { path: 'a.ts' } });

    // Assert
    should(response.status).eql(200);
    should(response.body).eql('DIFF BODY');
    should(response.headers.get('content-type')).match(/text\/plain/);
  });

  it('R-0150 a file holding a vault secret comes back REDACTED in the diff response, while the internal diff keeps the real bytes', async () => {
    // Arrange: the changed line holds a vault value.
    const raw = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const key = "old";\n+const key = "${FIXTURE_SECRET}";\n`;
    const { ask, filesystem } = fixture(
      { tree: tree() },
      { isTracked: () => true, diffSnapshots: () => ({ diff: raw, truncated: false }) },
      person,
      withSecret(),
    );

    // Act
    const response = await ask(DIFF, { query: { path: 'a.ts' } });
    const internal = await filesystem.diff(SESSION_CWD, 'a.ts');

    // Assert (booleans, so a failure never prints the value)
    const served = String(response.body);
    should(response.status).eql(200);
    should(served.includes(FIXTURE_SECRET)).be.false();
    should(served.includes('*'.repeat(FIXTURE_SECRET.length))).be.true();
    should(served.includes('-const key = "old";')).be.true();
    should(internal.diff === raw).be.true();
    should(internal.diff.includes(FIXTURE_SECRET)).be.true();
  });

  it('R-0151 a file holding a vault secret comes back REDACTED, in text and in base64, while the file on disk keeps the real bytes', async () => {
    const text = `const key = "${FIXTURE_SECRET}";\n`;
    const { ask, filesystem } = fixture(
      { tree: treeOf(['a.ts', textFile(text)]) },
      { isTracked: () => true },
      person,
      withSecret(),
    );

    const served = await ask(FILE, { query: { path: 'a.ts' } });
    const encoded = await ask(FILE, { query: { path: 'a.ts', format: 'base64' } });
    const internal = await filesystem.readFile(SESSION_CWD, 'a.ts', {});

    should(served.status).eql(200);
    should(JSON.stringify(served.body).includes(FIXTURE_SECRET)).be.false();
    should(JSON.stringify(served.body).includes('*'.repeat(FIXTURE_SECRET.length))).be.true();
    const decoded = Buffer.from(
      String((JSON.parse(String(encoded.body)) as { base64?: string }).base64),
      'base64',
    ).toString('utf8');
    should(decoded.includes(FIXTURE_SECRET)).be.false();
    should(decoded.includes('*'.repeat(FIXTURE_SECRET.length))).be.true();
    should(internal.content === text).be.true();
  });

  const brokenVault: Pick<Redaction, 'read'> = {
    read: async () => {
      throw new Error('the vault could not open');
    },
  };

  it('R-0151 a denied file is still its badge when the vault cannot open', async () => {
    const { ask } = fixture(
      { tree: treeOf(['.env', textFile('TOKEN=1')]) },
      { isTracked: () => true },
      person,
      brokenVault,
    );

    const response = await ask(FILE, { query: { path: '.env' } });

    should(response.status).eql(200);
    should(jsonOf(response)).have.property('denied', true);
  });

  it('R-0151 an allowed file serves nothing when the vault cannot open', async () => {
    const { ask } = fixture(
      { tree: treeOf(['a.ts', textFile(FIXTURE_SECRET)]) },
      { isTracked: () => true },
      person,
      brokenVault,
    );

    const outcome = await ask(FILE, { query: { path: 'a.ts' } }).then(
      response => JSON.stringify(response.body),
      (error: unknown) => (error instanceof Error ? error.message : ''),
    );

    should(outcome.includes(FIXTURE_SECRET)).be.false();
    should(outcome).eql('the vault could not open');
  });

  it('R-0151 the vault is opened only after the gates pass', async () => {
    let opened = 0;
    const counting: Pick<Redaction, 'read'> = {
      read: async fn => {
        opened += 1;
        return await withSecret().read(fn);
      },
    };
    const make = (files: FakeRootOptions) => fixture(files, { isTracked: () => true }, person, counting);

    await refusalOf(make({ tree: tree() }).ask(FILE));
    await refusalOf(make({ tree: tree() }).ask(FILE, { query: { path: 'missing.ts' } }));
    await make({ tree: treeOf(['.env', textFile('TOKEN=1')]) }).ask(FILE, { query: { path: '.env' } });
    const refused = opened;
    const served = await make({ tree: tree() }).ask(FILE, { query: { path: 'a.ts' } });

    should(refused).eql(0);
    should(served.status).eql(200);
    should(opened).eql(1);
  });

  it('R-0151 the file browser mount has no write route (every key is a GET)', async () => {
    const keys = Object.keys(sessionFilesystemRoutes({ filesystem: undefined, reach: person, redaction: noSecrets() }));

    should(keys.every(key => key.startsWith('GET '))).be.true();
  });

  it('R-0150 a vault that cannot open serves no diff at all', async () => {
    // Arrange
    const raw = `@@ -1 +1 @@\n+${FIXTURE_SECRET}\n`;
    const broken: Pick<Redaction, 'read'> = {
      read: async () => {
        throw new Error('the vault could not open');
      },
    };
    const { ask } = fixture(
      { tree: tree() },
      { isTracked: () => true, diffSnapshots: () => ({ diff: raw, truncated: false }) },
      person,
      broken,
    );

    // Act
    const outcome = await ask(DIFF, { query: { path: 'a.ts' } }).then(
      response => String(response.body),
      (error: unknown) => (error instanceof Error ? error.message : ''),
    );

    // Assert
    should(outcome.includes(FIXTURE_SECRET)).be.false();
    should(outcome).eql('the vault could not open');
  });

  it('R-0150 a denied diff is still a 403 when the vault cannot open', async () => {
    const broken: Pick<Redaction, 'read'> = {
      read: async () => {
        throw new Error('the vault could not open');
      },
    };
    const { ask } = fixture({ tree: treeOf(['.env', textFile('TOKEN=1')]) }, { isTracked: () => true }, person, broken);

    const refusal = await refusalOf(ask(DIFF, { query: { path: '.env' } }));

    should(refusal).eql({ status: 403, code: 'denied' });
  });

  it('R-0150 the vault is opened only after the gates pass', async () => {
    let opened = 0;
    const counting: Pick<Redaction, 'read'> = {
      read: async fn => {
        opened += 1;
        return await withSecret().read(fn);
      },
    };
    const raw = `@@ -1 +1 @@\n+x\n`;
    const make = (git: SessionGitScript, files: FakeRootOptions) => fixture(files, git, person, counting);

    await refusalOf(make({ isTracked: () => true }, { tree: tree() }).ask(DIFF));
    await refusalOf(
      make({ isTracked: () => true }, { tree: treeOf(['.env', textFile('TOKEN=1')]) }).ask(DIFF, {
        query: { path: '.env' },
      }),
    );
    await refusalOf(
      make({ isTracked: () => true, diffSnapshots: () => ({ diff: raw, truncated: true }) }, { tree: tree() }).ask(
        DIFF,
        { query: { path: 'a.ts' } },
      ),
    );
    const refused = opened;
    const served = await make(
      { isTracked: () => true, diffSnapshots: () => ({ diff: raw, truncated: false }) },
      { tree: tree() },
    ).ask(DIFF, { query: { path: 'a.ts' } });

    should(refused).eql(0);
    should(served.status).eql(200);
    should(opened).eql(1);
  });

  it('R-0150 the secrets-policy refusal still runs first, and a denied diff is still a 403', async () => {
    // Arrange
    const { ask } = fixture(
      { tree: treeOf(['.env', textFile('TOKEN=1')]) },
      { isTracked: () => true },
      person,
      withSecret(),
    );

    // Act
    const refusal = await refusalOf(ask(DIFF, { query: { path: '.env' } }));

    // Assert
    should(refusal).eql({ status: 403, code: 'denied' });
  });

  it('should require the path parameter', async () => {
    // Arrange
    const { ask } = fixture({ tree: tree() });

    // Act
    const refusal = await refusalOf(ask(DIFF));

    // Assert
    should(refusal).eql({ status: 400, code: 'invalid_path' });
  });

  it('should refuse a denied diff with a 403, since the body has nowhere to carry a badge', async () => {
    // Arrange
    const { ask } = fixture({ tree: treeOf(['.env', textFile('TOKEN=1')]) }, { isTracked: () => true });

    // Act
    const refusal = await refusalOf(ask(DIFF, { query: { path: '.env' } }));

    // Assert
    should(refusal).eql({ status: 403, code: 'denied' });
  });

  it('should refuse an ignored diff with a 403 and its own code', async () => {
    // Arrange
    const { ask } = fixture({ tree: treeOf(['out.js', textFile('x')]) }, { ignoredPaths: () => new Set(['out.js']) });

    // Act
    const refusal = await refusalOf(ask(DIFF, { query: { path: 'out.js' } }));

    // Assert
    should(refusal).eql({ status: 403, code: 'ignored' });
  });

  it('should refuse a TRUNCATED diff, because a partial one misleads a reviewer', async () => {
    // Arrange
    const { ask } = fixture(
      { tree: treeOf(['a.ts', textFile('x')]) },
      { isTracked: () => true, diffSnapshots: () => ({ diff: 'PARTIAL', truncated: true }) },
    );

    // Act
    const refusal = await refusalOf(ask(DIFF, { query: { path: 'a.ts' } }));

    // Assert
    should(refusal).eql({ status: 413, code: 'too_large' });
  });

  it('should surface a containment refusal as a 403', async () => {
    // Arrange
    const { ask } = fixture({
      tree: treeOf(['link', { error: new FsError('escapes_root', 'path escapes the session root: link') }]),
    });

    // Act
    const refusal = await refusalOf(ask(DIFF, { query: { path: 'link' } }));

    // Assert
    should(refusal).eql({ status: 403, code: 'escapes_root' });
  });
});

/**
 * The whole-session file index.
 *
 * The first case is the before/after in one place: a client that walked the tree through the listing
 * route is refused at the FIRST directory of any Git checkout, and the same fixture answers 200 through
 * the index route with the files and a count of what it withheld. That difference is the row's file half.
 */
describe('the working-tree index route', () => {
  /** The checkout every real session looks like: a `.git`, a `node_modules`, and some source. */
  const checkout = () =>
    treeOf(
      [
        '',
        directory([
          { name: '.git', type: 'dir' },
          { name: 'node_modules', type: 'dir' },
          { name: 'src', type: 'dir' },
          { name: 'README.md', type: 'file' },
        ]),
      ],
      ['.git', directory([{ name: 'config', type: 'file' }])],
      ['node_modules', directory([{ name: 'left-pad', type: 'dir' }])],
      ['src', directory([{ name: 'app.ts', type: 'file' }])],
      ['src/app.ts', textFile('x')],
    );

  const notARepo: SessionGitScript = { repoInfo: () => ({ repo: false, prefix: '', hasHead: false }) };

  type Listing = { entries: { name: string; type: string }[] };

  it('should answer a checkout the per-directory crawl could never get past', async () => {
    // Arrange: one fixture, both readings.
    const { ask } = fixture({ tree: checkout() }, notARepo);

    // Act: what a recursive client crawl did — root plus one request per directory, never per file.
    let crawlRequests = 0;
    const crawl = async (path: string | undefined): Promise<{ status: number; body?: Listing }> => {
      crawlRequests += 1;
      try {
        const response = await ask(LIST, path === undefined ? {} : { query: { path } });
        return { status: response.status, body: jsonOf<Listing>(response) };
      } catch (error) {
        if (error instanceof ApiError) return { status: error.status };
        throw error;
      }
    };
    const root = (await crawl(undefined)).body ?? { entries: [] };
    const queue = root.entries.filter(entry => entry.type === 'dir').map(entry => entry.name);
    const crawled = [];
    while (queue.length > 0) {
      const path = queue.shift();
      if (path === undefined) break;
      const response = await crawl(path);
      crawled.push(response);
      if (response.status !== 200 || response.body === undefined) continue;
      queue.push(...response.body.entries.filter(entry => entry.type === 'dir').map(entry => `${path}/${entry.name}`));
    }
    let indexRequests = 0;
    indexRequests += 1;
    const indexed = await ask(INDEX);

    // Assert: the crawl meets a 403 it cannot tell from a failure, and it takes one request per
    // directory to get there. The index is ONE request and returns the files with the refusal counted.
    should(crawled.filter(response => response.status === 403)).have.length(2);
    should(crawlRequests).eql(4);
    should(indexRequests).eql(1);
    should(indexed.status).eql(200);
    should(jsonOf(indexed)).match({
      v: 1,
      sessionId: 's1',
      files: [
        { path: 'README.md', name: 'README.md' },
        { path: 'src/app.ts', name: 'app.ts' },
      ],
      coverage: 'complete',
      skipped: [{ reason: 'excluded', count: 2 }],
    });
  });

  it('should produce a document its own protocol schema accepts', async () => {
    // Arrange
    const { ask } = fixture({ tree: checkout() }, notARepo);

    // Act
    const response = await ask(INDEX);

    // Assert
    should(SessionFileIndexResponseSchema.safeParse(jsonOf(response)).success).be.true();
    should(jsonOf(response)).have.property('files');
    should(jsonOf(response)).not.have.property('entries');
  });

  it('should take the root from the ferret the host resolves', async () => {
    // Arrange
    const { pinner, ask } = fixture({ tree: checkout() }, notARepo);

    // Act
    await ask(INDEX);

    // Assert
    should(pinner.pinnedCwds).eql([SESSION_CWD]);
  });

  it('should restate a domain refusal as the status a client can act on', async () => {
    // Arrange
    const { ask } = fixture({ pinError: new FsError('unsupported', 'no pinning here') }, notARepo);

    // Act
    const refusal = await refusalOf(ask(INDEX));

    // Assert
    should(refusal).eql({ status: 501, code: 'unsupported' });
  });

  it('should carry a hung-up caller through to the walk instead of finishing for nobody', async () => {
    // The route contributes exactly one thing the domain cannot know: that the caller stopped waiting.
    // Arrange
    const controller = new AbortController();
    controller.abort();
    const { pinner, ask } = fixture({ tree: checkout() }, notARepo);

    // Act
    const response = await ask(INDEX, { signal: controller.signal });

    // Assert: a partial answer the schema accepts, and not one directory opened to produce it.
    should(response.status).eql(200);
    const body = jsonOf<{ coverage: string; files: unknown[] }>(response);
    should(SessionFileIndexResponseSchema.safeParse(body).success).be.true();
    should(body.coverage).eql('partial');
    should(body.files).be.empty();
    should(pinner.lastRoot.opens).be.empty();
    should(pinner.lastRoot.closed).be.true();
  });
});
