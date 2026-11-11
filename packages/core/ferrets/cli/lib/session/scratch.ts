/**
 * WHERE A HELPER FERRET MAY RUN: a helper works in its parent's folder, so it lands in the parent's project. An
 * agent's shell often sits somewhere else — its harness's own scratch folder (`/tmp/claude-…`, a Codex sandbox) — and
 * a helper started THERE would work on nothing the owner sees, in a project group of its own. So a folder that was
 * NAMED (an explicit `--cwd`, or a person's own shell folder) is refused when it is temporary, unless the caller says
 * it means it.
 *
 * Pure over an injected resolver: the shell's `realpath` follows the links, so a link INTO a temporary folder is caught.
 */
import { resolve } from 'node:path';

/** The temporary roots every machine has, before its own `TMPDIR` and the runtime's temp folder. */
export const COMMON_SCRATCH_ROOTS: readonly string[] = [
  '/tmp',
  '/private/tmp',
  '/var/tmp',
  '/private/var/tmp',
  '/var/folders',
  '/private/var/folders',
];

const trimmed = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, '') : path);

/** Whether `path` is one of `roots` or inside one. */
export function isScratchPath(path: string, roots: readonly string[]): boolean {
  const target = trimmed(path);
  return roots
    .map(trimmed)
    .filter(root => root !== '' && root !== '/')
    .some(root => target === root || target.startsWith(`${root}/`));
}

/** Where a path really is (symlinks followed); rejects when it cannot be resolved. The shell's `CliContext.realpath`. */
export type Realpath = (path: string) => Promise<string>;

/**
 * Whether the folder is temporary, judged where it really is (today's `fyd.ts` canonicalisation): made absolute and
 * normalised (`/home/../tmp/x` is `/tmp/x`, `/tmp/../home/me` is not), then resolved through its links, and the roots
 * too, so `/tmp` being `/private/tmp` on macOS and a link into a temporary folder both count. A path that cannot be
 * resolved is judged by its normalised self, and the roots are kept in both spellings.
 */
export async function isTemporaryFolder(
  folder: string,
  roots: readonly string[],
  realpath?: Realpath,
): Promise<boolean> {
  const real = async (path: string): Promise<string> => {
    const absolute = resolve(path);
    return realpath === undefined ? absolute : await realpath(absolute).catch(() => absolute);
  };
  // An empty root names nothing; `resolve('')` would be the working folder.
  const named = roots.filter(root => root !== '');
  const resolved = await Promise.all(named.map(real));
  return isScratchPath(await real(folder), [...named.map(root => resolve(root)), ...resolved]);
}

/** The refusal's sentence, naming the folder. */
export const scratchMessage = (path: string): string =>
  `${path} is a temporary folder, not a project: a helper ferret started there works on nothing in your project and lands in a group of its own.`;

export const SCRATCH_REMEDY =
  "Leave --cwd out to run it in the parent ferret's folder, name the project folder with --cwd, or pass --allow-scratch if a temporary folder is really meant.";
