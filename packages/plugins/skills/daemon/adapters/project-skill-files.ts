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
 * - the kernel is asked for the `imports` root with the registered project folder as its `within` anchor: the project
 *   folder itself may be a link (a project reached through a linked workspace still lists and reads), but a link at
 *   `.claude`, at `.claude/skills` or anywhere between the project folder and the skills folder makes every call on the
 *   root refuse `link_escape`, which this reader shows as nothing (an empty listing, no text). The kernel judges that
 *   at every call, right before the folder is touched, so a skills folder swapped for a link after an earlier call is
 *   refused at the next one. The root reaches the skills folder BY DESCRIPTOR: the project folder is opened once and
 *   proven, and each folder below it is opened from its parent's descriptor without following a link, so a skills
 *   folder swapped for a link at any step of ONE call is refused (`link_escape`) and reads nothing. Residual: a host that
 *   reaches an open folder by neither `/proc/self/fd` nor the C library's descriptor calls keeps the by-path read after
 *   the link walk, where one bounded read (at most the caller's `maxBytes`, one `SKILL.md`) could pass a swap landing
 *   inside one call; the daemon's doctor says so once at boot. The kernel also keeps every listed folder and file INSIDE
 *   the scoped folder (`link_escape`, `hard_link`).
 */
export class ProjectSkillFiles implements SkillFilesPort {
  /** `open(folder, within)` is the kernel's `imports` root scoped to `folder`, anchored at the registered project folder `within`. */
  constructor(
    private readonly roots: () => Promise<readonly string[]>,
    private readonly open: (folder: string, within: string) => RootHandle,
  ) {}

  /** Whether `directory` is a skills folder of a registered root. */
  async claims(directory: string): Promise<boolean> {
    return (await this.#registeredRoot(directory)) !== undefined;
  }

  /** The registered project folder `directory` is the skills folder of, as it was registered. */
  async #registeredRoot(directory: string): Promise<string | undefined> {
    const match = PROJECT_SKILLS.exec(directory);
    if (match === null) return undefined;
    const root = withoutTrailingSlash(match[1]!);
    return (await this.roots()).some(known => withoutTrailingSlash(known) === root) ? root : undefined;
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
    const root = await this.#registeredRoot(directory);
    if (root === undefined) return undefined;
    try {
      return new RootSkillFiles(this.open(directory, root), directory);
    } catch {
      return undefined;
    }
  }
}
