import { describe, it } from 'bun:test';
import {
  type BoardProjectId,
  LANE_TEMPLATES,
  type LaneSet,
  type ProjectInfo,
  type RegisterProjectRequest,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import should from 'should';
import {
  type AdoptionPlaces,
  adoptableRoot,
  expandProjectRoots,
  ProjectAdoption,
  type RepositoryLocation,
  SessionBoardResolver,
  type SessionProjectFacts,
} from '../../../src/lib/board-projects/index.ts';
import { FERRETRY_ID, project } from './support.ts';

const HOME = '/home/owner';

const PLACES: AdoptionPlaces = {
  projectRoots: ['/home/owner/Workspace', '/home/owner/.config'],
  home: HOME,
  scratchRoots: ['/tmp'],
};

const REPOSITORIES: Readonly<Record<string, RepositoryLocation>> = {
  '/home/owner/Workspace/notes': {
    commonDirectory: '/home/owner/Workspace/notes/.git',
    root: '/home/owner/Workspace/notes',
  },
  '/home/owner/Workspace/notes-fix': {
    commonDirectory: '/home/owner/Workspace/notes/.git',
    root: '/home/owner/Workspace/notes',
  },
  '/home/owner/Workspace/ferretry': {
    commonDirectory: '/home/owner/Workspace/ferretry/.git',
    root: '/home/owner/Workspace/ferretry',
  },
  '/home/owner': { commonDirectory: '/home/owner/.git', root: '/home/owner' },
  '/srv/elsewhere': { commonDirectory: '/srv/elsewhere/.git', root: '/srv/elsewhere' },
  '/tmp/try': { commonDirectory: '/tmp/try/.git', root: '/tmp/try' },
};

const laneSet = (projectId: string): LaneSet => ({
  projectId: projectId as BoardProjectId,
  version: 1,
  confirmedBy: null,
  proposedBy: 'lead',
  ...LANE_TEMPLATES.pr,
});

/** Lets every other waiting promise run, so an unserialized pair would interleave here. */
const yieldTurn = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

/** A registry that dedupes on the repository like the file catalog, and yields mid-write like a real one. */
class Registry {
  readonly projects: ProjectInfo[] = [];
  readonly requests: RegisterProjectRequest[] = [];
  private minted = 0;

  async register(request: RegisterProjectRequest): Promise<ProjectInfo> {
    this.requests.push(request);
    const listed = [...this.projects];
    await yieldTurn();
    const common = REPOSITORIES[request.path]?.commonDirectory;
    const found = listed.find(entry => entry.path === request.path || entry.git?.commonDirectory === common);
    if (found !== undefined) return found;
    this.minted += 1;
    const created = project(
      `33333333-3333-4333-8333-33333333333${this.minted}`,
      request.path,
      common === undefined ? undefined : common,
    );
    this.projects.push(created);
    return created;
  }
}

/** One promise chain per key, the way the daemon's keyed serial executor behaves. */
class Serial {
  readonly keys: string[] = [];
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.keys.push(key);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.tails.set(
      key,
      next.catch(() => undefined),
    );
    return await next;
  }
}

const harness = (
  sessions: Readonly<Record<string, SessionProjectFacts>>,
  options: { readonly lanes?: Map<string, LaneSet>; readonly propose?: boolean } = {},
) => {
  const registry = new Registry();
  const lanes = options.lanes ?? new Map<string, LaneSet>();
  const proposals: { projectId: string; sessionId: string }[] = [];
  const stamps: { sessionId: string; projectId: string }[] = [];
  const serial = new Serial();
  const adoption = new ProjectAdoption({
    sessions: { read: async id => sessions[id] ?? null },
    repositories: { locate: async cwd => REPOSITORIES[cwd] ?? null },
    registry,
    lanes: { laneSet: async projectId => lanes.get(projectId) ?? null },
    proposer: {
      propose: async (projectId, sessionId) => {
        proposals.push({ projectId, sessionId });
        await yieldTurn();
        if (options.propose === false) return null;
        const proposed = laneSet(projectId);
        lanes.set(projectId, proposed);
        return proposed;
      },
    },
    stamp: { stamp: async (sessionId, projectId) => void stamps.push({ sessionId, projectId }) },
    places: async () => PLACES,
    serial,
  });
  return { adoption, proposals, registry, serial, stamps };
};

