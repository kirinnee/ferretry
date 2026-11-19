/**
 * The pure half of {@link SortableList}: the order arithmetic and the words a screen reader hears. No DOM, so every
 * rule is proved without one.
 */

/** A copy of `items` with the one at `from` moved to `to` (clamped into the list). The SAME array when nothing moves. */
export const moveItem = <T>(items: readonly T[], from: number, to: number): readonly T[] => {
  if (from < 0 || from >= items.length) return items;
  const target = Math.max(0, Math.min(items.length - 1, to));
  if (target === from) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved as T);
  return next;
};

/**
 * Where a dragged row now belongs: the number of OTHER rows whose middle is above the dragged row's middle. Both are
 * measured on the same axis (from the top of the list).
 */
export const dropIndex = (otherCentres: readonly number[], draggedCentre: number): number =>
  otherCentres.filter(centre => centre < draggedCentre).length;

/** True when two orders list the same keys in the same sequence. */
export const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((key, index) => key === b[index]);

const place = (index: number, count: number): string => `position ${index + 1} of ${count}`;

export const liftedMessage = (label: string, index: number, count: number): string =>
  `${label} lifted, ${place(index, count)}. Arrow keys move it, Enter drops it, Escape cancels.`;

export const movedMessage = (label: string, index: number, count: number): string =>
  `${label} moved to ${place(index, count)}.`;

export const droppedMessage = (label: string, index: number, count: number): string =>
  `${label} dropped at ${place(index, count)}.`;

export const cancelledMessage = (label: string, index: number, count: number): string =>
  `Reorder cancelled. ${label} is back at ${place(index, count)}.`;
