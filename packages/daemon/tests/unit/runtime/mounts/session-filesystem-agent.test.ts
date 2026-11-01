import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import type { StateHomeReach } from '../../../../src/lib/api/state-homes.ts';
import { sessionFilesystemRoutes } from '../../../../src/lib/runtime/index.ts';
import { SessionFilesystem } from '../../../../src/lib/session/filesystem/index.ts';
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
import {
  agentIn,
  CREDENTIALS,
  FERRET_SESSION,
  fromFerret,
  GRANTED,
  human,
  sessionDirectory,
  sessionView,
} from './support.ts';
import { homesOf } from './state-homes-support.ts';

/**
 * The working-tree read for an AGENT caller (docs/agent-tools.md § "Reading a session's files"): a ferret
 * reads its own session and the sub-ferrets it started, nothing else, and never a path inside the daemon's
 * state home — whatever the session's folder is. A person is unchanged.
 */

const HOME = '/home/me/.ferretry';
const USER_HOME = '/home/me';

const homes: StateHomeReach = {
  resolve: async () => homesOf(HOME, `${HOME}/state`, `${HOME}/config`),
  realpath: async path => path,
};

/** The owner's session, the ferret's own, its sub-ferret and that one's sub-ferret, and a sibling. */
const SESSIONS = [
  sessionView('owners'),
  sessionView(FERRET_SESSION),
  sessionView('child', { parent: FERRET_SESSION }),
  sessionView('grandchild', { parent: 'child' }),
  sessionView('sibling', { parent: 'owners' }),
];

const userHomeTree = () =>
  treeOf(
    [
      '',
      directory([
        { name: '.ferretry', type: 'dir' },
        { name: 'notes.md', type: 'file' },
      ]),
    ],
    ['notes.md', textFile('notes\n')],
    ['.ferretry', directory([{ name: 'api-token', type: 'file' }])],
    ['.ferretry/api-token', textFile('fy_admin_secret\n')],
  );

function fixture(
  root: FakeRootOptions = { tree: treeOf(['a.ts', textFile('body\n')]) },
  options: { readonly git?: SessionGitScript; readonly stateHomes?: StateHomeReach | null } = {},
) {
  const pinner = new FakeRootPinner(root);
  const stateHomes = options.stateHomes === null ? undefined : (options.stateHomes ?? homes);
  const routes = sessionFilesystemRoutes(
    new SessionFilesystem(pinner, new FakeSessionGit(options.git)),
    sessionDirectory(SESSIONS),
    id => `${HOME}/state/sessions/${id}/media`,
    stateHomes,
  );
  const dispatcher = new ApiDispatcher(new ApiRouter([...routes]), CREDENTIALS, GRANTED);
  return {
    pinner,
    asFerret: async (asked: Parameters<typeof request>[0]): Promise<ApiResponse> =>
      await dispatcher.dispatch(fromFerret(request(asked))),
    as: async (asked: Parameters<typeof request>[0]): Promise<ApiResponse> => await dispatcher.dispatch(request(asked)),
  };
}

const fileOf = (session: string, path: string, extra: [string, string][] = []) => ({
  path: `/v1/sessions/${session}/fs/file`,
  query: [['path', path], ...extra] as [string, string][],
  headers: human,
});