describe('expanding the project roots', () => {
  it('should put `~` and `~/…` under the home folder and leave every other root as written', () => {
    should(expandProjectRoots(['~', '~/Workspace', '/srv/code', 'relative'], HOME)).eql([
      HOME,
      '/home/owner/Workspace',
      '/srv/code',
      'relative',
    ]);
  });
});

describe('which repository root may be registered', () => {
  const at = (root: string, places: AdoptionPlaces = PLACES) =>
    adoptableRoot({ commonDirectory: `${root}/.git`, root }, places);

  it('should register a repository inside a project root, or the root itself', () => {
    should(at('/home/owner/Workspace/notes')).equal('/home/owner/Workspace/notes');
    should(at('/home/owner/.config')).equal('/home/owner/.config');
  });

  it.each([
    { name: 'the home folder', root: HOME },
    { name: 'a folder above home', root: '/home' },
    { name: 'a temp folder, even under a project root', root: '/tmp/Workspace/x' },
    { name: 'a folder outside every project root', root: '/srv/elsewhere' },
    { name: 'a relative root', root: 'Workspace/notes' },
  ])('should leave $name Unfiled', ({ root }) => {
    should(at(root, { ...PLACES, projectRoots: [...PLACES.projectRoots, '/tmp'] })).be.undefined();
  });

  it('should ignore a project root that is not absolute', () => {
    should(at('/home/owner/Workspace/notes', { ...PLACES, projectRoots: ['Workspace'] })).be.undefined();
  });
});

describe('adopting a ferret’s repository', () => {
  it('should register the repository, propose its lanes as the proposer and move the ferret onto its board', async () => {
    // Arrange
    const { adoption, proposals, registry, stamps } = harness({ ferret: { cwd: '/home/owner/Workspace/notes' } });

    // Act
    const adopted = await adoption.adopt('ferret', 'lead');

    // Assert
    const projectId = registry.projects[0]?.id;
    should(registry.requests).eql([{ kind: 'confirmed-discovery', path: '/home/owner/Workspace/notes' }]);
    should(adopted).eql({ projectId, proposed: true });
    should(proposals).eql([{ projectId, sessionId: 'lead' }]);
    should(stamps).eql([{ sessionId: 'ferret', projectId }]);
  });

  it('should register the main checkout for a ferret in a linked worktree, under the repository’s section', async () => {
    // Arrange
    const { adoption, registry, serial } = harness({ ferret: { cwd: '/home/owner/Workspace/notes-fix' } });

    // Act
    await adoption.adopt('ferret');

    // Assert
    should(registry.requests[0]?.path).equal('/home/owner/Workspace/notes');
    should(serial.keys).eql(['project-adoption:/home/owner/Workspace/notes/.git']);
  });

  it('should take a registered project that already has lanes without proposing again', async () => {
    // Arrange
    const lanes = new Map([[FERRETRY_ID, laneSet(FERRETRY_ID)]]);
    const { adoption, proposals, registry, stamps } = harness(
      { ferret: { cwd: '/home/owner/Workspace/ferretry', projectId: UNFILED_PROJECT_ID } },
      { lanes },
    );
    registry.projects.push(
      project(FERRETRY_ID, '/home/owner/Workspace/ferretry', '/home/owner/Workspace/ferretry/.git'),
    );

    // Act
    const adopted = await adoption.adopt('ferret');

    // Assert
    should(adopted).eql({ projectId: FERRETRY_ID, proposed: false });
    should(proposals).be.empty();
    should(stamps).eql([{ sessionId: 'ferret', projectId: FERRETRY_ID }]);
  });

  it('should make one project and one proposal for two ferrets in the same repository at once', async () => {
    // Arrange
    const { adoption, proposals, registry, stamps } = harness({
      first: { cwd: '/home/owner/Workspace/notes' },
      second: { cwd: '/home/owner/Workspace/notes-fix' },
    });

    // Act
    const [first, second] = await Promise.all([adoption.adopt('first'), adoption.adopt('second')]);

    // Assert
    should(registry.projects).have.length(1);
    should(proposals).have.length(1);
    should(first?.projectId).equal(second?.projectId);
    should([first?.proposed, second?.proposed]).eql([true, false]);
    should(stamps.map(stamp => stamp.sessionId)).eql(['first', 'second']);
  });

  it('should leave the ferret Unfiled when no lanes could be proposed', async () => {
    // Arrange
    const { adoption, registry, stamps } = harness(
      { ferret: { cwd: '/home/owner/Workspace/notes' } },
      { propose: false },
    );

    // Act
    const adopted = await adoption.adopt('ferret');

    // Assert
    should(adopted).equal(null);
    should(registry.projects).have.length(1);
    should(stamps).be.empty();
  });

  it.each([
    { name: 'a session this daemon does not know', id: 'missing' },
    { name: 'a ferret already on a real board', id: 'filed' },
    { name: 'a ferret in a folder that is not a repository', id: 'plain' },
    { name: 'a ferret in its home folder’s repository', id: 'home' },
    { name: 'a ferret in a temp folder', id: 'scratch' },
    { name: 'a ferret in a repository outside every project root', id: 'outside' },
  ])('should change nothing for $name', async ({ id }) => {
    // Arrange
    const { adoption, registry, stamps } = harness({
      filed: { cwd: '/home/owner/Workspace/notes', projectId: FERRETRY_ID as BoardProjectId },
      plain: { cwd: '/home/owner/Workspace/loose' },
      home: { cwd: HOME },
      scratch: { cwd: '/tmp/try' },
      outside: { cwd: '/srv/elsewhere' },
    });

    // Act
    const adopted = await adoption.adopt(id);

    // Assert
    should(adopted).equal(null);
    should(registry.requests).be.empty();
    should(stamps).be.empty();
  });
});

