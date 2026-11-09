/**
 * The pure rules of the `project-files` root (S179, `manifest/project-files.ts`): which patterns a manifest may declare
 * and which names of one project folder a declared set reaches for each use. The real disk tests and the parity test
 * meet these same rules through a host.
 */
import { describe, expect, test } from 'bun:test';
import { projectFilesPatternRefusal, projectFilesScope, projectPathRefusal } from '../../../manifest/project-files.ts';

const SKILLS = ['.claude/skills/*/**', '.agents/skills/*/**'];
const MCP = ['.mcp.json'];

describe('S179 projectFilesPatternRefusal', () => {
  test('S179 the two shapes the root is built for are legal', () => {
    for (const pattern of ['.mcp.json', '.claude/skills/*/**', '.agents/skills/*/**', '.a/b/c', '.claude/x/**'])
      expect(projectFilesPatternRefusal(pattern)).toBeUndefined();
  });

  test('S179 no .., no absolute path, no bare ** at the root, no leading * and no partial wildcard', () => {
    for (const pattern of [
      '',
      '/abs/.mcp.json',
      '../x',
      'a/../x',
      './x',
      'a/./x',
      '**',
      '*',
      '*/**',
      '*/x',
      'a//b',
      'a/',
      'a/**/b',
      'a/**/**',
      'a/b*',
      'a/*b',
      'a/b?',
      'a/{b,c}',
      'a\0b',
      'a b',
    ])
      expect([pattern, projectFilesPatternRefusal(pattern) === undefined]).toEqual([pattern, false]);
    for (const notAString of [undefined, null, 1, {}, ['a']])
      expect(projectFilesPatternRefusal(notAString)).not.toBeUndefined();
  });
});

describe('S179 projectPathRefusal', () => {
  const allowed = (patterns: readonly string[], path: string, use: Parameters<typeof projectPathRefusal>[2]) =>
    projectPathRefusal(patterns, path, use) === undefined;

  test('S179 the MCP file: that name, as a file, and nothing beside or below it', () => {
    expect(allowed(MCP, '.mcp.json', 'file')).toBe(true);
    expect(allowed(MCP, '.mcp.json', 'remove')).toBe(true);
    expect(allowed(MCP, '.mcp.json', 'probe')).toBe(true);
    for (const path of ['.mcp.json/x', '.mcp.json2', 'x/.mcp.json', '.MCP.JSON', 'package.json'])
      expect(projectPathRefusal(MCP, path, 'file')).toBe('not_declared');
    // a folder made of the one file name is refused
    expect(projectPathRefusal(MCP, '.mcp.json', 'make')).toBe('not_declared');
    expect(projectPathRefusal(MCP, '.mcp.json', 'folder')).toBe('not_declared');
    expect(projectPathRefusal(MCP, '.mcp.json', 'tree')).toBe('not_declared');
  });

  test('S179 a skill folder: anything below it is a file; the folder itself is a grant, not a file', () => {
    expect(allowed(SKILLS, '.claude/skills/x/a', 'file')).toBe(true);
    expect(allowed(SKILLS, '.claude/skills/x/a/b/c.md', 'file')).toBe(true);
    expect(allowed(SKILLS, '.agents/skills/y/SKILL.md', 'file')).toBe(true);
    expect(projectPathRefusal(SKILLS, '.claude/skills/x', 'file')).toBe('not_declared');
    for (const use of ['make', 'probe', 'folder', 'remove', 'tree'] as const)
      expect(allowed(SKILLS, '.claude/skills/x', use)).toBe(true);
  });

  test('S179 the folders above a grant are only made or looked at', () => {
    for (const path of ['.claude', '.claude/skills', '.agents', '.agents/skills']) {
      expect(allowed(SKILLS, path, 'make')).toBe(true);
      expect(allowed(SKILLS, path, 'probe')).toBe(true);
      for (const use of ['file', 'folder', 'remove', 'tree'] as const)
        expect(projectPathRefusal(SKILLS, path, use)).toBe('not_declared');
    }
  });

  test('S179 other names are refused whatever the use: a sibling folder, another root, a case trick', () => {
    for (const use of ['file', 'make', 'probe', 'folder', 'remove', 'tree'] as const)
      for (const path of [
        '.claude/other',
        '.claude/other/x',
        '.claude/settings.json',
        '.git/config',
        'src/a.ts',
        '.CLAUDE/skills/x/a',
        '.claude/Skills/x/a',
        '.claude/skills/x/../y',
      ])
        expect([path, use, projectPathRefusal(SKILLS, path, use) === undefined]).toEqual([
          path,
          use,
          // `..` is not a plain name: it answers `outside`, never allowed
          false,
        ]);
  });

  test('S179 a name that is not plain answers outside: empty, ., .., an empty segment, NUL', () => {
    for (const path of ['', '.', '..', 'a//b', 'a/./b', 'a/../b', '/a', 'a/', '.mcp.json\0'])
      expect([path, projectPathRefusal(MCP, path, 'file')]).toEqual([path, 'outside']);
  });

  test('S179 no set, an empty set and unusable patterns reach nothing', () => {
    for (const patterns of [undefined, [], ['**'], ['/etc/passwd'], ['../x'], ['*/**']])
      expect(projectPathRefusal(patterns, '.mcp.json', 'file')).toBe('not_declared');
  });
});

describe('S179 projectFilesScope', () => {
  test('S179 exactly one plain absolute folder', () => {
    expect(projectFilesScope('/home/me/project')).toBe('/home/me/project');
    for (const bad of [undefined, '', 'rel', '/', '/a/', '/a//b', '/a/./b', '/a/../b', '/a\0b'])
      expect([bad, projectFilesScope(bad)]).toEqual([bad, undefined]);
  });
});
