import { describe, it } from 'bun:test';

import { type BoardProjectId, UNFILED_PROJECT_ID } from '../../../contract/index.ts';
import should from 'should';
import {
  MAX_PARENT_CHAIN,
  type ProjectRegistry,
  type RepositoryProbe,
  type FerretProjectFactSource,
  type FerretProjectFacts,
  FerretProjects,
} from '../../../daemon/lib/lanes/index.ts';
import { DOCS_ID, FERRETRY_ID, project } from './support.ts';

const PROJECTS = [project(FERRETRY_ID, '/work/ferretry', '/work/ferretry/.git'), project(DOCS_ID, '/work/docs')];

class Sessions implements FerretProjectFactSource {
  readonly reads: string[] = [];
  constructor(private readonly facts: Readonly<Record<string, FerretProjectFacts>>) {}
  async read(ferretId: string): Promise<FerretProjectFacts | null> {
    this.reads.push(ferretId);
    return this.facts[ferretId] ?? null;
  }
}

const registry: ProjectRegistry = { projects: async () => PROJECTS };
const repositories: RepositoryProbe = {
  commonDirectory: async folder => (folder.startsWith('/worktrees/ferretry') ? '/work/ferretry/.git' : null),
};

const subject = (facts: Record<string, FerretProjectFacts> = {}) => {
  const sessions = new Sessions(facts);
  return { sessions, projects: new FerretProjects(sessions, registry, repositories, ['/tmp']) };
};

describe('FerretProjects.projectForStart', () => {
  it('should resolve a start without a parent from its folder', async () => {
    const { projects, sessions } = subject();

    should(await projects.projectForStart({ folder: '/work/docs/guide' })).equal(DOCS_ID);
    should(await projects.projectForStart({ folder: '/worktrees/ferretry-x' })).equal(FERRETRY_ID);
    should(await projects.projectForStart({ folder: '/nowhere' })).equal(UNFILED_PROJECT_ID);
    should(sessions.reads).deepEqual([]);
  });

  it('should inherit the stamped board of a parent working in a scratch folder', async () => {
    const { projects } = subject({ parent: { folder: '/work/docs', projectId: DOCS_ID } });

    should(await projects.projectForStart({ folder: '/tmp/try', parent: 'parent' })).equal(DOCS_ID);
  });

  it('should treat an unknown parent as no parent', async () => {
    const { projects } = subject();

    should(await projects.projectForStart({ folder: '/work/docs', parent: 'ghost' })).equal(DOCS_ID);
  });
});

describe('FerretProjects.projectOf', () => {
  it('should answer unfiled for a session it does not know', async () => {
    should(await subject().projects.projectOf('ghost')).equal(UNFILED_PROJECT_ID);
  });

  it('should answer the stamped board without resolving anything', async () => {
    const { projects, sessions } = subject({ s1: { folder: '/nowhere', parent: 'p', projectId: FERRETRY_ID } });

    should(await projects.projectOf('s1')).equal(FERRETRY_ID);
    should(sessions.reads).deepEqual(['s1']);
  });

  it('should resolve an unstamped session from its folder and parent chain', async () => {
    const { projects } = subject({
      old: { folder: '/tmp/x', parent: 'mid' },
      mid: { folder: '/tmp/y', parent: 'root' },
      root: { folder: '/work/docs/a' },
    });

    should(await projects.projectOf('old')).equal(DOCS_ID);
  });

  it('should stop at a cycle in the parent chain', async () => {
    const { projects } = subject({
      a: { folder: '/work/docs', parent: 'b' },
      b: { folder: '/work/ferretry', parent: 'a' },
    });

    should(await projects.projectOf('a')).equal(DOCS_ID);
  });

  it('should stop following a chain longer than the bound', async () => {
    const facts: Record<string, FerretProjectFacts> = {};
    const length = MAX_PARENT_CHAIN + 4;
    for (let index = 0; index < length; index += 1) {
      facts[`s${String(index)}`] =
        index === length - 1
          ? { folder: '/tmp/z', projectId: FERRETRY_ID }
          : { folder: '/tmp/z', parent: `s${String(index + 1)}` };
    }
    const { projects, sessions } = subject(facts);

    const board: BoardProjectId = await projects.projectOf('s0');

    should(board).equal(UNFILED_PROJECT_ID);
    should(sessions.reads.length).be.belowOrEqual(MAX_PARENT_CHAIN + 1);
  });
});