describe('re-resolving the board of an Unfiled card’s ferret (SessionBoardResolver over ProjectAdoption)', () => {
  const resolverOver = (sessions: Readonly<Record<string, SessionProjectFacts>>) => {
    const world = harness(sessions);
    const resolver = new SessionBoardResolver(
      { read: async id => sessions[id] ?? null },
      { projectForStart: async () => UNFILED_PROJECT_ID },
      world.adoption,
    );
    return { ...world, resolver };
  };

  it('should register a repository inside a project root, as a ferret’s first card would', async () => {
    // Arrange
    const { resolver, registry, stamps } = resolverOver({ old: { cwd: '/home/owner/Workspace/notes-fix' } });

    // Act
    const board = await resolver.boardOf('old');

    // Assert
    should(board).equal(registry.projects[0]?.id);
    should(registry.requests).eql([{ kind: 'confirmed-discovery', path: '/home/owner/Workspace/notes' }]);
    should(stamps).eql([{ sessionId: 'old', projectId: board }]);
  });

  it.each([
    { name: 'the home folder', cwd: HOME },
    { name: 'a temp folder', cwd: '/tmp/try' },
    { name: 'a repository outside every project root', cwd: '/srv/elsewhere' },
    { name: 'a folder that is not a git repository', cwd: '/home/owner/Workspace/loose' },
  ])('should never register $name, so its card stays Unfiled', async ({ cwd }) => {
    // Arrange
    const { resolver, registry } = resolverOver({ old: { cwd } });

    // Act / Assert
    should(await resolver.boardOf('old')).be.null();
    should(registry.requests).be.empty();
  });

  it('should make one project when two of its ferrets are re-resolved at once', async () => {
    // Arrange
    const { resolver, registry, proposals } = resolverOver({
      left: { cwd: '/home/owner/Workspace/notes' },
      right: { cwd: '/home/owner/Workspace/notes-fix' },
    });

    // Act
    const [left, right] = await Promise.all([resolver.boardOf('left'), resolver.boardOf('right')]);

    // Assert
    should(left).equal(right);
    should(registry.projects).have.length(1);
    should(proposals).have.length(1);
  });
});
