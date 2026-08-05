import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import { sessionFilesystemRoutes } from '../../../../src/lib/runtime/index.ts';
import { FsError, SessionFilesystem } from '../../../../src/lib/session/filesystem/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import {
  directory,
  type FakeRootOptions,
  FakeRootPinner,
  FakeSessionGit,
  type SessionGitScript,
  textFile,
  treeOf,
} from '../../session/filesystem/support.ts';
import { CREDENTIALS, human, sessionDirectory, sessionView } from './support.ts';

/**
 * The HTTP shape of the working-tree read.
 *
 * Three things are asserted that the domain cannot assert for itself: the cwd comes from the session
 * DOCUMENT rather than from anything a caller sent, every refusal arrives as a status a client can act on,
 * and no response is cacheable.
 */

const SESSION_CWD = '/work/ferretry';

/** The warden-scoped token, which must never reach this surface. */
const wardenToken = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

function fixture(root: FakeRootOptions = {}, git: SessionGitScript = {}) {
  const filesystem = new SessionFilesystem(new FakeRootPinner(root), new FakeSessionGit(git));
  const routes = sessionFilesystemRoutes(filesystem, sessionDirectory([sessionView('s1')]));
  const dispatcher = new ApiDispatcher(new ApiRouter([...routes]), CREDENTIALS);
  return async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
    await dispatcher.dispatch(request(overrides));
}

const tree = () => treeOf(['', directory([{ name: 'a.ts', type: 'file' }])], ['a.ts', textFile('body\n')]);

describe('the working-tree listing route', () => {
  it('should list the session root from the cwd the session document names', async () => {
    // Arrange
    const pinner = new FakeRootPinner({ tree: tree() });
    const routes = sessionFilesystemRoutes(
      new SessionFilesystem(pinner, new FakeSessionGit()),
      sessionDirectory([sessionView('s1')]),
    );
    const dispatch = new ApiDispatcher(new ApiRouter([...routes]), CREDENTIALS);

    // Act
    const response = await dispatch.dispatch(request({ path: '/v1/sessions/s1/fs', headers: human }));

    // Assert
    should(response.status).eql(200);
    should(pinner.pinnedCwds).eql([SESSION_CWD]);
    should(jsonBody(response)).have.property('entries');
    should(response.headers.get('cache-control')).eql('no-store');
  });

  it('should list a subdirectory named by the path parameter', async () => {
    // Arrange
    const dispatch = fixture({ tree: treeOf(['src', directory([{ name: 'b.ts', type: 'file' }])]) });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs', query: [['path', 'src']], headers: human });

    // Assert
    should(response.status).eql(200);
    should(jsonBody(response)).have.property('path', 'src');
  });

  it('should refuse a session the daemon does not hold', async () => {
    // Arrange
    const dispatch = fixture({ tree: tree() });

    // Act
    const response = await dispatch({ path: '/v1/sessions/absent/fs', headers: human });

    // Assert
    should(response.status).eql(404);
    should(jsonBody(response)).have.property('code', 'not-found');
  });

  it('should refuse a path session id that decodes to a traversal step', async () => {
    // Arrange
    const dispatch = fixture({ tree: tree() });

    // Act
    const response = await dispatch({ path: '/v1/sessions/%2e%2e/fs', headers: human });

    // Assert
    should(response.status).eql(400);
    should(jsonBody(response)).have.property('code', 'invalid_session_id');
  });

  it('should refuse to enumerate a denied directory with a 403', async () => {
    // Arrange
    const dispatch = fixture({ tree: treeOf(['.git', directory([])]) });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs', query: [['path', '.git']], headers: human });

    // Assert
    should(response.status).eql(403);
    should(jsonBody(response)).have.property('code', 'denied');
  });

  it('should report a failure that is NOT a domain refusal as a server fault', async () => {
    // Arrange: a genuine bug must not be reported as the client's mistake.
    const dispatch = fixture({ pinError: new TypeError('a genuine bug') });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs', headers: human });

    // Assert
    should(response.status).eql(500);
  });

  it('should never be readable by the warden, which has no business in the human source tree', async () => {
    // Arrange
    const dispatch = fixture({ tree: tree() });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs', headers: wardenToken });

    // Assert
    should(response.status).eql(403);
  });
});

