import { describe, expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import type { FencedPath, RootHandle, StatePort } from '@ferretry/kernel/contract';
import { RootSkillFiles } from '../../daemon/adapters/skill-files.ts';
import { RootSkillFolderReader } from '../../daemon/adapters/skill-folder-reader.ts';
import { StateLocalSkillInstallStore } from '../../daemon/adapters/install-store.ts';
import { LocalSkillInstallStateError } from '../../daemon/lib/installs/store.ts';

/** A root handle over a map of absolute path -> text (a directory is a path ending in `/`). `outside` paths refuse. */
function memoryRoot(files: Record<string, string>, outside: readonly string[] = []): RootHandle {
  const paths = Object.keys(files);
  const isDir = (path: string): boolean => paths.some(candidate => candidate.startsWith(`${path}/`));
  return {
    name: 'work',
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
        ? { kind: 'file' as const, size: files[path]!.length, modified: '2026-01-01T00:00:00Z' as never }
        : isDir(path)
          ? { kind: 'directory' as const, size: 0, modified: '2026-01-01T00:00:00Z' as never }
          : undefined,
    remove: async () => undefined,
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
    const found = await new RootSkillFiles(root, '/w').list('/w/.claude/skills', '/w', 200);
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

describe('RootSkillFolderReader', () => {
  const folder = '/home/me/.claude/skills/demo';

  test('carries text files, and says why it left out a credential file, a binary and a link out of the folder', async () => {
    const root = memoryRoot(
      {
        [`${folder}/SKILL.md`]: doc('demo'),
        [`${folder}/notes.txt`]: 'notes',
        [`${folder}/.env`]: 'KEY=1',
        [`${folder}/bin.dat`]: 'a\u0000b',
        [`${folder}/escape/x.txt`]: 'x',
      },
      [`${folder}/escape`],
    );
    const read = await new RootSkillFolderReader(() => root).read(`${folder}/SKILL.md`, '/fleet');
    expect(read.refusal).toBeUndefined();
    expect(read.files.map(file => file.path)).toEqual(['SKILL.md', 'notes.txt']);
    const reasons = Object.fromEntries(read.problems.map(problem => [problem.subject, problem.reason]));
    expect(reasons['.env']).toMatch(/credential/u);
    expect(reasons['bin.dat']).toMatch(/not text/u);
    expect(reasons.escape).toMatch(/never followed/u);
  });

  test('refuses a folder with no SKILL.md among the files it can carry', async () => {
    const root = memoryRoot({ [`${folder}/notes.txt`]: 'n' });
    const read = await new RootSkillFolderReader(() => root).read(`${folder}/SKILL.md`, '/fleet');
    expect(read.refusal).toMatch(/SKILL\.md cannot be carried/u);
  });

  test('a folder that cannot be resolved is refused as gone', async () => {
    const root = memoryRoot({}, [folder]);
    const read = await new RootSkillFolderReader(() => root).read(`${folder}/SKILL.md`, '/fleet');
    expect(read.refusal).toMatch(/cannot be read any more/u);
  });
});

describe('StateLocalSkillInstallStore', () => {
  const statePort = (read: () => unknown): StatePort =>
    ({
      read: async () => read(),
      write: async () => undefined,
    }) as unknown as StatePort;

  test('an absent file reads as no copies', async () => {
    const store = new StateLocalSkillInstallStore(statePort(() => ok(undefined)));
    expect((await store.read()).installs).toEqual([]);
  });

  test('a damaged file raises and is never read as no copies', async () => {
    const store = new StateLocalSkillInstallStore(
      statePort(() => err({ file: 'installs.json', reason: 'unparsable', sentence: 'x' })),
    );
    await expect(store.read()).rejects.toBeInstanceOf(LocalSkillInstallStateError);
  });
});
