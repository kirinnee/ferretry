import { describe, it } from 'bun:test';

import { type BoardProjectId, UNFILED_PROJECT_ID } from '../../../contract/index.ts';
import should from 'should';
import {
  FerretBoardResolver,
  type FerretProjectFacts,
} from '../../../daemon/lib/lanes/index.ts';
import { DOCS_ID, FERRETRY_ID } from './support.ts';

/** A resolver over fixed facts, recording what it resolved and adopted. */
const resolverWith = (
  facts: Readonly<Record<string, FerretProjectFacts>>,
  resolves: Readonly<Record<string, BoardProjectId>> = {},
  adopts: Readonly<Record<string, BoardProjectId>> = {},
) => {
  const resolved: { folder: string; parent?: string }[] = [];
  const adopted: string[] = [];
  const resolver = new FerretBoardResolver(
    { read: async ferretId => facts[ferretId] ?? null },
    {
      projectForStart: async start => {
        resolved.push(start);
        return resolves[start.folder] ?? UNFILED_PROJECT_ID;
      },
    },
    {
      adopt: async ferretId => {
        adopted.push(ferretId);
        const projectId = adopts[ferretId];
        return projectId === undefined ? null : { projectId, proposed: true };
      },
    },
  );
  return { resolver, resolved, adopted };
};

describe('FerretBoardResolver', () => {
  it('should answer with the board a session was stamped with, when that is a project’s', async () => {
    // Arrange
    const subject = resolverWith({ lead: { folder: '/work/ferretry', projectId: FERRETRY_ID } });

    // Act / Assert
    should(await subject.resolver.boardOf('lead')).equal(FERRETRY_ID);
    should(subject.resolved).be.empty();
    should(subject.adopted).be.empty();
  });

  it('should resolve the folder again for a session stamped Unfiled or not stamped at all, parent included', async () => {
    // Arrange
    const subject = resolverWith(
      {
        old: { folder: '/work/ferretry', projectId: UNFILED_PROJECT_ID },
        child: { folder: '/tmp/scratch', parent: 'lead' },
      },
      { '/work/ferretry': FERRETRY_ID, '/tmp/scratch': DOCS_ID },
    );

    // Act / Assert
    should(await subject.resolver.boardOf('old')).equal(FERRETRY_ID);
    should(await subject.resolver.boardOf('child')).equal(DOCS_ID);
    should(subject.resolved).deepEqual([{ folder: '/work/ferretry' }, { folder: '/tmp/scratch', parent: 'lead' }]);
    should(subject.adopted).be.empty();
  });

  it('should register the repository a session stands in when no project has it yet', async () => {
    // Arrange
    const subject = resolverWith({ ferret: { folder: '/work/new-repo' } }, {}, { ferret: DOCS_ID });

    // Act / Assert
    should(await subject.resolver.boardOf('ferret')).equal(DOCS_ID);
    should(subject.adopted).deepEqual(['ferret']);
  });

  it('should answer none for a folder that stays Unfiled, or a session it does not know', async () => {
    // Arrange
    const subject = resolverWith({ adhoc: { folder: '/home/kirin' } });

    // Act / Assert
    should(await subject.resolver.boardOf('adhoc')).be.null();
    should(await subject.resolver.boardOf('ghost')).be.null();
    should(subject.adopted).deepEqual(['adhoc']);
  });
});