describe('which session an agent may read', () => {
  it('should let a ferret read its own session, and the sub-ferrets it started however deep', async () => {
    // Arrange
    const { asFerret } = fixture();

    // Act
    const statuses = await Promise.all(
      [FERRET_SESSION, 'child', 'grandchild'].map(async id => (await asFerret(fileOf(id, 'a.ts'))).status),
    );

    // Assert
    should(statuses).eql([200, 200, 200]);
  });

  it("should refuse a ferret the owner's session and a sibling's, on every route, before anything is pinned", async () => {
    // Arrange
    const { asFerret, pinner } = fixture();
    const asks = ['owners', 'sibling'].flatMap(id => [
      fileOf(id, 'a.ts'),
      { path: `/v1/sessions/${id}/fs`, headers: human },
      { path: `/v1/sessions/${id}/fs/index`, headers: human },
      { path: `/v1/sessions/${id}/fs/changes`, headers: human },
      { path: `/v1/sessions/${id}/fs/diff`, query: [['path', 'a.ts']] as [string, string][], headers: human },
    ]);

    // Act
    const responses = await Promise.all(asks.map(async asked => await asFerret(asked)));

    // Assert
    for (const response of responses) {
      should(response.status).eql(403);
      should(jsonBody(response)).have.property('code', 'not_own_session');
    }
    should(pinner.pinnedCwds).eql([]);
  });

  it('should refuse the honest-client agent (the admin token naming its session) a session that is not its own', async () => {
    // Arrange
    const { as } = fixture();

    // Act
    const other = await as({ ...fileOf('owners', 'a.ts'), headers: agentIn(FERRET_SESSION) });
    const own = await as({ ...fileOf(FERRET_SESSION, 'a.ts'), headers: agentIn(FERRET_SESSION) });

    // Assert
    should(other.status).eql(403);
    should(own.status).eql(200);
  });

  it('should leave a person free to read any session, as before', async () => {
    // Arrange
    const { as } = fixture();

    // Act
    const response = await as(fileOf('owners', 'a.ts'));

    // Assert
    should(response.status).eql(200);
  });
});