describe('the file route', () => {
  it('should serve a file view with its content', async () => {
    // Arrange
    const dispatch = fixture({ tree: tree() });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs/file', query: [['path', 'a.ts']], headers: human });

    // Assert
    should(response.status).eql(200);
    should(jsonBody(response)).have.property('content', 'body\n');
  });

  it('should serve the committed bytes when asked for the head revision', async () => {
    // Arrange
    const dispatch = fixture(
      { tree: tree() },
      { readHeadBlob: () => ({ size: 4, bytes: new TextEncoder().encode('old\n') }) },
    );

    // Act
    const response = await dispatch({
      path: '/v1/sessions/s1/fs/file',
      query: [
        ['path', 'a.ts'],
        ['rev', 'head'],
      ],
      headers: human,
    });

    // Assert
    should(jsonBody(response)).match({ content: 'old\n', rev: 'head' });
  });

  it('serves a bounded, policy-gated base64 representation only when explicitly requested', async () => {
    const dispatch = fixture({ tree: treeOf(['photo.png', textFile('\u0000\u0001png')]) });

    const response = await dispatch({
      path: '/v1/sessions/s1/fs/file',
      query: [
        ['path', 'photo.png'],
        ['format', 'base64'],
      ],
      headers: human,
    });

    should(response.status).eql(200);
    should(jsonBody(response)).match({ path: 'photo.png', base64: 'AAFwbmc=' });
    should(response.headers.get('cache-control')).eql('no-store');
  });

  it('refuses an unknown file representation rather than quietly serving another one', async () => {
    const dispatch = fixture({ tree: tree() });
    const response = await dispatch({
      path: '/v1/sessions/s1/fs/file',
      query: [
        ['path', 'a.ts'],
        ['format', 'raw'],
      ],
      headers: human,
    });

    should(response.status).eql(400);
    should(jsonBody(response)).have.property('code', 'invalid_format');
  });

  it('should require the path parameter rather than defaulting to the root', async () => {
    // Arrange
    const dispatch = fixture({ tree: tree() });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs/file', headers: human });

    // Assert
    should(response.status).eql(400);
    should(jsonBody(response)).have.property('code', 'invalid_path');
  });

  it('should refuse an unknown revision rather than quietly serving the working tree', async () => {
    // Arrange
    const dispatch = fixture({ tree: tree() });

    // Act
    const response = await dispatch({
      path: '/v1/sessions/s1/fs/file',
      query: [
        ['path', 'a.ts'],
        ['rev', 'main'],
      ],
      headers: human,
    });

    // Assert
    should(response.status).eql(400);
    should(jsonBody(response)).have.property('code', 'invalid_rev');
  });

  it('should answer a denied path with a 200 and a badge, because that IS the view', async () => {
    // Arrange
    const dispatch = fixture({ tree: treeOf(['.env', textFile('TOKEN=1')]) });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs/file', query: [['path', '.env']], headers: human });

    // Assert
    should(response.status).eql(200);
    should(jsonBody(response)).match({ denied: true, reason: 'denylist' });
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
      const dispatch = fixture({ tree: treeOf(['a.ts', { error }]) });
      const response = await dispatch({ path: '/v1/sessions/s1/fs/file', query: [['path', 'a.ts']], headers: human });
      should(response.status).eql(status);
      should(jsonBody(response)).have.property('code', error.code);
    }
  });

  it('should let a non-domain failure become a server error rather than the client’s fault', async () => {
    // Arrange
    const dispatch = fixture(
      { tree: tree() },
      {
        ignoredPaths: () => {
          throw new TypeError('a genuine bug');
        },
      },
    );

    // Act: the domain fails CLOSED on a Git failure, so this reaches the route as an ignore refusal.
    const response = await dispatch({ path: '/v1/sessions/s1/fs/file', query: [['path', 'a.ts']], headers: human });

    // Assert
    should(response.status).eql(200);
    should(jsonBody(response)).have.property('ignored', true);
  });
});

describe('the changes route', () => {
  it('should serve the change list', async () => {
    // Arrange
    const dispatch = fixture(
      { tree: tree() },
      { changes: () => ({ repo: true, branch: 'main', changes: [{ path: 'a.ts', status: ' M' }] }) },
    );

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs/changes', headers: human });

    // Assert
    should(response.status).eql(200);
    should(jsonBody(response)).match({ repo: true, branch: 'main' });
    should(response.headers.get('cache-control')).eql('no-store');
  });

  it('should surface a pinner refusal as its own status', async () => {
    // Arrange
    const dispatch = fixture({ pinError: new FsError('denied', 'session cwd is not served') });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs/changes', headers: human });

    // Assert
    should(response.status).eql(403);
    should(jsonBody(response)).have.property('code', 'denied');
  });
});

describe('the diff route', () => {
  it('should serve the diff as plain text', async () => {
    // Arrange
    const dispatch = fixture(
      { tree: tree() },
      { isTracked: () => true, diffSnapshots: () => ({ diff: 'DIFF BODY', truncated: false }) },
    );

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs/diff', query: [['path', 'a.ts']], headers: human });

    // Assert
    should(response.status).eql(200);
    should(response.body).eql('DIFF BODY');
    should(response.headers.get('content-type')).match(/text\/plain/);
    should(response.headers.get('cache-control')).eql('no-store');
  });

  it('should require the path parameter', async () => {
    // Arrange
    const dispatch = fixture({ tree: tree() });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs/diff', headers: human });

    // Assert
    should(response.status).eql(400);
  });

  it('should refuse a denied diff with a 403, since the body has nowhere to carry a badge', async () => {
    // Arrange
    const dispatch = fixture({ tree: treeOf(['.env', textFile('TOKEN=1')]) }, { isTracked: () => true });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs/diff', query: [['path', '.env']], headers: human });

    // Assert
    should(response.status).eql(403);
    should(jsonBody(response)).have.property('code', 'denied');
  });

  it('should refuse an ignored diff with a 403 and its own code', async () => {
    // Arrange
    const dispatch = fixture({ tree: treeOf(['out.js', textFile('x')]) }, { ignoredPaths: () => new Set(['out.js']) });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs/diff', query: [['path', 'out.js']], headers: human });

    // Assert
    should(response.status).eql(403);
    should(jsonBody(response)).have.property('code', 'ignored');
  });

  it('should refuse a TRUNCATED diff, because a partial one misleads a reviewer', async () => {
    // Arrange
    const dispatch = fixture(
      { tree: treeOf(['a.ts', textFile('x')]) },
      { isTracked: () => true, diffSnapshots: () => ({ diff: 'PARTIAL', truncated: true }) },
    );

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs/diff', query: [['path', 'a.ts']], headers: human });

    // Assert
    should(response.status).eql(413);
    should(jsonBody(response)).have.property('code', 'too_large');
  });

  it('should surface a containment refusal as a 403', async () => {
    // Arrange
    const dispatch = fixture({
      tree: treeOf(['link', { error: new FsError('escapes_root', 'path escapes the session root: link') }]),
    });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/fs/diff', query: [['path', 'link']], headers: human });

    // Assert
    should(response.status).eql(403);
    should(jsonBody(response)).have.property('code', 'escapes_root');
  });
});
