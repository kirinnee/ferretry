import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { AvailableSkill, ProjectList, SessionSkills, SessionView } from '@ferretry/protocol';
import type { CatalogSubsystem } from '../../lib/runtime/mounts/catalogs.ts';

const MAX_SKILL_MANIFEST_BYTES = 256 * 1024;

export interface NodeCatalogOptions {
  readonly home: string;
  /** Roots searched one directory deep for git repositories. */
  readonly projectRoots: readonly string[];
}

const exists = async (path: string): Promise<boolean> =>
  await stat(path)
    .then(() => true)
    .catch(() => false);

const expandHome = (path: string, home: string): string =>
  path === '~'
    ? home
    : path.startsWith('~/')
      ? join(home, path.slice(2))
      : path.startsWith('$HOME/')
        ? join(home, path.slice(6))
        : path;

function frontmatter(markdown: string): { name: string; description: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/u)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u.exec(line);
    if (field) fields.set(field[1]!, field[2]!.replace(/^['"]|['"]$/gu, '').trim());
  }
  const name = fields.get('name')?.trim();
  const description = fields.get('description')?.trim();
  return name && description ? { name, description } : undefined;
}

async function skillsIn(
  directory: string,
  scope: AvailableSkill['scope'],
  origin: AvailableSkill['origin'],
): Promise<AvailableSkill[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = await Promise.all(
    entries
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(async entry => {
        const manifest = join(directory, entry.name, 'SKILL.md');
        const text = await readFile(manifest, 'utf8').catch(() => undefined);
        if (text === undefined || Buffer.byteLength(text) > MAX_SKILL_MANIFEST_BYTES) return undefined;
        const parsed = frontmatter(text);
        return parsed === undefined ? undefined : ({ ...parsed, scope, origin } satisfies AvailableSkill);
      }),
  );
  return result.filter((skill): skill is AvailableSkill => skill !== undefined);
}

/** Read-only filesystem catalog used by the production composition root. */
export class NodeCatalog implements CatalogSubsystem {
  constructor(private readonly options: NodeCatalogOptions) {}

  async projects(): Promise<ProjectList> {
    const found = new Set<string>();
    for (const rawRoot of this.options.projectRoots) {
      const root = expandHome(rawRoot, this.options.home);
      if (!(await exists(root))) continue;
      const consider = async (candidate: string): Promise<void> => {
        const absolute = resolve(candidate);
        if (await exists(join(absolute, '.git'))) found.add(absolute);
      };
      await consider(root);
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries
          .filter(
            entry =>
              (entry.isDirectory() || entry.isSymbolicLink()) &&
              (!entry.name.startsWith('.') || entry.name === '.config'),
          )
          .map(async entry => await consider(join(root, entry.name))),
      );
    }
    const projects = await Promise.all(
      [...found].map(async path => {
        const activity = await Promise.all([
          stat(path).catch(() => undefined),
          stat(join(path, '.git', 'HEAD')).catch(() => undefined),
        ]);
        const newest = Math.max(...activity.flatMap(value => (value === undefined ? [] : [value.mtimeMs])));
        return {
          name: basename(path),
          path,
          ...(Number.isFinite(newest) ? { lastActivity: new Date(newest).toISOString() } : {}),
        };
      }),
    );
    return projects.sort((left, right) => (right.lastActivity ?? '').localeCompare(left.lastActivity ?? ''));
  }

  async skills(session: SessionView): Promise<SessionSkills> {
    const { harness, cwd } = session.config;
    const globalRoot = join(this.options.home, harness === 'claude' ? '.claude' : '.codex', 'skills');
    const projectRoot = join(cwd, harness === 'claude' ? '.claude' : '.agents', 'skills');
    const origin: AvailableSkill['origin'] = harness;
    const global = await skillsIn(globalRoot, 'global', origin);
    const project = await skillsIn(projectRoot, 'project', origin);
    const merged = new Map(global.map(skill => [skill.name, skill]));
    for (const skill of project) merged.set(skill.name, skill);
    return { harness, skills: [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)) };
  }
}
