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
    const read = await new RootSkillFolderReader(() => ({ root, boundary: root })).read(
      `${folder}/SKILL.md`,
      '/home/me',
    );
    expect(read.refusal).toBeUndefined();
    expect(read.files.map(file => file.path)).toEqual(['SKILL.md', 'notes.txt']);
    const reasons = Object.fromEntries(read.problems.map(problem => [problem.subject, problem.reason]));
    expect(reasons['.env']).toMatch(/credential/u);
    expect(reasons['bin.dat']).toMatch(/not text/u);
    expect(reasons.escape).toMatch(/never followed/u);
  });

  test('refuses a folder with no SKILL.md among the files it can carry', async () => {
    const root = memoryRoot({ [`${folder}/notes.txt`]: 'n' });
    const read = await new RootSkillFolderReader(() => ({ root, boundary: root })).read(
      `${folder}/SKILL.md`,
      '/home/me',
    );
    expect(read.refusal).toMatch(/SKILL\.md cannot be carried/u);
  });

  test('a folder that cannot be resolved is refused as gone', async () => {
    const root = memoryRoot({}, [folder]);
    const read = await new RootSkillFolderReader(() => ({ root, boundary: root })).read(
      `${folder}/SKILL.md`,
      '/home/me',
    );
    expect(read.refusal).toMatch(/cannot be read any more/u);
  });

  test('G175 refuses a source replaced with a link outside its inventory boundary before listing', async () => {
    const root = memoryRoot({ [`${folder}/SKILL.md`]: doc('demo') });
    let listed = false;
    root.list = async () => {
      listed = true;
      return [];
    };
    const boundary = memoryRoot({});
    // Lexical resolution succeeds, but stat's resolved containment check catches the swapped link.
    boundary.stat = async () => {
      throw new Error('link_escape');
    };
    const opened: string[][] = [];
    const read = await new RootSkillFolderReader((source, confinedTo) => {
      opened.push([source, confinedTo]);
      return { root, boundary };
    }).read(`${folder}/SKILL.md`, '/home/me');
    expect(opened).toEqual([[folder, '/home/me']]);
    expect(read.refusal).toMatch(/cannot be read any more/u);
    expect(read.files).toEqual([]);
    expect(listed).toBe(false);
  });

  test('G175 rechecks the inventory boundary before each nested listing and file read', async () => {
    const root = memoryRoot({ [`${folder}/SKILL.md`]: doc('demo'), [`${folder}/nested/notes.txt`]: 'notes' });
    const boundary = memoryRoot({ [`${folder}/SKILL.md`]: doc('demo') });
    let escaped = false;
    const originalStat = boundary.stat;
    boundary.stat = async path => {
      if (escaped) throw new Error('link_escape');
      return await originalStat(path);
    };
    const originalList = root.list;
    const listings: string[] = [];
    root.list = async path => {
      listings.push(path);
      const names = await originalList(path);
      escaped = true;
      return names;
    };
    let reads = 0;
    root.readBytes = async () => {
      reads += 1;
      return new Uint8Array();
    };
    const read = await new RootSkillFolderReader(() => ({ root, boundary })).read(`${folder}/SKILL.md`, '/home/me');
    expect(listings).toEqual([folder]);
    expect(reads).toBe(0);
    expect(read.files).toEqual([]);
    expect(read.refusal).toMatch(/SKILL\.md cannot be carried/u);
  });

  test('G175 rechecks a source that escapes its inventory boundary between two file reads', async () => {
    const root = memoryRoot({ [`${folder}/SKILL.md`]: doc('demo'), [`${folder}/notes.txt`]: 'outside content' });
    const boundary = memoryRoot({ [`${folder}/SKILL.md`]: doc('demo') });
    let escaped = false;
    const originalStat = boundary.stat;
    boundary.stat = async path => {
      if (escaped) throw new Error('link_escape');
      return await originalStat(path);
    };
    const originalRead = root.readBytes;
    const reads: string[] = [];
    root.readBytes = async (path, limit) => {
      reads.push(path);
      const bytes = await originalRead(path, limit);
      escaped = true;
      return bytes;
    };
    const read = await new RootSkillFolderReader(() => ({ root, boundary })).read(`${folder}/SKILL.md`, '/home/me');
    expect(reads).toEqual([`${folder}/SKILL.md`]);
    expect(read.files.map(file => file.path)).toEqual(['SKILL.md']);
    expect(read.problems).toContainEqual({ subject: 'notes.txt', reason: 'it could not be read' });
  });

  test('G175 keeps child traversal confined to the skill folder inside an allowed inventory boundary', async () => {
    const root = memoryRoot({ [`${folder}/SKILL.md`]: doc('demo'), [`${folder}/sibling/notes.txt`]: 'sibling' }, [
      `${folder}/sibling`,
    ]);
    const boundary = memoryRoot({ [`${folder}/SKILL.md`]: doc('demo') });
    const read = await new RootSkillFolderReader(() => ({ root, boundary })).read(`${folder}/SKILL.md`, '/home/me');
    expect(read.files.map(file => file.path)).toEqual(['SKILL.md']);
    expect(read.problems.find(problem => problem.subject === 'sibling')?.reason).toMatch(/never followed/u);
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
