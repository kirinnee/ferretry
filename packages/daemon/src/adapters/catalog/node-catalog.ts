import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AvailableSkill, SessionSkills, SessionView } from '@ferretry/protocol';
import { skillFrontMatter } from '../../lib/skills/front-matter.ts';

const MAX_SKILL_MANIFEST_BYTES = 256 * 1024;

export interface NodeCatalogOptions {
  /** The daemon's own home: the fallback for a session that runs no fleet account. */
  readonly home: string;
  /**
   * The harness home of the fleet account a session runs as. A ferret runs against that home's skills, not the
   * daemon user's, so a resolved home wins over `home`.
   */
  readonly runtimeHome?: (session: SessionView) => Promise<string | undefined>;
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
        const parsed = skillFrontMatter(text);
        return parsed === undefined ? undefined : ({ ...parsed, scope, origin } satisfies AvailableSkill);
      }),
  );
  return result.filter((skill): skill is AvailableSkill => skill !== undefined);
}

/** Per-session skills catalog. Project registration lives in FileProjectCatalog. */
export class NodeCatalog {
  constructor(private readonly options: NodeCatalogOptions) {}

  async skills(session: SessionView): Promise<SessionSkills> {
    const { harness, cwd } = session.config;
    const runtimeHome = await this.options.runtimeHome?.(session);
    const globalRoot =
      runtimeHome === undefined
        ? join(this.options.home, harness === 'claude' ? '.claude' : '.codex', 'skills')
        : join(runtimeHome, 'skills');
    const projectRoot = join(cwd, harness === 'claude' ? '.claude' : '.agents', 'skills');
    const origin: AvailableSkill['origin'] = harness;
    const global = await skillsIn(globalRoot, 'global', origin);
    const project = await skillsIn(projectRoot, 'project', origin);
    const merged = new Map(global.map(skill => [skill.name, skill]));
    for (const skill of project) merged.set(skill.name, skill);
    return { harness, skills: [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)) };
  }
}
