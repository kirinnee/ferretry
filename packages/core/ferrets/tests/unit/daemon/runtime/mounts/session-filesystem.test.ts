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
import { AGENT_READ_FENCE, FsError, SessionFilesystem } from '../../../../../daemon/lib/session/filesystem/index.ts';
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

/** The host's reach as an agent sees it: the same ferret, behind the read fence. */
const agent: FileBrowserDeps['reach'] = async context => ({
  id: context.params.get('ferretId') ?? '',
  cwd: SESSION_CWD,
  fence: AGENT_READ_FENCE,
});

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

  it('R-0151 an agent read of a file holding a vault value is a 403 holds_secret with one fixed sentence, and the disk keeps the real bytes', async () => {
    const text = `const key = "${FIXTURE_SECRET}";\n`;
    const { ask, filesystem } = fixture(
      { tree: treeOf(['a.ts', textFile(text)]) },
      { isTracked: () => true },
      agent,
      withSecret(),
    );

    const refusal = await refusalOf(ask(FILE, { query: { path: 'a.ts' } }));
    const again = await ask(FILE, { query: { path: 'a.ts' } }).catch((error: unknown) => error);
    const internal = await filesystem.readFile(SESSION_CWD, 'a.ts', {});

    should(refusal).eql({ status: 403, code: 'holds_secret' });
    should(again).be.instanceOf(ApiError);
    should((again as ApiError).message).eql('a.ts holds a private value, so it is not served to an agent.');
    should((again as ApiError).message.includes(FIXTURE_SECRET)).be.false();
    should(internal.content === text).be.true();
  });

  it('R-0151 an agent still reads a file that holds no vault value', async () => {
    const { ask } = fixture({ tree: tree() }, { isTracked: () => true }, agent, withSecret());

    const response = await ask(FILE, { query: { path: 'a.ts' } });

    should(response.status).eql(200);
    should(jsonOf(response)).not.have.property('redacted');
  });

  it('R-0151 a person read of a masked file says redacted: true', async () => {
    const { ask } = fixture(
      { tree: treeOf(['a.ts', textFile(FIXTURE_SECRET)]) },
      { isTracked: () => true },
      person,
      withSecret(),
    );

    const response = await ask(FILE, { query: { path: 'a.ts' } });

    should(jsonOf(response)).have.property('redacted', true);
    should(JSON.stringify(response.body).includes(FIXTURE_SECRET)).be.false();
  });

  it('R-0151 a prefix of a vault value is not matched: only the whole value is', async () => {
    const { ask } = fixture(
      { tree: treeOf(['a.ts', textFile(FIXTURE_SECRET.slice(0, -4))]) },
      { isTracked: () => true },
      agent,
      withSecret(),
    );

    const response = await ask(FILE, { query: { path: 'a.ts' } });

    should(response.status).eql(200);
    should(jsonOf(response)).not.have.property('redacted');
  });

  it('R-0150 an agent read of a diff holding a vault value is a 403 holds_secret', async () => {
    const raw = `@@ -1 +1 @@\n-old\n+${FIXTURE_SECRET}\n`;
    const { ask } = fixture(
      { tree: tree() },
      { isTracked: () => true, diffSnapshots: () => ({ diff: raw, truncated: false }) },
      agent,
      withSecret(),
    );

    const refusal = await refusalOf(ask(DIFF, { query: { path: 'a.ts' } }));

    should(refusal).eql({ status: 403, code: 'holds_secret' });
  });

  it('R-0150 an agent diff with 30 astral characters before a value is still a 403 holds_secret', async () => {
    const raw = `@@ -1 +1 @@\n+${'😀'.repeat(30)}${FIXTURE_SECRET}\n`;
    const { ask } = fixture(
      { tree: tree() },
      { isTracked: () => true, diffSnapshots: () => ({ diff: raw, truncated: false }) },
      agent,
      withSecret(),
    );

    const refusal = await refusalOf(ask(DIFF, { query: { path: 'a.ts' } }));

    should(refusal?.status === 403 && refusal?.code === 'holds_secret').be.true();
  });

  it('R-0150 the agent diff refusal is the one sentence naming the path only, never the value', async () => {
    const raw = `@@ -1 +1 @@\n+${FIXTURE_SECRET}\n`;
    const { ask } = fixture(
      { tree: tree() },
      { isTracked: () => true, diffSnapshots: () => ({ diff: raw, truncated: false }) },
      agent,
      withSecret(),
    );

    const message = await ask(DIFF, { query: { path: 'a.ts' } }).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : ''),
    );

    should(message === 'a.ts holds a private value, so it is not served to an agent.').be.true();
    should(message.includes(FIXTURE_SECRET)).be.false();
  });

  it('R-0151 an agent file read gives the same sentence for one value, two values and a repeat', async () => {
    const SECOND_SECRET = 'fixture-second-secret-value-0002';
    const redaction = () =>
      new FakeRedaction(
        new Map([
          [FIXTURE_NAME, FIXTURE_SECRET],
          ['SECOND_FIXTURE' as never, SECOND_SECRET],
        ]),
      );
    const messageFor = async (content: string): Promise<string> => {
      const { ask } = fixture(
        { tree: treeOf(['a.ts', textFile(content)]) },
        { isTracked: () => true },
        agent,
        redaction(),
      );
      return await ask(FILE, { query: { path: 'a.ts' } }).then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : ''),
      );
    };

    const one = await messageFor(`${FIXTURE_SECRET}\n`);
    const two = await messageFor(`${FIXTURE_SECRET}\n${SECOND_SECRET}\n`);
    const repeat = await messageFor(`${FIXTURE_SECRET}\n${FIXTURE_SECRET}\n${SECOND_SECRET}\n`);

    should(one === 'a.ts holds a private value, so it is not served to an agent.').be.true();
    should(two === one && repeat === one).be.true();
    should([one, two, repeat].some(m => m.includes(FIXTURE_SECRET) || m.includes(SECOND_SECRET))).be.false();
  });

  it('R-0151 an agent base64 read of a NUL file holding a value is a 403 holds_secret', async () => {
    const { ask } = fixture(
      { tree: treeOf(['a.bin', textFile(`${FIXTURE_SECRET}\n\0`)]) },
      { isTracked: () => true },
      agent,
      withSecret(),
    );

    const refusal = await refusalOf(ask(FILE, { query: { path: 'a.bin', format: 'base64' } }));

    should(refusal?.status === 403 && refusal?.code === 'holds_secret').be.true();
  });

  it('R-0150 R-0151 astral characters, combining marks and CRLF around a value: masked for a person, 403 for an agent', async () => {
    const shapes = ['😀'.repeat(30), 'e\u0301'.repeat(30), '😀e\u0301'.repeat(10), '\r', '😀\u0301\r'];
    for (const lead of shapes) {
      const body = `${lead}${FIXTURE_SECRET}${lead}\r\n`;
      const raw = `@@ -1 +1 @@\n+${body}`;
      for (const reach of [person, agent]) {
        const { ask } = fixture(
          { tree: treeOf(['a.ts', textFile(body)]) },
          { isTracked: () => true, diffSnapshots: () => ({ diff: raw, truncated: false }) },
          reach,
          withSecret(),
        );
        for (const [key, query] of [
          [FILE, { path: 'a.ts' }],
          [FILE, { path: 'a.ts', format: 'base64' }],
          [DIFF, { path: 'a.ts' }],
        ] as const) {
          if (reach === agent) {
            const refusal = await refusalOf(ask(key, { query }));
            should(refusal?.status === 403 && refusal?.code === 'holds_secret').be.true();
          } else {
            const response = await ask(key, { query });
            const wire = String(response.body);
            const bytes = Buffer.from(
              wire.includes('"base64"') ? String(JSON.parse(String(response.body)).base64) : '',
              'base64',
            );
            should(String(response.body).includes(FIXTURE_SECRET)).be.false();
            should(bytes.toString('latin1').includes(FIXTURE_SECRET)).be.false();
            should(
              (bytes.length > 0 ? bytes.toString('latin1') : String(response.body)).includes(
                '*'.repeat(FIXTURE_SECRET.length),
              ),
            ).be.true();
          }
        }
      }
    }
  });

  it('R-0150 R-0151 a value stored with or without CR, in a CRLF or LF file: masked for a person, 403 for an agent', async () => {
    const stored = [
      `${FIXTURE_SECRET}\r`,
      FIXTURE_SECRET,
      `first-${FIXTURE_SECRET}\r\nsecond-${FIXTURE_SECRET}\r\nthird-${FIXTURE_SECRET}\r`,
      `first-${FIXTURE_SECRET}\nsecond-${FIXTURE_SECRET}\nthird-${FIXTURE_SECRET}`,
    ];
    for (const [value, eol] of stored.flatMap(v => [[v, '\r\n'] as const, [v, '\n'] as const])) {
      // a CRLF file holds every line break as CRLF; an LF file holds the value exactly as it was stored
      const inside = eol === '\r\n' ? value.replace(/\r?\n/g, '\r\n') : value;
      const body = `KEY=${inside}${eol}end${eol}`;
      const raw = `@@ -0,0 +1,2 @@\n${body
        .split('\n')
        .filter(line => line !== '')
        .map(line => `+${line}\n`)
        .join('')}`;
      for (const reach of [person, agent]) {
        const { ask } = fixture(
          { tree: treeOf(['a.ts', textFile(body)]) },
          { isTracked: () => true, diffSnapshots: () => ({ diff: raw, truncated: false }) },
          reach,
          new FakeRedaction(new Map([[FIXTURE_NAME, value]])),
        );
        for (const [key, query] of [
          [FILE, { path: 'a.ts' }],
          [FILE, { path: 'a.ts', format: 'base64' }],
          [DIFF, { path: 'a.ts' }],
        ] as const) {
          if (reach === agent) {
            const refusal = await refusalOf(ask(key, { query }));
            should(refusal?.status === 403 && refusal?.code === 'holds_secret').be.true();
          } else {
            const response = await ask(key, { query });
            const wire = String(response.body);
            const served = wire.includes('"base64"')
              ? Buffer.from(String(JSON.parse(wire).base64), 'base64').toString('utf8')
              : wire;
            should(wire.includes(FIXTURE_SECRET)).be.false();
            should(served.includes(FIXTURE_SECRET)).be.false();
          }
        }
      }
    }
  });

  const HEADING = ['fixture-route-head-a-0020', 'fixture-route-head-b-0021', 'fixture-route-head-c-0022'];

  it('R-0150 a value split between the hunk heading and the leading context: masked for a person, 403 holds_secret for an agent', async () => {
    for (const eol of ['\n', '\r\n']) {
      for (const joiner of ['\n', '\r\n']) {
        const raw = `@@ -3,3 +3,4 @@ KEY=${HEADING[0]}\n ${HEADING[1]}${eol} ${HEADING[2]}${eol} b=2${eol}+c=3${eol}`;
        const redaction = new FakeRedaction(new Map([[FIXTURE_NAME, HEADING.join(joiner)]]));
        const asPerson = fixture(
          { tree: tree() },
          { isTracked: () => true, diffSnapshots: () => ({ diff: raw, truncated: false }) },
          person,
          redaction,
        );
        const served = await asPerson.ask(DIFF, { query: { path: 'a.ts' } });
        const wire = String(served.body);
        should(served.status === 200).be.true();
        should(HEADING.some(line => wire.includes(line))).be.false();
        should(wire.split('\n')[0]?.startsWith('@@ -3,3 +3,4 @@ KEY=*')).be.true();

        const asAgent = fixture(
          { tree: tree() },
          { isTracked: () => true, diffSnapshots: () => ({ diff: raw, truncated: false }) },
          agent,
          redaction,
        );
        const refusal = await refusalOf(asAgent.ask(DIFF, { query: { path: 'a.ts' } }));
        should(refusal?.status === 403 && refusal?.code === 'holds_secret').be.true();
      }
    }
  });

  const CROSS = ['fixture-route-cross-a-0023', 'fixture-route-cross-b-0024', 'fixture-route-cross-c-0025'];

  it('R-0150 a value across one hunk, the next hunk heading and its leading context: masked for a person (covered), 403 holds_secret for an agent', async () => {
    for (const eol of ['\n', '\r\n']) {
      for (const joiner of ['\n', '\r\n']) {
        const cr = eol === '\r\n' ? '\r' : '';
        const raw = [
          '@@ -1,4 +1,4 @@',
          `-a=1${cr}`,
          `+a=9${cr}`,
          ` x2${cr}`,
          ` x3${cr}`,
          ` ${CROSS[0]}${cr}`,
          `@@ -6,6 +6,6 @@ ${CROSS[1]}`,
          ` ${CROSS[2]}${cr}`,
          ` x7${cr}`,
          ` x8${cr}`,
          `-b=2${cr}`,
          `+b=9${cr}`,
          ` x10${cr}`,
          ` x11${cr}`,
          '',
        ].join('\n');
        const redaction = new FakeRedaction(new Map([[FIXTURE_NAME, CROSS.join(joiner)]]));
        const asPerson = fixture(
          { tree: tree() },
          { isTracked: () => true, diffSnapshots: () => ({ diff: raw, truncated: false }) },
          person,
          redaction,
        );
        const served = await asPerson.ask(DIFF, { query: { path: 'a.ts' } });
        const wire = String(served.body);
        should(served.status === 200).be.true();
        should(CROSS.some(line => wire.includes(line))).be.false();
        should(wire.includes('@@ -6,6 +6,6 @@ ***')).be.true();

        const asAgent = fixture(
          { tree: tree() },
          { isTracked: () => true, diffSnapshots: () => ({ diff: raw, truncated: false }) },
          agent,
          redaction,
        );
        const refusal = await refusalOf(asAgent.ask(DIFF, { query: { path: 'a.ts' } }));
        should(refusal?.status === 403 && refusal?.code === 'holds_secret').be.true();
      }
    }
  });

  it('R-0150 an agent diff is refused when either side the service read holds a value, even if the diff shows only part of it', async () => {
    const partial = `@@ -1 +1 @@\n-old\n+new\n`;
    const held = `KEY=${FIXTURE_SECRET}\nrest\n`;
    const head = (text: string) => () => ({ mode: 0o100644, bytes: Buffer.from(text), truncated: false });
    const scripts = [
      { tree: treeOf(['a.ts', textFile(held)]), headEntry: head('plain\n') },
      { tree: tree(), headEntry: head(held) },
    ];
    for (const { tree: files, headEntry } of scripts) {
      const git = { isTracked: () => true, headEntry, diffSnapshots: () => ({ diff: partial, truncated: false }) };
      const asAgent = fixture({ tree: files }, git, agent, withSecret());
      const refusal = await refusalOf(asAgent.ask(DIFF, { query: { path: 'a.ts' } }));
      should(refusal?.status === 403 && refusal?.code === 'holds_secret').be.true();

      const asPerson = fixture({ tree: files }, git, person, withSecret());
      const served = await asPerson.ask(DIFF, { query: { path: 'a.ts' } });
      should(served.status === 200 && String(served.body) === partial).be.true();
    }
  });

  it('R-0150 an agent diff of two sides that hold no value is still served', async () => {
    const partial = `@@ -1 +1 @@\n-old\n+new\n`;
    const { ask } = fixture(
      { tree: tree() },
      {
        isTracked: () => true,
        headEntry: () => ({ mode: 0o100644, bytes: Buffer.from('old\n'), truncated: false }),
        diffSnapshots: () => ({ diff: partial, truncated: false }),
      },
      agent,
      withSecret(),
    );
    const served = await ask(DIFF, { query: { path: 'a.ts' } });
    should(served.status === 200 && String(served.body) === partial).be.true();
  });

  it('R-0151 a value with a trailing CR on a last line with no final newline: masked for a person, 403 for an agent', async () => {
    const lines = ['fixture-route-crlf-a-0023', 'fixture-route-crlf-b-0024', 'fixture-route-crlf-c-0025'];
    const stored = [`${FIXTURE_SECRET}\r`, `${lines.join('\r\n')}\r`];
    const marks = [FIXTURE_SECRET, ...lines];
    for (const value of stored) {
      for (const eol of ['\n', '\r\n']) {
        const inside = value.includes('\r\n') && eol === '\n' ? value.replace(/\r\n/g, '\n') : value;
        for (const prefix of ['head\n', '\0head\n']) {
          const body = `${prefix}KEY=${inside}`;
          const files = { tree: treeOf(['a.ts', textFile(body)]) };
          const redaction = new FakeRedaction(new Map([[FIXTURE_NAME, value]]));
          const reads = [
            ...(prefix === '\0head\n' ? [] : [{ path: 'a.ts' }]),
            { path: 'a.ts', format: 'base64' },
          ] as const;
          for (const query of reads) {
            const asPerson = fixture(files, { isTracked: () => true }, person, redaction);
            const response = await asPerson.ask(FILE, { query });
            const wire = String(response.body);
            const json = JSON.parse(wire) as { content?: string; base64?: string; redacted?: boolean };
            const served =
              json.base64 === undefined ? (json.content ?? '') : Buffer.from(json.base64, 'base64').toString('latin1');
            should(response.status === 200 && json.redacted === true).be.true();
            should(marks.some(mark => served.includes(mark))).be.false();

            const asAgent = fixture(files, { isTracked: () => true }, agent, redaction);
            const refusal = await refusalOf(asAgent.ask(FILE, { query }));
            should(refusal?.status === 403 && refusal?.code === 'holds_secret').be.true();
          }
        }
      }
    }
  });

  it('R-0151 an agent base64 read of valid UTF-8 with a NUL that holds a non-ASCII value is a 403 holds_secret', async () => {
    const value = 'fixture-é-💥-route-0026';
    const files = { tree: treeOf(['a.bin', textFile(`\0KEY=${value}\n`)]) };
    const redaction = new FakeRedaction(new Map([[FIXTURE_NAME, value]]));
    const refusal = await refusalOf(
      fixture(files, { isTracked: () => true }, agent, redaction).ask(FILE, {
        query: { path: 'a.bin', format: 'base64' },
      }),
    );
    should(refusal?.status === 403 && refusal?.code === 'holds_secret').be.true();
    const served = await fixture(files, { isTracked: () => true }, person, redaction).ask(FILE, {
      query: { path: 'a.bin', format: 'base64' },
    });
    const json = JSON.parse(String(served.body)) as { base64: string; redacted?: boolean };
    should(json.redacted === true).be.true();
    should(Buffer.from(json.base64, 'base64').toString('utf8').includes(value)).be.false();
  });

  it('R-0150 an agent still reads a diff that holds no vault value', async () => {
    const { ask } = fixture(
      { tree: tree() },
      { isTracked: () => true, diffSnapshots: () => ({ diff: '@@ -1 +1 @@\n+x\n', truncated: false }) },
      agent,
      withSecret(),
    );

    should((await ask(DIFF, { query: { path: 'a.ts' } })).status).eql(200);
  });

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
