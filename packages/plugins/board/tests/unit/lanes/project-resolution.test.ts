import { describe, it } from 'bun:test';

import { UNFILED_PROJECT_ID } from '../../../contract/index.ts';
import should from 'should';
import {
  isUnderScratchRoot,
  resolveFerretProject,
} from '../../../daemon/lib/lanes/index.ts';
import { DOCS_ID, FERRETRY_ID, project } from './support.ts';

const FERRETRY = project(FERRETRY_ID, '/work/ferretry', '/work/ferretry/.git');
const DOCS = project(DOCS_ID, '/work/docs');
const SCRATCH = ['/tmp', '/state/scratch'];

const resolve = (overrides: Partial<Parameters<typeof resolveFerretProject>[0]> = {}) =>
  resolveFerretProject({
    folder: '/elsewhere',
    projects: [FERRETRY, DOCS],
    commonDirectory: null,
    scratchRoots: SCRATCH,
    ...overrides,
  });

describe('isUnderScratchRoot', () => {
  it('should accept a root and anything inside it, and nothing else', () => {
    should(isUnderScratchRoot('/tmp', SCRATCH)).be.true();
    should(isUnderScratchRoot('/tmp/a/b', SCRATCH)).be.true();
    should(isUnderScratchRoot('/tmpfoo', SCRATCH)).be.false();
    should(isUnderScratchRoot('/work', [])).be.false();
  });
});

describe('resolveFerretProject', () => {
  it('should inherit the parent board when the folder is inside that project', () => {
    should(resolve({ folder: '/work/ferretry/packages/cli', parentProjectId: FERRETRY_ID })).deepEqual({
      projectId: FERRETRY_ID,
      via: 'parent',
    });
  });

  it('should inherit the parent board for a worktree of the parent project', () => {
    should(
      resolve({ folder: '/worktrees/feature', commonDirectory: '/work/ferretry/.git', parentProjectId: FERRETRY_ID }),
    ).deepEqual({ projectId: FERRETRY_ID, via: 'parent' });
  });

  it('should inherit the parent board in a scratch folder, whatever the parent board is', () => {
    should(resolve({ folder: '/tmp/try', parentProjectId: DOCS_ID })).deepEqual({ projectId: DOCS_ID, via: 'parent' });
    should(resolve({ folder: '/state/scratch/x', parentProjectId: UNFILED_PROJECT_ID })).deepEqual({
      projectId: UNFILED_PROJECT_ID,
      via: 'parent',
    });
  });

  it('should not inherit an unfiled parent outside a scratch folder', () => {
    should(resolve({ folder: '/work/docs/x', parentProjectId: UNFILED_PROJECT_ID })).deepEqual({
      projectId: DOCS_ID,
      via: 'path',
    });
  });

  it('should not inherit a parent board that is no longer registered', () => {
    should(resolve({ folder: '/elsewhere', parentProjectId: '33333333-3333-4333-8333-333333333333' })).deepEqual({
      projectId: UNFILED_PROJECT_ID,
      via: 'unfiled',
    });
  });

  it('should not inherit when the folder belongs to neither the parent project nor its repository', () => {
    should(resolve({ folder: '/work/docs/x', parentProjectId: FERRETRY_ID })).deepEqual({
      projectId: DOCS_ID,
      via: 'path',
    });
    should(resolve({ folder: '/elsewhere', commonDirectory: '/other/.git', parentProjectId: FERRETRY_ID })).deepEqual({
      projectId: UNFILED_PROJECT_ID,
      via: 'unfiled',
    });
  });

  it('should pick the project whose repository the folder belongs to', () => {
    should(resolve({ folder: '/worktrees/feature', commonDirectory: '/work/ferretry/.git' })).deepEqual({
      projectId: FERRETRY_ID,
      via: 'repository',
    });
  });

  it('should pick the longest registered path that contains the folder', () => {
    const nested = project(DOCS_ID, '/work/ferretry/docs');
    should(
      resolve({ folder: '/work/ferretry/docs/a', projects: [project(FERRETRY_ID, '/work/ferretry'), nested] }),
    ).deepEqual({ projectId: DOCS_ID, via: 'path' });
  });

  it('should fall to unfiled when nothing matches', () => {
    should(resolve({ commonDirectory: '/unknown/.git' })).deepEqual({ projectId: UNFILED_PROJECT_ID, via: 'unfiled' });
  });

  it('should fall to unfiled when the matched root names no registered project', () => {
    should(resolve({ folder: '/work/docs', projects: [project(DOCS_ID, '/work/docs/')] })).deepEqual({
      projectId: UNFILED_PROJECT_ID,
      via: 'unfiled',
    });
  });
});
