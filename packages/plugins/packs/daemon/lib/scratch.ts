/**
 * WHERE A HELPER MAY RUN (docs/pack-mode.md): a helper works in its parent's folder, so it lands in the parent's project.
 * An agent's shell often sits somewhere else — its harness's own scratch folder (`/tmp/claude-…`, a Codex sandbox) — and
 * a helper started THERE would work on nothing the owner sees, in a project group of its own. So a folder that was NAMED
 * is refused when it is temporary, unless the caller says it means it (`fy new --allow-scratch`). Today's `scratch.ts`.
 *
 * Pure: the path, already resolved, and the temporary roots this machine has.
 */

/** The temporary roots every machine has, before its own `TMPDIR`. */
export const COMMON_SCRATCH_ROOTS: readonly string[] = [
  '/tmp',
  '/private/tmp',
  '/var/tmp',
  '/private/var/tmp',
  '/var/folders',
  '/private/var/folders',
];

/**
 * The roots as they REALLY are: each root with every link resolved (`/tmp` is `/private/tmp` on a Mac), kept beside its
 * spelling. A folder is judged by its resolved directory, so a root left as spelled would miss it (v4 realpathed both
 * sides). A root that cannot be resolved (it does not exist here) stays as spelled.
 */
export async function resolveScratchRoots(
  roots: readonly string[],
  realpath: (path: string) => Promise<string>,
): Promise<readonly string[]> {
  const resolved = await Promise.all(roots.map(async root => await realpath(root).catch(() => root)));
  return [...new Set([...roots, ...resolved])];
}

const trimmed = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, '') : path);

/** Whether `path` is one of `roots` or inside one. */
export function isScratchPath(path: string, roots: readonly string[]): boolean {
  const target = trimmed(path);
  return roots
    .map(trimmed)
    .filter(root => root !== '' && root !== '/')
    .some(root => target === root || target.startsWith(`${root}/`));
}

/** The refusal's sentence, naming the folder, with what to do about it. */
export const scratchRefusal = (path: string): string =>
  `${path} is a temporary folder, not a project: a helper started there works on nothing in your project and lands in a group of its own. Name the project folder with --cwd, or pass --allow-scratch if a temporary folder is really meant.`;
