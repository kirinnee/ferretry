import { describe, it } from 'bun:test';
import { type BoardProjectId, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import should from 'should';
import { SessionBoardResolver, type SessionProjectFacts } from '../../../src/lib/board-projects/index.ts';
import { DOCS_ID, FERRETRY_ID } from './support.ts';

/** A resolver over fixed facts, recording what it resolved and adopted. */
const resolverWith = (
  facts: Readonly<Record<string, SessionProjectFacts>>,
  resolves: Readonly<Record<string, BoardProjectId>> = {},
  adopts: Readonly<Record<string, BoardProjectId>> = {},
) => {
  const resolved: { cwd: string; parent?: string }[] = [];
  const adopted: string[] = [];
  const resolver = new SessionBoardResolver(
    { read: async sessionId => facts[sessionId] ?? null },
    {
      projectForStart: async start => {
        resolved.push(start);
        return resolves[start.cwd] ?? UNFILED_PROJECT_ID;
      },
    },
    {
      adopt: async sessionId => {
        adopted.push(sessionId);
        const projectId = adopts[sessionId];
        return projectId === undefined ? null : { projectId, proposed: true };
      },
    },
  );
  return { resolver, resolved, adopted };
};

describe('SessionBoardResolver', () => {
  it('should answer with the board a session was stamped with, when that is a project’s', async () => {
    // Arrange
    const subject = resolverWith({ lead: { cwd: '/work/ferretry', projectId: FERRETRY_ID } });

    // Act / Assert
    should(await subject.resolver.boardOf('lead')).equal(FERRETRY_ID);
    should(subject.resolved).be.empty();
    should(subject.adopted).be.empty();
  });

  it('should resolve the folder again for a session stamped Unfiled or not stamped at all, parent included', async () => {
    // Arrange
    const subject = resolverWith(
      {
        old: { cwd: '/work/ferretry', projectId: UNFILED_PROJECT_ID },
        child: { cwd: '/tmp/scratch', parent: 'lead' },
      },
      { '/work/ferretry': FERRETRY_ID, '/tmp/scratch': DOCS_ID },
    );

    // Act / Assert
    should(await subject.resolver.boardOf('old')).equal(FERRETRY_ID);
    should(await subject.resolver.boardOf('child')).equal(DOCS_ID);
    should(subject.resolved).deepEqual([{ cwd: '/work/ferretry' }, { cwd: '/tmp/scratch', parent: 'lead' }]);
    should(subject.adopted).be.empty();
  });

  it('should register the repository a session stands in when no project has it yet', async () => {
    // Arrange
    const subject = resolverWith({ ferret: { cwd: '/work/new-repo' } }, {}, { ferret: DOCS_ID });

    // Act / Assert
    should(await subject.resolver.boardOf('ferret')).equal(DOCS_ID);
    should(subject.adopted).deepEqual(['ferret']);
  });

  it('should answer none for a folder that stays Unfiled, or a session it does not know', async () => {
    // Arrange
    const subject = resolverWith({ adhoc: { cwd: '/home/kirin' } });

    // Act / Assert
    should(await subject.resolver.boardOf('adhoc')).be.null();
    should(await subject.resolver.boardOf('ghost')).be.null();
    should(subject.adopted).deepEqual(['adhoc']);
  });
});
