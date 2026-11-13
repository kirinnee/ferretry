import { describe, it } from 'bun:test';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import { ApiError, type ApiResponse } from '@ferretry/kernel/contract';
import should from 'should';
import {
  type FileBrowserDeps,
  type FileBrowserRouteKey,
  sessionFilesystemRoutes,
} from '../../../../../daemon/lib/runtime/mounts/session-filesystem.ts';
import {
  AGENT_READ_FENCE,
  SessionFilesystem,
  type SessionReadFence,
} from '../../../../../daemon/lib/session/filesystem/index.ts';
import { type RequestOf, jsonOf, requestOf } from '../../support/requests.ts';
import {
  directory,
  type FakeFence,
  type FakeRootOptions,
  FakeRootPinner,
  FakeSessionGit,
  type SessionGitScript,
  textFile,
  treeOf,
} from '../../session/filesystem/support.ts';

/**
 * The working-tree read for an AGENT caller (docs/agent-tools.md § "Reading a session's files"): never a path inside
 * the daemon's state home — whatever the session's folder is. A person is unchanged.
 *
 * WHICH fence an agent reads behind (and which ferrets it may read at all) is the host's `reach`; here a fake reach
 * hands the routes a fence, and these cases prove each of the four routes carries it to the domain.
 */

const HOME = '/home/me/.ferretry';
const USER_HOME = '/home/me';

/**
 * The fake world's state home, standing in for the kernel's fence (today's `homesPinned`): each home its own directory
 * on device 1, inodes from 1.
 */
const HOME_FENCE: FakeFence = {
  homes: [HOME, `${HOME}/state`, `${HOME}/config`],
  identities: [1n, 2n, 3n].map(ino => ({ dev: 1n, ino })),
};

const FENCE: SessionReadFence = AGENT_READ_FENCE;

const LIST = 'GET /v1/ferrets/:ferretId/fs';
const INDEX = 'GET /v1/ferrets/:ferretId/fs/index';
const CHANGES = 'GET /v1/ferrets/:ferretId/fs/changes';
const DIFF = 'GET /v1/ferrets/:ferretId/fs/diff';

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

type Ask = Omit<RequestOf, 'method' | 'path' | 'params'>;

function fixture(root: FakeRootOptions = { tree: treeOf(['a.ts', textFile('body\n')]) }, git: SessionGitScript = {}) {
  const pinner = new FakeRootPinner({ fence: HOME_FENCE, ...root });
  const filesystem = new SessionFilesystem(pinner, new FakeSessionGit(git));
  const routesFor = (fence?: SessionReadFence) => {
    const reach: FileBrowserDeps['reach'] = async () => ({
      id: 'mine',
      cwd: '/work/mine',
      ...(fence === undefined ? {} : { fence }),
    });
    return sessionFilesystemRoutes({ filesystem, reach, redaction: new FakeRedaction(new Map()) });
  };
  const agent = routesFor(FENCE);
  const human = routesFor();
  const call =
    (routes: ReturnType<typeof routesFor>) =>
    async (key: FileBrowserRouteKey, spec: Ask = {}): Promise<ApiResponse> =>
      await routes[key](requestOf({ ...spec, params: { ferretId: 'mine' } }));
  return { pinner, asFerret: call(agent), as: call(human) };
}

