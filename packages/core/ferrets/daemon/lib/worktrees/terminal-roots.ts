import type { TerminalRootsSource } from '../../../contract/index.ts';

/**
 * The live-shell evidence a worktree removal is judged on, from whoever contributed shells to `terminal.roots`.
 *
 * No contributor means no plugin runs shells, so no shell stands in any checkout: the answer is empty. A contributor
 * that cannot list its shells makes the whole answer `undefined` (unknown), which the removal policy refuses on and no
 * override clears; it is never read as "none".
 */
/** Hold every contributor's launch exclusion across all evidence reads and the Git remove call. */
export async function withTerminalRemoval<T>(
  sources: readonly TerminalRootsSource[],
  path: string,
  remove: () => Promise<T>,
): Promise<T> {
  const [first, ...rest] = sources;
  return first === undefined
    ? await remove()
    : await first.withRemoval(path, () => withTerminalRemoval(rest, path, remove));
}

export async function liveTerminalRoots(
  sources: readonly TerminalRootsSource[],
): Promise<readonly string[] | undefined> {
  const roots: string[] = [];
  for (const source of sources) {
    try {
      roots.push(...(await source.roots()));
    } catch {
      return undefined;
    }
  }
  return roots;
}
