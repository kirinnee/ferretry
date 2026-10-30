import { describe, it } from 'bun:test';
import { type BoardProjectId, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import should from 'should';
import {
  MAX_PARENT_CHAIN,
  type ProjectRegistry,
  type RepositoryProbe,
  type SessionProjectFactSource,
  type SessionProjectFacts,
  SessionProjects,
} from '../../../src/lib/board-projects/index.ts';
import { DOCS_ID, FERRETRY_ID, project } from './support.ts';

const PROJECTS = [project(FERRETRY_ID, '/work/ferretry', '/work/ferretry/.git'), project(DOCS_ID, '/work/docs')];

class Sessions implements SessionProjectFactSource {
  readonly reads: string[] = [];
  constructor(private readonly facts: Readonly<Record<string, SessionProjectFacts>>) {}
  async read(sessionId: string): Promise<SessionProjectFacts | null> {
    this.reads.push(sessionId);
    return this.facts[sessionId] ?? null;
  }
}

const registry: ProjectRegistry = { projects: async () => PROJECTS };
const repositories: RepositoryProbe = {
  commonDirectory: async cwd => (cwd.startsWith('/worktrees/ferretry') ? '/work/ferretry/.git' : null),
};

const subject = (facts: Record<string, SessionProjectFacts> = {}) => {
  const sessions = new Sessions(facts);
  return { sessions, projects: new SessionProjects(sessions, registry, repositories, ['/tmp']) };
};

describe('SessionProjects.projectForStart', () => {
  it('should resolve a start without a parent from its cwd', async () => {
    const { projects, sessions } = subject();

    should(await projects.projectForStart({ cwd: '/work/docs/guide' })).equal(DOCS_ID);
    should(await projects.projectForStart({ cwd: '/worktrees/ferretry-x' })).equal(FERRETRY_ID);
    should(await projects.projectForStart({ cwd: '/nowhere' })).equal(UNFILED_PROJECT_ID);
    should(sessions.reads).deepEqual([]);
  });

  it('should inherit the stamped board of a parent working in a scratch folder', async () => {
    const { projects } = subject({ parent: { cwd: '/work/docs', projectId: DOCS_ID } });

    should(await projects.projectForStart({ cwd: '/tmp/try', parent: 'parent' })).equal(DOCS_ID);
  });

  it('should treat an unknown parent as no parent', async () => {
    const { projects } = subject();

    should(await projects.projectForStart({ cwd: '/work/docs', parent: 'ghost' })).equal(DOCS_ID);
  });
});

describe('SessionProjects.projectOf', () => {
  it('should answer unfiled for a session it does not know', async () => {
    should(await subject().projects.projectOf('ghost')).equal(UNFILED_PROJECT_ID);
  });

  it('should answer the stamped board without resolving anything', async () => {
    const { projects, sessions } = subject({ s1: { cwd: '/nowhere', parent: 'p', projectId: FERRETRY_ID } });

    should(await projects.projectOf('s1')).equal(FERRETRY_ID);
    should(sessions.reads).deepEqual(['s1']);
  });

  it('should resolve an unstamped session from its cwd and parent chain', async () => {
    const { projects } = subject({
      old: { cwd: '/tmp/x', parent: 'mid' },
      mid: { cwd: '/tmp/y', parent: 'root' },
      root: { cwd: '/work/docs/a' },
    });

    should(await projects.projectOf('old')).equal(DOCS_ID);
  });

  it('should stop at a cycle in the parent chain', async () => {
    const { projects } = subject({
      a: { cwd: '/work/docs', parent: 'b' },
      b: { cwd: '/work/ferretry', parent: 'a' },
    });

    should(await projects.projectOf('a')).equal(DOCS_ID);
  });

  it('should stop following a chain longer than the bound', async () => {
    const facts: Record<string, SessionProjectFacts> = {};
    const length = MAX_PARENT_CHAIN + 4;
    for (let index = 0; index < length; index += 1) {
      facts[`s${String(index)}`] =
        index === length - 1
          ? { cwd: '/tmp/z', projectId: FERRETRY_ID }
          : { cwd: '/tmp/z', parent: `s${String(index + 1)}` };
    }
    const { projects, sessions } = subject(facts);

    const board: BoardProjectId = await projects.projectOf('s0');

    should(board).equal(UNFILED_PROJECT_ID);
    should(sessions.reads.length).be.belowOrEqual(MAX_PARENT_CHAIN + 1);
  });
});
