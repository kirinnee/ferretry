/**
 * What a pull request changed: the one place that asks git. `scope.ts` (which tests run) and `one-folder.ts` (is every file
 * outside the PR's home folder explained) both read the PR's own diff, so both read it from here. No dependency beyond
 * `node:child_process`: the one-folder job runs without `bun install`.
 */
import { spawnSync } from 'node:child_process';

export const git = (root: string, args: readonly string[]): { ok: boolean; out: string } => {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { ok: run.status === 0, out: run.stdout ?? '' };
};

const SHA = /^[0-9a-f]{7,64}$/;

/** `git diff --name-only --no-renames <base>...<head>`; undefined with the reason when the merge-base is missing. */
export function changedFiles(
  root: string,
  base: string,
  head: string,
): { readonly files: string[] } | { readonly error: string } {
  if (!SHA.test(base) || !SHA.test(head)) return { error: 'the base or head sha is missing' };
  const mergeBase = git(root, ['merge-base', base, head]);
  if (!mergeBase.ok || mergeBase.out.trim() === '')
    return { error: `no merge-base of ${base} and ${head} in this checkout` };
  const diff = git(root, ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`]);
  if (!diff.ok) return { error: `git diff ${base}...${head} failed` };
  return { files: diff.out.split('\0').filter(file => file !== '') };
}

/**
 * Changed lines (added + deleted) per file over the same merge-base range, same `--no-renames` listing as
 * `changedFiles`. A binary file counts as one line, so it still has a say in which folder owns the change.
 */
export function changedLines(
  root: string,
  base: string,
  head: string,
): { readonly lines: ReadonlyMap<string, number> } | { readonly error: string } {
  if (!SHA.test(base) || !SHA.test(head)) return { error: 'the base or head sha is missing' };
  const diff = git(root, ['diff', '--numstat', '--no-renames', '-z', `${base}...${head}`]);
  if (!diff.ok) return { error: `git diff --numstat ${base}...${head} failed` };
  const lines = new Map<string, number>();
  for (const record of diff.out.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
    if (match === null) continue;
    const [, added, deleted, file] = match;
    const count = added === '-' || deleted === '-' ? 1 : Number(added) + Number(deleted);
    lines.set(file as string, Math.max(count, 1));
  }
  return { lines };
}
