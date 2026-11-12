import { describe, expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { RootSkillFiles } from '../../daemon/adapters/skill-files.ts';

/** A root handle over a map of absolute path -> text (a directory is a path ending in `/`). `outside` paths refuse. */
function memoryRoot(files: Record<string, string>, outside: readonly string[] = []): RootHandle {
  const paths = Object.keys(files);
  const isDir = (path: string): boolean => paths.some(candidate => candidate.startsWith(`${path}/`));
  return {
    name: 'work',
    internal: false,
    resolve: given => {
      const relative = given.startsWith('/') ? given : given === '' ? '/w' : `/w/${given}`;
      return outside.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`))
        ? err('link_escape')
        : ok(relative as FencedPath);
    },
    readText: async path => files[path] ?? '',
    readBytes: async path => new TextEncoder().encode(files[path] ?? ''),
    writeText: async () => undefined,
    list: async path => {
      const prefix = `${path}/`;
      return [
        ...new Set(paths.filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length).split('/')[0]!)),
      ].sort();
    },
    stat: async path =>
      path in files
        ? {
            kind: 'file' as const,
            size: files[path]!.length,
            modified: '2026-01-01T00:00:00Z' as never,
            mode: 0o600,
            links: 1,
          }
        : isDir(path)
          ? { kind: 'directory' as const, size: 0, modified: '2026-01-01T00:00:00Z' as never, mode: 0o600, links: 1 }
          : undefined,
    remove: async () => undefined,
    readTail: () => Promise.reject(new Error('the fixture has no readTail')),
    writeBytes: () => Promise.reject(new Error('the fixture has no writeBytes')),
    copyTree: () => Promise.reject(new Error('the fixture has no copyTree')),
    copyShared: () => Promise.reject(new Error('the fixture has no copyShared')),
    linkCredential: () => Promise.reject(new Error('the fixture has no linkCredential')),
    ensurePrivateDirectory: () => Promise.reject(new Error('the fixture has no ensurePrivateDirectory')),
    entries: () => Promise.reject(new Error('the fixture has no entries')),
    lstat: () => Promise.reject(new Error('the fixture has no lstat')),
    makeDirectory: () => Promise.reject(new Error('the fixture has no makeDirectory')),
    realPath: () => Promise.reject(new Error('the fixture has no realPath')),
    pin: () => Promise.reject(new Error('the fixture has no pin')),
    publish: () => Promise.reject(new Error('the fixture has no publish')),
    readDurable: () => Promise.reject(new Error('the fixture has no readDurable')),
    syncDirectory: () => Promise.reject(new Error('the fixture has no syncDirectory')),
    fileIdentity: () => Promise.reject(new Error('the fixture has no fileIdentity')),
    linkTo: () => Promise.reject(new Error('the fixture has no linkTo')),
    setMode: () => Promise.reject(new Error('the fixture has no setMode')),
    rename: () => Promise.reject(new Error('the fixture has no rename')),
    unlink: () => Promise.reject(new Error('the fixture has no unlink')),
    checkPrivateChain: () => Promise.reject(new Error('the fixture has no chain check')),
  };
}

const doc = (name: string): string => `---\nname: ${name}\ndescription: d\n---\n`;

describe('RootSkillFiles', () => {
  test('lists skill folders with a SKILL.md, skips dot entries, and refuses a folder that links out of the root', async () => {
    const root = memoryRoot(
      {
        '/w/.claude/skills/a/SKILL.md': doc('a'),
        '/w/.claude/skills/.hidden/SKILL.md': doc('h'),
        '/w/.claude/skills/b/SKILL.md': doc('b'),
        '/w/.claude/skills/nodoc/readme.md': 'x',
      },
      ['/w/.claude/skills/b'],
    );
    const found = await new RootSkillFiles(root, '/w').list('/w/.claude/skills', 200);
    expect(found.map(entry => entry.manifest)).toEqual(['/w/.claude/skills/a/SKILL.md']);
  });

  test('reads a manifest within the cap and not one over it', async () => {
    const root = memoryRoot({ '/w/s/SKILL.md': 'x'.repeat(10) });
    const files = new RootSkillFiles(root, '/w');
    expect(await files.read('/w/s/SKILL.md', 10)).toBe('x'.repeat(10));
    expect(await files.read('/w/s/SKILL.md', 9)).toBeUndefined();
    expect(await files.read('/w/missing', 10)).toBeUndefined();
  });
});
