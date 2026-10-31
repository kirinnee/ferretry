import { describe, it } from 'bun:test';
import should from 'should';
import { githubRepositoryOf, parseGitRemote } from '../../../src/lib/board-github/index.ts';

/** The GitHub repository a remote names as written, its host not resolved. */
const githubRepositoryOfRemote = (url: string): string | null => {
  const remote = parseGitRemote(url);
  return remote === null ? null : githubRepositoryOf(remote, null);
};

describe('a GitHub remote as written', () => {
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

describe('parseGitRemote and githubRepositoryOf', () => {
  it('should read the host as written, so an ssh host alias can be resolved', () => {
    should(parseGitRemote('github-personal:kirinnee/ferretry.git')).deepEqual({
      host: 'github-personal',
      ssh: true,
      repo: 'kirinnee/ferretry',
    });
    should(parseGitRemote('git@Work-GitHub:AtomiCloud/nix-registry')).deepEqual({
      host: 'work-github',
      ssh: true,
      repo: 'AtomiCloud/nix-registry',
    });
    should(parseGitRemote('ssh://me@gh-alias:2222/o/r.git')).deepEqual({ host: 'gh-alias', ssh: true, repo: 'o/r' });
    should(parseGitRemote('https://gitlab.com/a/b.git')).deepEqual({ host: 'gitlab.com', ssh: false, repo: 'a/b' });
  });

  it('should name nothing for a local path, a deeper path, or a host that would read as an option', () => {
    for (const url of [
      '/srv/git/repo',
      'C:/x',
      'host:/abs/path',
      'host:a/b/c',
      '-oProxyCommand:a/b',
      'https://x.com/a',
    ]) {
      should(parseGitRemote(url)).be.null();
    }
  });

  it('should be GitHub when the host, or where an alias resolves, is GitHub’s', () => {
    const alias = parseGitRemote('github-personal:kirinnee/ferretry.git');
    if (alias === null) throw new Error('unparsed');
    should(githubRepositoryOf(alias, null)).be.null();
    should(githubRepositoryOf(alias, 'github.com')).equal('kirinnee/ferretry');
    should(githubRepositoryOf(alias, 'SSH.GitHub.com')).equal('kirinnee/ferretry');
    should(githubRepositoryOf(alias, 'gitlab.com')).be.null();
    should(githubRepositoryOfRemote('github-personal:kirinnee/ferretry.git')).be.null();
    should(githubRepositoryOfRemote('me@github.com:kirinnee/ferretry.git')).equal('kirinnee/ferretry');
  });
});
