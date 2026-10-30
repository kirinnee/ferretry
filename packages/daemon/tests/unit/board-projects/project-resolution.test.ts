import { describe, it } from 'bun:test';
import { UNFILED_PROJECT_ID } from '@ferretry/protocol';
import should from 'should';
import { isUnderScratchRoot, resolveSessionProject } from '../../../src/lib/board-projects/index.ts';
import { DOCS_ID, FERRETRY_ID, project } from './support.ts';

const FERRETRY = project(FERRETRY_ID, '/work/ferretry', '/work/ferretry/.git');
const DOCS = project(DOCS_ID, '/work/docs');
const SCRATCH = ['/tmp', '/state/scratch'];

const resolve = (overrides: Partial<Parameters<typeof resolveSessionProject>[0]> = {}) =>
  resolveSessionProject({
    cwd: '/elsewhere',
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

describe('resolveSessionProject', () => {
  it('should inherit the parent board when the cwd is inside that project', () => {
    should(resolve({ cwd: '/work/ferretry/packages/cli', parentProjectId: FERRETRY_ID })).deepEqual({
      projectId: FERRETRY_ID,
      via: 'parent',
    });
  });

  it('should inherit the parent board for a worktree of the parent project', () => {
    should(
      resolve({ cwd: '/worktrees/feature', commonDirectory: '/work/ferretry/.git', parentProjectId: FERRETRY_ID }),
    ).deepEqual({ projectId: FERRETRY_ID, via: 'parent' });
  });

  it('should inherit the parent board in a scratch folder, whatever the parent board is', () => {
    should(resolve({ cwd: '/tmp/try', parentProjectId: DOCS_ID })).deepEqual({ projectId: DOCS_ID, via: 'parent' });
    should(resolve({ cwd: '/state/scratch/x', parentProjectId: UNFILED_PROJECT_ID })).deepEqual({
      projectId: UNFILED_PROJECT_ID,
      via: 'parent',
    });
  });

  it('should not inherit an unfiled parent outside a scratch folder', () => {
    should(resolve({ cwd: '/work/docs/x', parentProjectId: UNFILED_PROJECT_ID })).deepEqual({
      projectId: DOCS_ID,
      via: 'path',
    });
  });

  it('should not inherit a parent board that is no longer registered', () => {
    should(resolve({ cwd: '/elsewhere', parentProjectId: '33333333-3333-4333-8333-333333333333' })).deepEqual({
      projectId: UNFILED_PROJECT_ID,
      via: 'unfiled',
    });
  });

  it('should not inherit when the cwd belongs to neither the parent project nor its repository', () => {
    should(resolve({ cwd: '/work/docs/x', parentProjectId: FERRETRY_ID })).deepEqual({
      projectId: DOCS_ID,
      via: 'path',
    });
    should(resolve({ cwd: '/elsewhere', commonDirectory: '/other/.git', parentProjectId: FERRETRY_ID })).deepEqual({
      projectId: UNFILED_PROJECT_ID,
      via: 'unfiled',
    });
  });

  it('should pick the project whose repository the cwd belongs to', () => {
    should(resolve({ cwd: '/worktrees/feature', commonDirectory: '/work/ferretry/.git' })).deepEqual({
      projectId: FERRETRY_ID,
      via: 'repository',
    });
  });

  it('should pick the longest registered path that contains the cwd', () => {
    const nested = project(DOCS_ID, '/work/ferretry/docs');
    should(
      resolve({ cwd: '/work/ferretry/docs/a', projects: [project(FERRETRY_ID, '/work/ferretry'), nested] }),
    ).deepEqual({ projectId: DOCS_ID, via: 'path' });
  });

  it('should fall to unfiled when nothing matches', () => {
    should(resolve({ commonDirectory: '/unknown/.git' })).deepEqual({ projectId: UNFILED_PROJECT_ID, via: 'unfiled' });
  });

  it('should fall to unfiled when the matched root names no registered project', () => {
    should(resolve({ cwd: '/work/docs', projects: [project(DOCS_ID, '/work/docs/')] })).deepEqual({
      projectId: UNFILED_PROJECT_ID,
      via: 'unfiled',
    });
  });
});
