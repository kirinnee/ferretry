import { describe, it } from 'bun:test';
import should from 'should';
import { githubRepositoryOfRemote } from '../../../src/lib/board-github/index.ts';

describe('githubRepositoryOfRemote', () => {
  it('should read owner/name from every spelling git accepts for a GitHub repository', () => {
    for (const url of [
      'https://github.com/kirinnee/ferretry',
      'https://github.com/kirinnee/ferretry.git',
      'https://github.com/kirinnee/ferretry/',
      'https://user@github.com/kirinnee/ferretry.git',
      'git@github.com:kirinnee/ferretry.git',
      'ssh://git@github.com/kirinnee/ferretry.git',
      'ssh://git@github.com:22/kirinnee/ferretry',
      '  git@github.com:kirinnee/ferretry\n',
    ]) {
      should(githubRepositoryOfRemote(url)).equal('kirinnee/ferretry');
    }
    should(githubRepositoryOfRemote('https://github.com/kirinnee/my.repo.git')).equal('kirinnee/my.repo');
  });

  it('should name nothing for another host, a local path or a malformed URL', () => {
    for (const url of [
      'https://gitlab.com/a/b',
      '/srv/git/repo',
      'https://github.com/only-owner',
      'git@github.com:a/b/c',
    ]) {
      should(githubRepositoryOfRemote(url)).be.null();
    }
  });
});
