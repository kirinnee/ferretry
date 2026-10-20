/**
 * WHERE A SUB-FERRET MAY RUN (docs/pack-mode.md): a sub-ferret works in its parent's folder, so it lands in
 * the parent's project. An agent's shell often sits somewhere else — its harness's own scratch folder
 * (`/tmp/claude-…`, a Codex sandbox) — and a sub-ferret started THERE would work on nothing the owner
 * sees, in a project group of its own. So a folder that was NAMED (an explicit `--cwd`, or a top-level
 * start's own folder) is refused when it is temporary, unless the caller says it means it.
 *
 * Pure: the path, already resolved, and the temporary roots this machine has.
 */

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

/** The refusal's sentence, naming the folder. */
export const scratchMessage = (path: string): string =>
  `${path} is a temporary folder, not a project: a sub-ferret started there works on nothing in your project and lands in a group of its own.`;

export const SCRATCH_REMEDY =
  "Leave --cwd out to run it in the parent ferret's folder, name the project folder with --cwd, or pass --allow-scratch if a temporary folder is really meant.";
