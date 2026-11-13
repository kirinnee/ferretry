/**
 * WHERE A MENU OPENS SO IT IS ALL ON SCREEN. The menu draws on the side its stylesheet gives it; this reads where that
 * put it and says how far to slide it sideways, and whether to open on the other side of its button, so no part of it
 * is outside the viewport. Pure, so each case is proved without a layout engine.
 */

export interface Edges {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Placement {
  /** Slide the menu this many pixels sideways (negative: left). */
  readonly dx: number;
  /** Open on the other side of the button than the stylesheet says. */
  readonly flip: boolean;
}

const GAP = 4;

/** Sideways: nearest shift that fits (the left edge wins when the menu is wider than the screen). Vertical: swap only when it helps. */
export const placeWithin = (
  menu: Edges,
  trigger: Edges,
  viewport: { readonly width: number; readonly height: number },
  margin: number,
): Placement => {
  const overRight = menu.right - (viewport.width - margin);
  const dx = menu.left < margin ? margin - menu.left : overRight > 0 ? -Math.min(overRight, menu.left - margin) : 0;
  const height = menu.bottom - menu.top;
  const below = menu.top >= trigger.bottom;
  const fitsBelow = trigger.bottom + GAP + height <= viewport.height - margin;
  const fitsAbove = trigger.top - GAP - height >= margin;
  const flip = below ? menu.bottom > viewport.height - margin && fitsAbove : menu.top < margin && fitsBelow;
  return { dx, flip };
};
