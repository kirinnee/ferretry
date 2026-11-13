/**
 * Counts the background terminals codex reports in its pane footer.
 *
 * Their children are not under the pane pid and carry no argv, so the process walk cannot see them
 * at all. The count is the only evidence they exist, which is why the report treats a positive one
 * as unaccountable work rather than as something it can classify.
 */
export function backgroundTerminalCount(pane: string): number {
  const match = pane.toLowerCase().match(/(\d+)\s+background\s+terminals?\s+running/);
  return match ? Number(match[1]) : 0;
}
