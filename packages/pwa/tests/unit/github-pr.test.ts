import { describe, expect, it } from 'bun:test';
import { parseGithubPr } from '../../src/lib/github-pr.ts';

describe('parseGithubPr', () => {
  it('recognises a plain pull-request URL', () => {
    expect(parseGithubPr('https://github.com/kirinnee/ferretry/pull/49')).toEqual({
      org: 'kirinnee',
      repo: 'ferretry',
      number: 49,
      url: 'https://github.com/kirinnee/ferretry/pull/49',
    });
  });

  it('accepts www, http and a trailing path, query or fragment', () => {
    for (const url of [
      'http://github.com/a/b/pull/1',
      'https://www.github.com/a/b/pull/1',
      'https://github.com/a/b/pull/1/files',
      'https://github.com/a/b/pull/1?w=1',
      'https://github.com/a/b/pull/1#discussion',
    ]) {
      expect(parseGithubPr(url)?.number).toBe(1);
    }
  });

  it('trims surrounding whitespace and keeps the trimmed url', () => {
    expect(parseGithubPr('  https://github.com/a/b/pull/7  ')?.url).toBe('https://github.com/a/b/pull/7');
  });

  it('refuses a note that merely mentions a pull request', () => {
    expect(parseGithubPr('see https://github.com/a/b/pull/1 for the fix')).toBeNull();
  });

  it('refuses anything that is not a pull-request URL', () => {
    expect(parseGithubPr('https://github.com/a/b/issues/1')).toBeNull();
    expect(parseGithubPr('https://gitlab.com/a/b/pull/1')).toBeNull();
    expect(parseGithubPr('')).toBeNull();
  });

  it('refuses a number too large to be represented exactly', () => {
    expect(parseGithubPr('https://github.com/a/b/pull/99999999999999999999')).toBeNull();
  });
});
