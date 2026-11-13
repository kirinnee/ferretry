/**
 * WHERE A POPOVER GOES, given the button that opened it: under the button with its right edge on the button's, flipped
 * above it when the room below is short and the room above is longer, and always inside the window (a `margin` from
 * every edge). A popover drawn by this is `position: fixed` on the page body, so no card's `overflow` clips it and no
 * column's stacking hides it under a neighbour. `maxHeight` is what the menu may take at that spot; a longer menu
 * scrolls inside it. Pure, so the placement is asserted without a DOM (`context-menu.tsx` places a point-anchored menu
 * the same way, with `clampMenuPosition`).
 */

export interface PopoverAnchor {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface PopoverSize {
  readonly width: number;
  readonly height: number;
}

export interface PopoverPlace {
  readonly left: number;
  readonly top: number;
  readonly maxHeight: number;
}

export function placePopover(
  anchor: PopoverAnchor,
  size: PopoverSize,
  viewport: PopoverSize,
  margin = 8,
  gap = 4,
): PopoverPlace {
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const left = Math.min(Math.max(margin, anchor.right - size.width), maxLeft);
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  if (size.height <= below || below >= above) {
    return { left, top: anchor.bottom + gap, maxHeight: Math.min(size.height, Math.max(0, below)) };
  }
  const height = Math.min(size.height, Math.max(0, above));
  return { left, top: anchor.top - gap - height, maxHeight: height };
}
