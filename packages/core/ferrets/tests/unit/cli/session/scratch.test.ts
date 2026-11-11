import { describe, expect, test } from 'bun:test';
import {
  COMMON_SCRATCH_ROOTS,
  isScratchPath,
  SCRATCH_REMEDY,
  scratchMessage,
} from '../../../../cli/lib/session/scratch.ts';

describe('isScratchPath', () => {
  test.each([
    ['/tmp', true],
    ['/tmp/claude-1000/-home-me/scratchpad', true],
    ['/private/tmp/claude-501/x', true],
    ['/var/folders/ab/xyz/T/codex', true],
    ['/private/var/tmp/work/', true],
    ['/tmpfiles/project', false],
    ['/home/me/project', false],
    ['/Users/me/code/app', false],
  ] as const)('V-0334 %s is temporary: %s', (path, expected) => {
    expect(isScratchPath(path, COMMON_SCRATCH_ROOTS)).toBe(expected);
  });

  test("V-0334 this machine's own temp roots count, with or without a trailing slash; an empty or / root is ignored", () => {
    expect(isScratchPath('/scratch/me/run', ['/scratch/me/'])).toBe(true);
    expect(isScratchPath('/scratch/me', ['/scratch/me/'])).toBe(true);
    expect(isScratchPath('/home/me/project', ['', '/'])).toBe(false);
  });

  test('V-0334 the refusal names the folder and every way out', () => {
    expect(scratchMessage('/tmp/x').startsWith('/tmp/x is a temporary folder, not a project')).toBe(true);
    for (const way of ['Leave --cwd out', '--cwd', '--allow-scratch']) expect(SCRATCH_REMEDY).toContain(way);
  });
});
