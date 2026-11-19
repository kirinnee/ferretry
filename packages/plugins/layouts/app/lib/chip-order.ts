/**
 * The pure half of the navigation chip grid: where a dragged chip belongs among chips laid out in rows and columns.
 * No DOM, so the rule is proved without one. A chip comes BEFORE the dragged one in reading order when it is on a row
 * above, or on the same row and further left; the dragged chip's place is the number of chips before it.
 */

/** A chip's middle, in the grid's own coordinates. */
export interface Centre {
  readonly x: number;
  readonly y: number;
}

/**
 * Where a chip dragged to `dragged` now belongs among the OTHER chips (`others`, in their order). `rowHeight` is the
 * height of one chip row: centres closer than half of it on the vertical axis are on the same row.
 */
export function chipDropIndex(others: readonly Centre[], dragged: Centre, rowHeight: number): number {
  const half = rowHeight / 2;
  return others.filter(other => {
    if (other.y < dragged.y - half) return true;
    if (other.y > dragged.y + half) return false;
    return other.x < dragged.x;
  }).length;
}
