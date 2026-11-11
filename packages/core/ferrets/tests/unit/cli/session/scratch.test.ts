import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMON_SCRATCH_ROOTS,
  isScratchPath,
  isTemporaryFolder,
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

  test('V-0334 a folder is judged where it really is: normalised, then through its links, and so are the roots', async () => {
    const links: Readonly<Record<string, string>> = {
      '/home/me/link': '/tmp/real/work',
      '/tmp': '/private/tmp',
      '/work/to-tmp-root': '/private/tmp',
    };
    const realpath = async (path: string): Promise<string> => {
      const target = links[path];
      if (target === undefined) throw new Error('ENOENT');
      return target;
    };
    const temporary = (path: string, roots: readonly string[] = COMMON_SCRATCH_ROOTS) =>
      isTemporaryFolder(path, roots, realpath);
    // A link into a temporary folder is a temporary folder.
    expect(await temporary('/home/me/link')).toBe(true);
    // `..` is normalised before the judgement, in both directions.
    expect(await temporary('/home/../tmp/x')).toBe(true);
    expect(await temporary('/tmp/../home/kirin')).toBe(false);
    // A trailing // still counts.
    expect(await temporary('/tmp/scratch//')).toBe(true);
    // A root that is itself a link (macOS /tmp) is resolved: the folder is named by where the root really is.
    expect(await temporary('/private/tmp/x', ['/tmp'])).toBe(true);
    expect(await temporary('/work/to-tmp-root', ['/tmp'])).toBe(true);
    // A path that cannot be resolved falls back to its lexical, normalised self, for the folder and for a root.
    expect(await temporary('/nowhere/project')).toBe(false);
    expect(await temporary('/nowhere/tmp-like/x', ['/nowhere/tmp-like'])).toBe(true);
    // A link that stays inside the project is not temporary; an empty root is ignored (it is not the working folder).
    expect(await temporary('/home/me/project/inside-link', ['', '/tmp'])).toBe(false);
    // With no resolver at all the judgement is the normalised lexical one.
    expect(await isTemporaryFolder('/home/../tmp/x', COMMON_SCRATCH_ROOTS)).toBe(true);
    expect(await isTemporaryFolder('/tmp/../home/kirin', COMMON_SCRATCH_ROOTS)).toBe(false);
  });

  test('V-0334 a real symlink into a root is refused, a real link that stays outside it is not', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fy-scratch-'));
    try {
      const root = join(base, 'root');
      const project = join(base, 'project');
      await mkdir(join(root, 'inner'), { recursive: true });
      await mkdir(join(project, 'sub'), { recursive: true });
      await symlink(join(root, 'inner'), join(project, 'into-root'));
      await symlink(join(project, 'sub'), join(project, 'inside'));
      // Only `root` is a temporary root here, so `project` is lexically fine and only the link gives it away.
      expect(await isTemporaryFolder(join(project, 'into-root'), [root], realpath)).toBe(true);
      expect(await isTemporaryFolder(join(project, 'into-root'), [root])).toBe(false);
      expect(await isTemporaryFolder(join(project, 'inside'), [root], realpath)).toBe(false);
      // A root named through a link is the same folder as the real one.
      await symlink(root, join(base, 'root-link'));
      expect(await isTemporaryFolder(join(root, 'inner'), [join(base, 'root-link')], realpath)).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('V-0334 the refusal names the folder and every way out', () => {
    expect(scratchMessage('/tmp/x').startsWith('/tmp/x is a temporary folder, not a project')).toBe(true);
    for (const way of ['Leave --cwd out', '--cwd', '--allow-scratch']) expect(SCRATCH_REMEDY).toContain(way);
  });
});
