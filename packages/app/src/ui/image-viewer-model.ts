/**
 * The viewer's arithmetic, kept pure so every gesture is asserted without a DOM.
 *
 * A view is a scale and a translation of the picture's CENTRE, in stage pixels. At scale 1 the picture
 * is fitted to the stage and cannot be panned; zoomed in, it can be panned until its edge meets the
 * stage edge and no further, so the reader can never drag it off the screen.
 */

export interface ViewTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

const MIN_SCALE = 1;
export const MAX_SCALE = 8;
export const DOUBLE_TAP_SCALE = 2.5;
export const IDENTITY: ViewTransform = { scale: 1, x: 0, y: 0 };

/** A horizontal drag this long, at scale 1, moves to the neighbouring picture. */
export const SWIPE_DISTANCE = 56;

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/** The picture's size when fitted inside the stage (contain), before any zoom. */
export const fittedSize = (natural: Size, stage: Size): Size => {
  if (natural.width <= 0 || natural.height <= 0 || stage.width <= 0 || stage.height <= 0) {
    return { width: 0, height: 0 };
  }
  const ratio = Math.min(stage.width / natural.width, stage.height / natural.height);
  return { width: natural.width * ratio, height: natural.height * ratio };
};

/** Keep the zoomed picture covering as much of the stage as it can: no gap opens beside it. */
export const clampTransform = (view: ViewTransform, fitted: Size, stage: Size): ViewTransform => {
  const scale = clamp(view.scale, MIN_SCALE, MAX_SCALE);
  const reachX = Math.max(0, (fitted.width * scale - stage.width) / 2);
  const reachY = Math.max(0, (fitted.height * scale - stage.height) / 2);
  return { scale, x: clamp(view.x, -reachX, reachX), y: clamp(view.y, -reachY, reachY) };
};

/**
 * Zoom to `scale` keeping the picture point under `focus` (stage coordinates, origin at the stage
 * centre) where it was — what a pinch or a wheel at the cursor means.
 */
export const zoomAround = (
  view: ViewTransform,
  scale: number,
  focus: Point,
  fitted: Size,
  stage: Size,
): ViewTransform => {
  const next = clamp(scale, MIN_SCALE, MAX_SCALE);
  const ratio = next / view.scale;
  return clampTransform(
    { scale: next, x: focus.x - (focus.x - view.x) * ratio, y: focus.y - (focus.y - view.y) * ratio },
    fitted,
    stage,
  );
};

export const panBy = (view: ViewTransform, dx: number, dy: number, fitted: Size, stage: Size): ViewTransform =>
  clampTransform({ ...view, x: view.x + dx, y: view.y + dy }, fitted, stage);

/** Double tap / double click: fit when zoomed, otherwise zoom in on the tapped point. */
export const toggleZoom = (view: ViewTransform, focus: Point, fitted: Size, stage: Size): ViewTransform =>
  view.scale > 1.01 ? IDENTITY : zoomAround(view, DOUBLE_TAP_SCALE, focus, fitted, stage);

/** The scale multiplier one wheel notch means. `ctrlKey` wheels are trackpad pinches and are finer. */
export const wheelScale = (deltaY: number, ctrlKey: boolean): number => Math.exp(-deltaY * (ctrlKey ? 0.01 : 0.0015));

/** The neighbour a finished drag asks for, or 0 when it asks for none. Only an unzoomed picture swipes. */
export const swipeStep = (view: ViewTransform, dx: number, dy: number): -1 | 0 | 1 => {
  if (view.scale > 1.01) return 0;
  if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.2) return 0;
  return dx < 0 ? 1 : -1;
};

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** `index` moved by `step`, wrapping nowhere: the first picture has no previous, the last no next. */
export const neighbour = (index: number, step: -1 | 1, count: number): number | null => {
  const next = index + step;
  return next < 0 || next >= count ? null : next;
};