describe('the state home, for an agent', () => {
  it('should refuse a file inside the state home in a session started in the home folder, and serve the rest', async () => {
    // Arrange: the ferret's session runs in ~, which holds ~/.ferretry.
    const { asFerret, as } = fixture({ rootReal: USER_HOME, tree: userHomeTree() });

    // Act
    const token = await asFerret(fileOf(FERRET_SESSION, '.ferretry/api-token'));
    const notes = await asFerret(fileOf(FERRET_SESSION, 'notes.md'));
    const listing = await asFerret({
      path: `/v1/sessions/${FERRET_SESSION}/fs`,
      query: [['path', '.ferretry']],
      headers: human,
    });
    const person = await as(fileOf(FERRET_SESSION, '.ferretry/api-token'));

    // Assert
    should(token.status).eql(403);
    should(jsonBody(token)).have.property('code', 'denied');
    should(String(jsonBody(token).error)).match(/state home/u);
    should(JSON.stringify(jsonBody(token))).not.match(/fy_admin_secret/u);
    should(notes.status).eql(200);
    should(listing.status).eql(403);
    should(person.status).eql(200);
  });

  it('should mark the home denied in a listing of the folder that holds it', async () => {
    // Arrange
    const { asFerret } = fixture({ rootReal: USER_HOME, tree: userHomeTree() });

    // Act
    const response = await asFerret({ path: `/v1/sessions/${FERRET_SESSION}/fs`, headers: human });

    // Assert
    should(response.status).eql(200);
    const entries = (jsonBody(response) as unknown as { entries: { name: string; denied?: boolean }[] }).entries;
    should(entries.find(entry => entry.name === '.ferretry')?.denied).be.true();
    should(entries.find(entry => entry.name === 'notes.md')?.denied).be.undefined();
  });

  it('should refuse every read of a session whose folder IS the state home, or was swapped for a link into it', async () => {
    // Arrange: the pin resolves the folder, so a link shows as a root inside the home.
    const { asFerret } = fixture({ rootReal: `${HOME}/state`, tree: treeOf(['secrets.key', textFile('key\n')]) });

    // Act
    const read = await asFerret(fileOf(FERRET_SESSION, 'secrets.key'));
    const index = await asFerret({ path: `/v1/sessions/${FERRET_SESSION}/fs/index`, headers: human });

    // Assert
    should(read.status).eql(403);
    should(index.status).eql(403);
  });

  it('should refuse a HEAD read and a diff of a path inside the home, which walk nothing on the disk', async () => {
    // Arrange
    const { asFerret } = fixture(
      { rootReal: USER_HOME, tree: userHomeTree() },
      { git: { readHeadBlob: () => ({ size: 16, bytes: new TextEncoder().encode('fy_admin_secret\n') }) } },
    );

    // Act
    const head = await asFerret(fileOf(FERRET_SESSION, '.ferretry/api-token', [['rev', 'head']]));
    const diff = await asFerret({
      path: `/v1/sessions/${FERRET_SESSION}/fs/diff`,
      query: [['path', '.ferretry/api-token']],
      headers: human,
    });

    // Assert
    should(head.status).eql(403);
    should(diff.status).eql(403);
  });

  it('should leave the home out of the change list and the file index', async () => {
    // Arrange
    const { asFerret } = fixture(
      { rootReal: USER_HOME, tree: userHomeTree() },
      {
        git: {
          changes: () => ({
            repo: true,
            changes: [
              { path: 'notes.md', status: ' M' },
              { path: '.ferretry/api-token', status: ' M' },
            ],
          }),
          listFiles: () => ({ paths: ['notes.md', '.ferretry/api-token'], truncated: false }),
        },
      },
    );

    // Act
    const changes = await asFerret({ path: `/v1/sessions/${FERRET_SESSION}/fs/changes`, headers: human });
    const index = await asFerret({ path: `/v1/sessions/${FERRET_SESSION}/fs/index`, headers: human });

    // Assert
    should((jsonBody(changes) as unknown as { changes: { path: string }[] }).changes.map(c => c.path)).eql([
      'notes.md',
    ]);
    should((jsonBody(index) as unknown as { files: { path: string }[] }).files.map(f => f.path)).eql(['notes.md']);
  });

  it("should still read the ferret's own media folder, the one opening in the home", async () => {
    // Arrange
    const media = `${HOME}/state/sessions/${FERRET_SESSION}/media`;
    const { asFerret } = fixture({ rootReal: media, tree: treeOf(['card.png', textFile('png')]) });

    // Act
    const response = await asFerret(fileOf(FERRET_SESSION, 'card.png', [['scope', 'media']]));

    // Assert
    should(response.status).eql(200);
  });

  it('should refuse a media folder swapped for a link into the rest of the home', async () => {
    // Arrange: the pinned root is where the link leads, not the media folder.
    const { asFerret } = fixture({ rootReal: HOME, tree: treeOf(['api-token', textFile('fy_admin_secret\n')]) });

    // Act
    const response = await asFerret(fileOf(FERRET_SESSION, 'api-token', [['scope', 'media']]));

    // Assert
    should(response.status).eql(403);
  });

  it('should refuse an agent outright when the daemon cannot resolve its state home, and serve a person', async () => {
    // Arrange
    const broken: StateHomeReach = {
      resolve: async () => {
        throw new Error('ENOENT');
      },
      realpath: async () => undefined,
    };
    const unresolved = fixture(undefined, { stateHomes: broken });
    const unwired = fixture(undefined, { stateHomes: null });

    // Act
    const agent = await unresolved.asFerret(fileOf(FERRET_SESSION, 'a.ts'));
    const agentUnwired = await unwired.asFerret(fileOf(FERRET_SESSION, 'a.ts'));
    const person = await unresolved.as(fileOf(FERRET_SESSION, 'a.ts'));

    // Assert
    should(agent.status).eql(503);
    should(jsonBody(agent)).have.property('code', 'state_home_unresolved');
    should(agentUnwired.status).eql(503);
    should(person.status).eql(200);
  });
});

describe('a hard link in a session folder', () => {
  it('should refuse an agent a file with more than one name, and its diff, but serve a person', async () => {
    // Arrange: `twin` is another name for some file — the token, for all the walk can tell.
    const { asFerret, as } = fixture({ tree: treeOf(['twin', textFile('fy_admin_secret\n', { links: 2 })]) });

    // Act
    const read = await asFerret(fileOf(FERRET_SESSION, 'twin'));
    const diff = await asFerret({
      path: `/v1/sessions/${FERRET_SESSION}/fs/diff`,
      query: [['path', 'twin']],
      headers: human,
    });
    const person = await as(fileOf(FERRET_SESSION, 'twin'));

    // Assert
    should([read.status, jsonBody(read).code]).eql([403, 'denied']);
    should(String(jsonBody(read).error)).match(/hard link/u);
    should(JSON.stringify(jsonBody(read))).not.match(/fy_admin_secret/u);
    should(diff.status).eql(403);
    should(person.status).eql(200);
  });
});
