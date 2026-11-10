import { basename, dirname } from 'node:path';
import type { RootHandle } from '@ferretry/kernel/contract';
import type { SkillDirectoryEntry, SkillFilesPort } from '../lib/inventory.ts';
import { RootSkillFiles } from './skill-files.ts';

const SKILL_FILE = 'SKILL.md';
/** The two folders a harness reads project skills from: Claude `<root>/.claude/skills`, Codex `<root>/.agents/skills`. */
const PROJECT_SKILLS = /^(.+)\/(?:\.claude|\.agents)\/skills$/u;

const withoutTrailingSlash = (path: string): string => path.replace(/(?<=.)\/+$/u, '');

/**
 * The skills of a REGISTERED project root, read through the kernel's read-only `imports` root scoped to ONE skills
 * folder of that root (`<root>/.claude/skills` or `<root>/.agents/skills`) — never to the project root itself, so no
 * other file of the project is reachable, and never the file system directly.
 *
 * What this adds to the kernel's scoping (the kernel's `imports` root takes any absolute folder outside the fence, so
 * these are THIS adapter's, as MCP's `.mcp.json` reader's are):
 * - the folder must be exactly `<a registered root>/.claude/skills` or `.agents/skills`; any other folder, a folder of
 *   a root nobody registered, and a path that is not `<that folder>/<name>/SKILL.md` answer nothing;
 * - a skills folder that is a link, or sits under one, answers nothing: its real path must be the folder as named.
 *   The kernel keeps every listed folder and file INSIDE the scoped folder (`link_escape`, `hard_link`), but it FOLLOWS a
 *   link in the scoped folder's own path (probed on the real `imports` root), so this `realPath` check is the one guard
 *   for the folder itself. The real-disk test is its proof.
 *
 * Residual: the check runs in `#files()` and the read follows through the same lexical handle, so a skills folder swapped
 * for a link between the two lets one bounded `SKILL.md` read (at most the caller's `maxBytes`) go through the link. The
 * listed-only rule and the fence still apply, and whoever can swap the folder already writes the project on this host.
 */
export class ProjectSkillFiles implements SkillFilesPort {
  constructor(
    private readonly roots: () => Promise<readonly string[]>,
    private readonly open: (folder: string) => RootHandle,
  ) {}

  /** Whether `directory` is a skills folder of a registered root. */
  async claims(directory: string): Promise<boolean> {
    const match = PROJECT_SKILLS.exec(directory);
    if (match === null) return false;
    const root = withoutTrailingSlash(match[1]!);
    return (await this.roots()).some(known => withoutTrailingSlash(known) === root);
  }

  async list(directory: string, limit: number): Promise<readonly SkillDirectoryEntry[]> {
    return (await this.#files(directory))?.list(directory, limit) ?? [];
  }

  async read(path: string, maxBytes: number): Promise<string | undefined> {
    if (basename(path) !== SKILL_FILE) return undefined;
    const directory = dirname(dirname(path));
    return await (await this.#files(directory))?.read(path, maxBytes);
  }

  async #files(directory: string): Promise<RootSkillFiles | undefined> {
    if (!(await this.claims(directory))) return undefined;
    try {
      const handle = this.open(directory);
      const base = handle.resolve('');
      if (!base.ok || (await handle.realPath(base.value)) !== base.value) return undefined;
      return new RootSkillFiles(handle, directory);
    } catch {
      return undefined;
    }
  }
}
