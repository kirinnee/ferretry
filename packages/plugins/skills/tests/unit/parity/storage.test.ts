/**
 * Where Skills reads and keeps its files: today's rows F-0006, F-0012, F-0013 and F-0162, each proven at the seam that
 * owns it in 5.0 (the home reader behind the router, the project folder reader, the config declaration).
 */
import { describe, expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type { RuntimeHome, RuntimeHomeReader } from '@ferretry/plugin-runtimes/contract';
import { InstalledSkillFiles } from '../../../daemon/adapters/installed-store.ts';
import { ProjectSkillFiles } from '../../../daemon/adapters/project-skill-files.ts';
import { SkillFilesRouter } from '../../../daemon/adapters/skill-files-router.ts';
import { RootSkillFiles } from '../../../daemon/adapters/skill-files.ts';
import { SkillsInventoryService } from '../../../daemon/lib/inventory.ts';
import { SKILLS_CONFIG } from '../../../contract/index.ts';

const HOME: RuntimeHome = {
  id: 'a',
  harness: 'claude-code',
  runtimes: ['claude-a' as never],
  home: '/fy/fleet/homes/a',
  wrapper: '/fy/fleet/bin/claude-a',
};
const doc = (name: string): string => `---\nname: ${name}\ndescription: does ${name}\n---\n`;

const homeReader = (asked: string[]): RuntimeHomeReader => ({
  document: async () => null,
  skills: async limit => {
    asked.push(`skills(${String(limit)})`);
    return [{ name: 'mine', manifest: `${HOME.home}/skills/mine/SKILL.md`, managed: false }];
  },
  skillManifest: async name => doc(name),
  skillTree: async () => undefined,
  skillFile: async () => ({ ok: false, reason: 'unreadable' }),
});

const noProject = new ProjectSkillFiles(
  async () => [],
  () => {
    throw new Error('no project is registered');
  },
);

describe('Skills storage rows', () => {
  test('F-0006 a ferret’s skills are read from <its runtime home>/skills, through the home reader and never a path', async () => {
    const asked: string[] = [];
    const router = new SkillFilesRouter({
      homes: async () => [HOME],
      home: id => (id === 'a' ? homeReader(asked) : undefined),
      assets: () => undefined,
      installed: new InstalledSkillFiles({
        pathOf: () => '/x',
        stat: async () => undefined,
        read: async () => ok(undefined),
      } as never),
      projects: noProject,
    });
    const service = new SkillsInventoryService({
      files: router,
      homes: async () => [{ runtimes: ['claude-a'], harness: 'claude-code', home: HOME.home }],
      projects: async () => [],
    });

    const view = await service.ferret({ id: 'f1', harness: 'claude-code', runtime: 'claude-a', folder: '/work/app' });

    expect(view.skills.map(skill => [skill.name, skill.path])).toEqual([['mine', `${HOME.home}/skills/mine/SKILL.md`]]);
    expect(asked).toEqual(['skills(200)']);
  });

  test('F-0012 a skill folder’s manifest is <directory>/<name>/SKILL.md, for a project folder as for a home', async () => {
    const project = new ProjectSkillFiles(
      async () => ['/work/p'],
      folder => handleOver(folder, { [`${folder}/review/SKILL.md`]: doc('review') }),
    );
    expect((await project.list('/work/p/.claude/skills', 10)).map(entry => entry.manifest)).toEqual([
      '/work/p/.claude/skills/review/SKILL.md',
    ]);
    expect((await project.list('/work/p/.agents/skills', 10)).map(entry => entry.manifest)).toEqual([
      '/work/p/.agents/skills/review/SKILL.md',
    ]);
  });

  test('F-0013 the skill files adapter lists <directory>/<name>/SKILL.md for a folder that holds one, skipping the rest', async () => {
    const files = new RootSkillFiles(
      handleOver('/w/skills', {
        '/w/skills/a/SKILL.md': doc('a'),
        '/w/skills/nodoc/readme.md': 'x',
        '/w/skills/.hidden/SKILL.md': doc('h'),
      }),
      '/w/skills',
    );
    expect((await files.list('/w/skills', 10)).map(entry => entry.manifest)).toEqual(['/w/skills/a/SKILL.md']);
  });

  test('F-0162 Skills’ items are one file each under config/skills, named by one item name', () => {
    const config = SKILLS_CONFIG as unknown as { readonly collection: string; readonly name: RegExp };
    expect(config.collection).toBe('skills');
    expect(config.name.test('review-code')).toBe(true);
    expect(config.name.test('../review')).toBe(false);
    expect(config.name.test('a/b')).toBe(false);
  });
});

/** A scoped handle over a map of absolute path -> text (directories are implied by the paths under them). */
function handleOver(base: string, files: Record<string, string>): RootHandle {
  const kids = (path: string): string[] => [
    ...new Set(
      Object.keys(files)
        .filter(file => file.startsWith(`${path}/`))
        .map(file => file.slice(path.length + 1).split('/')[0]!),
    ),
  ];
  const at = '2026-01-01T00:00:00Z' as never;
  const handle = {
    name: 'imports',
    internal: false,
    resolve: (given: string) =>
      given.includes('..') ? err('outside') : ok((given === '' ? base : `${base}/${given}`) as FencedPath),
    realPath: async () => base,
    list: async (path: string) => kids(path),
    stat: async (path: string) =>
      path in files
        ? { kind: 'file' as const, size: files[path]!.length, modified: at, mode: 0o600, links: 1 }
        : kids(path).length > 0
          ? { kind: 'directory' as const, size: 0, modified: at, mode: 0o700, links: 1 }
          : undefined,
    readText: async (path: string) => files[path] ?? '',
  };
  return handle as unknown as RootHandle;
}
