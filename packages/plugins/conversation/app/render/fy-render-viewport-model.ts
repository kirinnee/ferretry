/**
 * HOW A DIAGRAM FITS, ZOOMS AND PANS — pure functions, no DOM.
 *
 * A compiled Mermaid diagram (and an authored SVG) is shown through a VIEWPORT: a box the width of the message
 * column, holding the picture at a `scale`, shifted by an offset. The component (`fy-render-viewport.tsx`) owns
 * the gestures; every decision about numbers lives here so the component and the tests read one definition.
 *
 *   - FIT: at rest the whole picture is visible. It is scaled DOWN to the column and to a height ceiling, never
 *     up (inline), so nothing is clipped and nothing scrolls the page sideways.
 *   - LEGIBLE: Mermaid's text is 16px at scale 1. If fitting would make it smaller than {@link MIN_TEXT_PX} the
 *     picture rests at the smallest legible scale instead and is panned, because a whole diagram nobody can read
 *     is not a fit. Fullscreen is the exception: it rests on the whole picture and the reader zooms in.
 *   - ZOOM about a point (the cursor, the pinch midpoint, the tapped spot) between the fit and a ceiling.
 *   - PAN, clamped so the picture can never be dragged out of the box. A picture smaller than the box on an axis is
 *     centred on it and has nothing to pan there.
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Where the picture is: its scale (display px per natural px) and its top-left corner inside the box. */
export interface View {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

/** Mermaid's default text size: what a compiled diagram's text measures at scale 1. */
const MERMAID_TEXT_PX = 16;

/** The smallest text a diagram is rested at inline. Below this it is panned at this size instead of fitted. */
const MIN_TEXT_PX = 10;

/** The scale at which Mermaid's text is {@link MIN_TEXT_PX}. */
export const MERMAID_LEGIBLE_SCALE = MIN_TEXT_PX / MERMAID_TEXT_PX;

/** The inline height ceiling, as a share of the screen's height, and in px. Mirrors `.fy-render-image`'s `60dvh`. */
const INLINE_HEIGHT_SHARE = 0.6;
const INLINE_HEIGHT_CAP_PX = 800;

/** A button press, a `+` key and a double tap each change the scale by this factor. */
export const ZOOM_STEP = 1.25;

/** A picture drawn beyond this multiple of its resting scale counts as zoomed in. */
const ZOOMED_IN_BEYOND = 1.05;

/** A double tap zooms to this multiple of the resting scale. */
export const DOUBLE_TAP_ZOOM = 2.5;

/** The most a picture is ever enlarged to, as a multiple of natural size, and the widest it may become in px. */
const MAX_SCALE = 8;
const MAX_DISPLAY_PX = 8_000;

/** Fullscreen has the whole screen to spend and may enlarge a small picture up to this multiple of natural size. */
const FULLSCREEN_MAX_REST_SCALE = 2;

/** How far a key press pans, in px. */
export const KEY_PAN_PX = 48;

/** Where a picture that overflows the box starts: its left edge, or its horizontal middle (a tree's root). */
export type RestAnchor = 'start' | 'centre';

export interface ViewportPlan {
  /** Where an overflowing picture starts across the box. It always starts at the top. */
  readonly anchor: RestAnchor;
  /** The box the picture is shown in, in px. */
  readonly box: Size;
  /** The scale at which the whole picture is visible. */
  readonly fit: number;
  /** The scale it is shown at rest: the fit, or the legible floor when the fit would be too small to read. */
  readonly rest: number;
  /** The zoom range. `min` is the fit, so a reader can always get the whole picture back. */
  readonly min: number;
  readonly max: number;
  /** True when the resting picture is larger than the box on some axis, so it must be panned even at rest. */
  readonly pansAtRest: boolean;
}

export interface PlanInput {
  readonly natural: Size;
  /** Where an overflowing picture starts across the box (default: its left edge). */
  readonly anchor?: RestAnchor;
  /** The column the box lives in, in px. A column that could not be measured (0) is treated as wide enough. */
  readonly columnWidth: number;
  /** The tallest the box may be inline, in px (usually {@link inlineMaxHeight}). Ignored when `fullscreen`. */
  readonly maxHeight: number;
  /** The space fullscreen gives the box. Its presence IS fullscreen. */
  readonly fullscreenBox?: Size;
  /** The scale below which text is unreadable, or 0 when nothing is known about the picture's text. */
  readonly legibleScale: number;
}

/** The height ceiling inline: 60% of the screen, but never past {@link INLINE_HEIGHT_CAP_PX}. */
export function inlineMaxHeight(screenHeight: number): number {
  const share = screenHeight > 0 ? screenHeight * INLINE_HEIGHT_SHARE : INLINE_HEIGHT_CAP_PX;
  return Math.max(120, Math.min(INLINE_HEIGHT_CAP_PX, share));
}

/** The scale that makes a picture exactly fill a box, never enlarging beyond `ceiling`. */
export function fitScale(natural: Size, box: Size, ceiling = 1): number {
  const across = box.width > 0 ? box.width / natural.width : ceiling;
  const down = box.height > 0 ? box.height / natural.height : ceiling;
  return Math.min(ceiling, across, down);
}

/**
 * The plan for one picture in one place.
 *
 * Inline, the box is the column wide and as tall as the picture at its resting scale, up to the ceiling. In
 * fullscreen it is the screen the host offered, and the picture may be enlarged up to twice its natural size.
 */
export function planViewport(input: PlanInput): ViewportPlan {
  const { natural, legibleScale } = input;
  const fullscreen = input.fullscreenBox !== undefined;
  const available: Size = fullscreen
    ? (input.fullscreenBox as Size)
    : { height: input.maxHeight, width: input.columnWidth > 0 ? input.columnWidth : natural.width };
  const fit = fitScale(natural, available, fullscreen ? FULLSCREEN_MAX_REST_SCALE : 1);
  const rest = fullscreen ? fit : Math.max(fit, Math.min(legibleScale, 1));
  const box: Size = fullscreen
    ? available
    : { height: Math.min(available.height, Math.max(1, Math.round(natural.height * rest))), width: available.width };
  const min = Math.min(fit, rest);
  const ceiling = Math.max(rest, Math.min(MAX_SCALE, MAX_DISPLAY_PX / natural.width, MAX_DISPLAY_PX / natural.height));
  const max = Math.max(ceiling, rest * ZOOM_STEP);
  return {
    anchor: input.anchor ?? 'start',
    box,
    fit,
    max,
    min,
    pansAtRest: natural.width * rest > box.width + 0.5 || natural.height * rest > box.height + 0.5,
    rest,
  };
}

const between = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** One axis of a pan: centred when the picture is smaller than the box, otherwise held inside it. */
const clampAxis = (offset: number, content: number, box: number): number =>
  content <= box ? (box - content) / 2 : between(offset, box - content, 0);

/** Holds a view inside the box: scale in range, picture never dragged out of sight. */
export function clampView(view: View, plan: ViewportPlan, natural: Size): View {
  const scale = between(view.scale, plan.min, plan.max);
  return {
    scale,
    x: clampAxis(view.x, natural.width * scale, plan.box.width),
    y: clampAxis(view.y, natural.height * scale, plan.box.height),
  };
}

/**
 * The view at rest: the picture centred when it fits, otherwise at its top — the start of a flowchart is where a
 * reader begins — and at its left edge, or its horizontal middle for a top-down tree whose root sits there.
 */
export function restView(plan: ViewportPlan, natural: Size): View {
  const x = plan.anchor === 'centre' ? (plan.box.width - natural.width * plan.rest) / 2 : 0;
  return clampView({ scale: plan.rest, x, y: 0 }, plan, natural);
}

/** Which edges of the box have more picture beyond them, so the reader can be shown that it drags. */
export interface Edges {
  readonly left: boolean;
  readonly right: boolean;
  readonly top: boolean;
  readonly bottom: boolean;
}

export function moreBeyond(view: View, plan: ViewportPlan, natural: Size): Edges {
  return {
    bottom: view.y + natural.height * view.scale > plan.box.height + 0.5,
    left: view.x < -0.5,
    right: view.x + natural.width * view.scale > plan.box.width + 0.5,
    top: view.y < -0.5,
  };
}

/** Whether a view is the one at rest (within rounding), so Reset has nothing to do. */
export function isAtRest(view: View, plan: ViewportPlan, natural: Size): boolean {
  const rest = restView(plan, natural);
  return Math.abs(view.scale - rest.scale) < 0.001 && Math.abs(view.x - rest.x) < 1 && Math.abs(view.y - rest.y) < 1;
}

/** Changes the scale to `scale` while keeping the point `focal` (in box px) over the same spot of the picture. */
export function zoomTo(view: View, plan: ViewportPlan, natural: Size, scale: number, focal: Point): View {
  const next = between(scale, plan.min, plan.max);
  const ratio = next / view.scale;
  return clampView(
    { scale: next, x: focal.x - (focal.x - view.x) * ratio, y: focal.y - (focal.y - view.y) * ratio },
    plan,
    natural,
  );
}

/** Zooms by a factor about a point. */
export function zoomBy(view: View, plan: ViewportPlan, natural: Size, factor: number, focal: Point): View {
  return zoomTo(view, plan, natural, view.scale * factor, focal);
}

/** The middle of the box: where a button or a key zooms about. */
export function boxCentre(plan: ViewportPlan): Point {
  return { x: plan.box.width / 2, y: plan.box.height / 2 };
}

/** Moves the picture by a delta in box px. */
export function panBy(view: View, plan: ViewportPlan, natural: Size, dx: number, dy: number): View {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, plan, natural);
}

