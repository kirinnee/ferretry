import { describe, expect, test } from 'bun:test';
import { parseRepoSegment, repoSegment } from '../../contract/repo-segment.ts';

describe('repo segment (owner~name in one path segment)', () => {
  test('a repository round-trips', () => {
    expect(repoSegment({ owner: 'octo', name: 'demo.git-x' })).toBe('octo~demo.git-x');
    expect(parseRepoSegment('octo~demo.git-x')).toEqual({ owner: 'octo', name: 'demo.git-x' });
  });
  test('anything else is refused', () => {
    for (const bad of [
      'octo',
      '~demo',
      'octo~',
      'a~b~c',
      'octo~..',
      'octo~.',
      'octo~de/mo',
      '-octo~demo',
      'octo~de mo',
      '',
    ])
      expect(parseRepoSegment(bad)).toBeUndefined();
  });
});
