import { describe, it } from 'bun:test';
import should from 'should';
import { isPathSafeWorktreeGroup } from '../../../../contract/worktrees.ts';
import { projectGroup, resolveProjectGroup } from '../../../../cli/lib/worktrees/project-group.ts';

const ALPHA = { id: '1a2b3c4d-0000-4000-8000-000000000001', name: 'Alpha Repo' };
const BETA = { id: '9f8e7d6c-0000-4000-8000-000000000002', name: 'beta' };
const projects = async () => [ALPHA, BETA];

describe('projectGroup', () => {
  it('should name the group <name-slug>-<first 8 of the id>', () => {
    should(projectGroup(ALPHA)).equal('alpha-repo-1a2b3c4d');
  });

  it.each(['../../etc', '日本語', '   ', 'a/b\\c', `${'long '.repeat(30)}`])(
    'should always make a path-safe group, whatever the name %j',
    name => {
      should(isPathSafeWorktreeGroup(projectGroup({ id: ALPHA.id, name }))).be.true();
    },
  );
});

describe('resolveProjectGroup', () => {
  it('should resolve a name, ignoring case', async () => {
    should(await resolveProjectGroup('ALPHA repo', projects)).equal('alpha-repo-1a2b3c4d');
  });

  it('should resolve an id', async () => {
    should(await resolveProjectGroup(BETA.id, projects)).equal('beta-9f8e7d6c');
  });

  it('should refuse an empty project name', async () => {
    await resolveProjectGroup('  ', projects).then(
      () => should.fail(undefined, undefined, 'expected a refusal'),
      (error: Error) => should(error.message).containEql('--project'),
    );
  });

  it('should refuse an unknown project and say which are known', async () => {
    await resolveProjectGroup('gamma', projects).then(
      () => should.fail(undefined, undefined, 'expected a refusal'),
      (error: Error) => should(error.message).containEql('gamma').and.containEql('Alpha Repo, beta'),
    );
  });

  it('should refuse a name two projects share', async () => {
    const twins = async () => [BETA, { ...BETA, id: '00000000-0000-4000-8000-000000000003' }];
    await resolveProjectGroup('beta', twins).then(
      () => should.fail(undefined, undefined, 'expected a refusal'),
      (error: Error) => should(error.message).containEql('project id'),
    );
  });
});