/**
 * A double tap: from anywhere near rest it zooms in on the spot, and from a zoomed view it goes back to rest.
 */
export function toggleZoom(view: View, plan: ViewportPlan, natural: Size, focal: Point): View {
  if (!isAtRest(view, plan, natural) && view.scale > plan.rest * ZOOMED_IN_BEYOND) return restView(plan, natural);
  return zoomTo(view, plan, natural, plan.rest * DOUBLE_TAP_ZOOM, focal);
}

/** The scale a Ctrl+wheel or trackpad pinch step asks for, from the wheel's `deltaY` (any `deltaMode`-less value). */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-between(deltaY, -120, 120) * 0.01);
}

/**
 * The axes the BROWSER may keep for itself on a touch, as a `touch-action` value.
 *
 * Whatever the picture can be panned along is ours; whatever it cannot is left to the transcript's scroll, so a
 * diagram that is wholly visible never traps a thumb that only wanted to scroll the page.
 *
 * INLINE AND NOT ZOOMED IN, a vertical drag is ALWAYS the page's, even when the resting picture is taller than its
 * box (a legible-floor diagram): the transcript must stay scrollable under a thumb that lands on a diagram. A reader
 * who wants to move around a picture zooms it first. Zoomed in, or in fullscreen (no page behind it), the picture
 * takes the axes it can move along.
 */
