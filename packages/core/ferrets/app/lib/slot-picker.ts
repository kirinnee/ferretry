/**
 * Whether the shell's `PanelSlot` for a given slot drew a working picker. Both pages that offer a slot to Runtimes
 * (new ferret, move) read it the same way: a slot element that holds at least one `.fy-panel` and none of them is the
 * shell's one-line "cannot draw this" (`.fy-shell-line`: the contributing plugin is blocked, still loading or failed
 * on this daemon). Anything else leaves the page to draw its own typed runtime box.
 */

/** Whether `root` holds the named slot with at least one drawn panel and no shell line in it. */
export const holdsPicker = (root: HTMLElement | null, slotName: string): boolean => {
  const slot = root?.querySelector(`[data-slot="${slotName}"]`) ?? null;
  if (slot === null) return false;
  return slot.querySelector('.fy-panel') !== null && slot.querySelector('.fy-shell-line') === null;
};