/** The status a call answered with: 200, or the refusal it threw. */
async function statusOf(work: Promise<ApiResponse>): Promise<number> {
  try {
    return (await work).status;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
}

describe('the state home, for an agent', () => {
  it('should refuse a listing inside the state home in a session started in the home folder', async () => {
    // Arrange: the ferret's session runs in ~, which holds ~/.ferretry.
    const { asFerret } = fixture({ rootReal: USER_HOME, tree: userHomeTree() });

    // Act
    const listing = await statusOf(asFerret(LIST, { query: { path: '.ferretry' } }));

    // Assert
    should(listing).eql(403);
  });

  it('should mark the home denied in a listing of the folder that holds it', async () => {
    // Arrange
    const { asFerret } = fixture({ rootReal: USER_HOME, tree: userHomeTree() });

    // Act
    const response = await asFerret(LIST);

    // Assert
    should(response.status).eql(200);
    const entries = jsonOf<{ entries: { name: string; denied?: boolean }[] }>(response).entries;
    should(entries.find(entry => entry.name === '.ferretry')?.denied).be.true();
    should(entries.find(entry => entry.name === 'notes.md')?.denied).be.undefined();
  });

  it('should refuse the index of a session whose folder IS the state home, or was swapped for a link into it', async () => {
    // Arrange: the pin resolves the folder, so a link shows as a root inside the home.
    const { asFerret } = fixture({ rootReal: `${HOME}/state`, tree: treeOf(['secrets.key', textFile('key\n')]) });

    // Act
    const index = await statusOf(asFerret(INDEX));

    // Assert
    should(index).eql(403);
  });

  it('should refuse a diff of a path inside the home, which walks nothing on the disk', async () => {
    // Arrange
    const { asFerret } = fixture(
      { rootReal: USER_HOME, tree: userHomeTree() },
      { readHeadBlob: () => ({ size: 16, bytes: new TextEncoder().encode('fy_admin_secret\n') }) },
    );

    // Act
    const diff = await statusOf(asFerret(DIFF, { query: { path: '.ferretry/api-token' } }));

    // Assert
    should(diff).eql(403);
  });

  it('should leave the home out of the change list and the file index', async () => {
    // Arrange
    const { asFerret } = fixture(
      { rootReal: USER_HOME, tree: userHomeTree() },
      {
        changes: () => ({
          repo: true,
          changes: [
            { path: 'notes.md', status: ' M' },
            { path: '.ferretry/api-token', status: ' M' },
          ],
        }),
        listFiles: () => ({ paths: ['notes.md', '.ferretry/api-token'], truncated: false }),
      },
    );

    // Act
    const changes = await asFerret(CHANGES);
    const index = await asFerret(INDEX);

    // Assert
    should(jsonOf<{ changes: { path: string }[] }>(changes).changes.map(c => c.path)).eql(['notes.md']);
    should(jsonOf<{ files: { path: string }[] }>(index).files.map(f => f.path)).eql(['notes.md']);
  });
});

describe('a hard link in a session folder', () => {
  it("should refuse an agent a file with more than one name's diff", async () => {
    // Arrange: `twin` is another name for some file — the token, for all the walk can tell.
    const { asFerret } = fixture({ tree: treeOf(['twin', textFile('fy_admin_secret\n', { links: 2 })]) });

    // Act
    const diff = await statusOf(asFerret(DIFF, { query: { path: 'twin' } }));

    // Assert
    should(diff).eql(403);
  });
});

describe('secrev-1260 M1 — the home by identity, not only by name', () => {
  /** A walk component: the root's own (100), the home's (device 1, inode 1, as `homesPinned` makes it), or any other. */
  const component = (ino: number, dev = 1) => ({
    dev: BigInt(dev),
    ino: BigInt(ino),
    ctimeNs: 1_000_000_000n,
    mode: 0o40755,
  });
  const ROOT = component(100);
  const HOME_ITSELF = component(1);

  /** `~` on a case-insensitive disk: `.FERRETRY` is not the home's name, but it IS the home. */
  const folded = () =>
    treeOf(
      [
        '',
        directory([
          { name: '.FERRETRY', type: 'dir' },
          { name: 'notes.md', type: 'file' },
        ]),
      ],
      ['notes.md', textFile('notes\n')],
      ['.FERRETRY', { ...directory([{ name: 'api-token', type: 'file' }]), identities: [ROOT, HOME_ITSELF] }],
      ['.FERRETRY/api-token', textFile('fy_admin_secret\n', { identities: [ROOT, HOME_ITSELF, component(102)] })],
    );

  it('should refuse a listing that spells the home another way, when the walk opens the home itself', async () => {
    // Arrange
    const { asFerret } = fixture({ rootReal: USER_HOME, tree: folded() });

    // Act
    const listing = await statusOf(asFerret(LIST, { query: { path: '.FERRETRY' } }));

    // Assert
    should(listing).eql(403);
  });

  it('should refuse a listing of a session folder that IS the home under another name, as a bind mount is', async () => {
    // Arrange
    const tree = treeOf(['a.ts', textFile('body\n')]);
    tree.set('', { ...directory([{ name: 'a.ts', type: 'file' }]), identities: [HOME_ITSELF] });
    const { asFerret } = fixture({ rootReal: '/mnt/elsewhere', tree });

    // Act
    const list = await statusOf(asFerret(LIST));

    // Assert
    should(list).eql(403);
  });

  it('should leave a name in the home by identity out of the file index', async () => {
    // Arrange
    const { asFerret } = fixture(
      { rootReal: USER_HOME, tree: folded() },
      { listFiles: () => ({ paths: ['.FERRETRY/api-token', 'notes.md'], truncated: false }) },
    );

    // Act
    const index = await asFerret(INDEX);

    // Assert
    should(jsonOf<{ files: { path: string }[] }>(index).files.map(f => f.path)).eql(['notes.md']);
  });
});

describe('the file index for an agent, in ordinary folders', () => {
  it('should keep a name whose folder the walk proves is not the home', async () => {
    // Arrange: a tracked file one folder down, in a session folder well away from the home.
    const { asFerret } = fixture(
      {
        tree: treeOf(
          ['src', directory([{ name: 'a.ts', type: 'file' }])],
          ['src/a.ts', textFile('body\n')],
          ['src/b.ts', textFile('body\n')],
        ),
      },
      { listFiles: () => ({ paths: ['src/a.ts', 'src/b.ts'], truncated: false }) },
    );

    // Act
    const index = await asFerret(INDEX);

    // Assert: both kept, the folder walked once for the two of them.
    should(jsonOf<{ files: { path: string }[] }>(index).files.map(f => f.path)).eql(['src/a.ts', 'src/b.ts']);
  });
});