export function touchActionFor(view: View, plan: ViewportPlan, natural: Size, fullscreen = false): string {
  const overX = natural.width * view.scale > plan.box.width + 0.5;
  const overY = natural.height * view.scale > plan.box.height + 0.5;
  if (!fullscreen && view.scale <= plan.rest * ZOOMED_IN_BEYOND) return overX ? 'pan-y' : 'pan-x pan-y';
  if (overX && overY) return 'none';
  if (overX) return 'pan-y';
  if (overY) return 'pan-x';
  return 'pan-x pan-y';
}

/** The distance and midpoint of two touches, for a pinch. */
export function pinchOf(a: Point, b: Point): { readonly distance: number; readonly centre: Point } {
  return { centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) };
}

const VIEW_BOX = /^\s*<svg\b[^>]*?\sviewBox\s*=\s*"\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/iu;
const ROOT_TAG = /^\s*<svg\b[^>]*>/iu;

/** One declared root length in px, or `null` when it is absent, a percentage or has another unit. */
function declaredPx(tag: string, name: 'width' | 'height'): number | null {
  const found = new RegExp(`\\s${name}\\s*=\\s*"\\s*([\\d.]+)\\s*(?:px)?\\s*"`, 'iu').exec(tag);
  if (found === null) return null;
  const value = Number(found[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** A compiled diagram's natural size, from its root `viewBox`, or `null` when it declares none. */
export function viewBoxSize(svg: string): Size | null {
  const found = VIEW_BOX.exec(svg);
  if (found === null) return null;
  const width = Number(found[3]);
  const height = Number(found[4]);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { height, width } : null;
}

/**
 * An authored SVG's natural size: the pixel `width` and `height` it declares when both are plain lengths,
 * otherwise its `viewBox`. `null` when neither is there, and the picture is then shown as a plain image.
 */
export function svgNaturalSize(svg: string): Size | null {
  const tag = ROOT_TAG.exec(svg)?.[0];
  if (tag !== undefined) {
    const width = declaredPx(tag, 'width');
    const height = declaredPx(tag, 'height');
    if (width !== null && height !== null) return { height, width };
  }
  return viewBoxSize(svg);
}
