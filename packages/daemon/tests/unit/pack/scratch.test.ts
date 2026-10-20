import { describe, it } from 'bun:test';
import should from 'should';
import { COMMON_SCRATCH_ROOTS, isScratchPath, SCRATCH_REMEDY, scratchMessage } from '../../../src/lib/pack/scratch.ts';

describe('isScratchPath', () => {
  it.each([
    ['/tmp', true],
    ['/tmp/claude-1000/-home-me/scratchpad', true],
    ['/private/tmp/claude-501/x', true],
    ['/var/folders/ab/xyz/T/codex', true],
    ['/private/var/tmp/work/', true],
    ['/tmpfiles/project', false],
    ['/home/me/project', false],
    ['/Users/me/code/app', false],
  ] as const)('should call %s temporary: %s', (path, expected) => {
    should(isScratchPath(path, COMMON_SCRATCH_ROOTS)).equal(expected);
  });

  it("should count this machine's own temp roots, with or without a trailing slash, and ignore an empty or / root", () => {
    // Act + Assert
    should(isScratchPath('/scratch/me/run', ['/scratch/me/'])).be.true();
    should(isScratchPath('/scratch/me', ['/scratch/me/'])).be.true();
    should(isScratchPath('/home/me/project', ['', '/'])).be.false();
  });

  it('should name the folder and every way out of the refusal', () => {
    should(scratchMessage('/tmp/x')).startWith('/tmp/x is a temporary folder, not a project');
    for (const way of ['Leave --cwd out', '--cwd', '--allow-scratch']) should(SCRATCH_REMEDY).containEql(way);
  });
});
