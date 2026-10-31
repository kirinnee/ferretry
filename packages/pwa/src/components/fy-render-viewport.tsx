/**
 * A PICTURE YOU CAN FIT, ZOOM AND MOVE — the way GitHub shows a Mermaid diagram.
 *
 * A compiled diagram (and an authored SVG with a size) is shown inside a box the width of the message column.
 * At rest the WHOLE picture is in that box, scaled down to fit and never up (`lib/fy-render-viewport.ts` holds
 * every number). From there a reader can:
 *
 *   - press Zoom in / Zoom out / Reset zoom, or, with the box focused, `+` `-` `0` and the arrow keys;
 *   - drag to pan, pinch to zoom, double-tap (or double-click) to zoom in on a spot and again to come back;
 *   - hold Ctrl (or Cmd) and scroll, or pinch a trackpad, to zoom about the cursor;
 *   - open the block fullscreen, where the same box takes the whole screen.
 *
 * A PLAIN WHEEL SCROLLS THE PAGE, and so does a finger that is not needed for panning. The box never takes a
 * gesture it has no use for: `touch-action` is derived from what the picture can actually be panned along, so a
 * diagram that is wholly visible leaves every touch to the transcript. Fullscreen has no page behind it to
 * scroll, so there a plain wheel pans.
 *
 * THE PICTURE STAYS AN `<img>`, with its `src` the same `data:image/svg+xml` URL as before — this file changes
 * where the image is put and how large it is drawn, never what it is (`docs/fy-render.md`, "The `<img>` sink").
 * It is resized (width and height), not CSS-scaled, so the browser re-rasterises the vector at the zoomed size and
 * text stays sharp; only the offset is a `transform`.
 *
 * REDUCED MOTION: the box eases a button or key zoom over a moment (CSS, `fy-render.css`); under
 * `prefers-reduced-motion: reduce` it jumps. A drag or a pinch never eases.
 */

import { Scan, ZoomIn, ZoomOut } from 'lucide-react';
import {
  type KeyboardEvent,
  type PointerEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  boxCentre,
  clampView,
  inlineMaxHeight,
  isAtRest,
  KEY_PAN_PX,
  type Point,
  panBy,
  pinchOf,
  planViewport,
  restView,
  type Size,
  toggleZoom,
  touchActionFor,
  type View,
  type ViewportPlan,
  wheelFactor,
  ZOOM_STEP,
  zoomBy,
  zoomTo,
} from '../lib/fy-render-viewport.ts';

/** A press that moves less than this is a tap, not the start of a pan. */
const TAP_SLOP_PX = 6;
/** Two taps this close in time and space are a double tap. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DISTANCE_PX = 32;

export interface FyRenderViewportProps {
  /** The picture's URL: a `data:image/svg+xml` the caller built. */
  readonly src: string;
  readonly alt: string;
  /** The picture's natural size, from its root `viewBox` or declared size. */
  readonly natural: Size;
  /** The scale below which its text is unreadable, or 0 when nothing is known about it. */
  readonly legibleScale: number;
  readonly fullscreen: boolean;
  /** What the picture is called to a screen reader: "Diagram" or "Illustration". */
  readonly kind: string;
  /** True for a compiled Mermaid diagram: it carries `data-fy-render-diagram` for the tests and the shots. */
  readonly diagram: boolean;
  readonly onError: (event: SyntheticEvent<HTMLImageElement>) => void;
}

interface Measure {
  readonly width: number;
  readonly height: number;
  /** The screen's height, for the inline ceiling. */
  readonly screen: number;
}

/** The box's room, read from its element and the window; re-read on every resize of either. */
function useMeasure(ref: { readonly current: HTMLDivElement | null }, fullscreen: boolean): Measure | null {
  const [measure, setMeasure] = useState<Measure | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fullscreen` changes the box, so it is measured again before paint
  useLayoutEffect(() => {
    const element = ref.current;
    const read = (): void => {
      const next: Measure = {
        height: Math.round(element?.clientHeight ?? 0),
        screen: typeof window === 'undefined' ? 0 : window.innerHeight,
        width: Math.round(element?.clientWidth ?? 0),
      };
      setMeasure(previous =>
        previous?.width === next.width && previous.height === next.height && previous.screen === next.screen
          ? previous
          : next,
      );
    };
    read();
    window.addEventListener('resize', read);
    if (element === null || typeof ResizeObserver === 'undefined')
      return () => window.removeEventListener('resize', read);
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => {
      window.removeEventListener('resize', read);
      observer.disconnect();
    };
  }, [ref, fullscreen]);
  return measure;
}

type Gesture =
  | { readonly kind: 'none' }
  | { readonly kind: 'drag'; readonly id: number; readonly last: Point; readonly start: Point; readonly at: number }
  | {
      readonly kind: 'pinch';
      readonly distance: number;
      readonly centre: Point;
      readonly view: View;
    };

export function FyRenderViewport({
  src,
  alt,
  natural,
  legibleScale,
  fullscreen,
  kind,
  diagram,
  onError,
}: FyRenderViewportProps) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<HTMLDivElement | null>(null);
  const hintId = useId();
  const measure = useMeasure(outerRef, fullscreen);

  const plan: ViewportPlan | null = useMemo(() => {
    if (measure === null) return null;
    const room: Size = { height: measure.height, width: measure.width };
    return planViewport({
      columnWidth: measure.width,
      legibleScale,
      natural,
      maxHeight: inlineMaxHeight(measure.screen),
      ...(fullscreen && room.width > 0 && room.height > 0 ? { fullscreenBox: room } : {}),
    });
  }, [measure, natural, legibleScale, fullscreen]);

  /** `null` is "at rest": the view follows the plan as the column or the screen changes. Any gesture pins it. */
  const [moved, setMoved] = useState<View | null>(null);
  const view: View | null =
    plan === null ? null : moved === null ? restView(plan, natural) : clampView(moved, plan, natural);

  // Entering or leaving fullscreen is a different box, so it starts from rest; so does a different picture.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps ARE the reset triggers
  useEffect(() => setMoved(null), [fullscreen, src]);

  const latest = useRef<{ view: View | null; plan: ViewportPlan | null }>({ plan: null, view: null });
  latest.current = { plan, view };

  /** Applies a change to the CURRENT view, so a burst of events in one frame composes instead of overwriting. */
  const change = useCallback((next: (view: View, plan: ViewportPlan) => View): void => {
    const { plan: p, view: v } = latest.current;
    if (p === null || v === null) return;
    const after = next(v, p);
    latest.current = { plan: p, view: after };
    setMoved(after);
  }, []);

  const reset = useCallback((): void => {
    latest.current = { plan: latest.current.plan, view: null };
    setMoved(null);
  }, []);

  const zoomIn = (): void => change((v, p) => zoomBy(v, p, natural, ZOOM_STEP, boxCentre(p)));
  const zoomOut = (): void => change((v, p) => zoomBy(v, p, natural, 1 / ZOOM_STEP, boxCentre(p)));

  // ---- Ctrl/Cmd + wheel (and a trackpad pinch, which arrives as one) zooms about the cursor. A plain wheel is
  // left alone: it scrolls the page. Native and non-passive, because React's `onWheel` cannot cancel.
  const ready = plan !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ready` re-attaches once the pan box exists
  useEffect(() => {
    const element = panRef.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent): void => {
      const { plan: p, view: v } = latest.current;
      if (p === null || v === null) return;
      const rect = element.getBoundingClientRect();
      const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        change((current, planNow) => zoomBy(current, planNow, natural, wheelFactor(event.deltaY), at));
        return;
      }
      // Fullscreen has no page behind it to scroll: a plain wheel moves the picture instead.
      if (
        fullscreen &&
        (natural.width * v.scale > p.box.width + 0.5 || natural.height * v.scale > p.box.height + 0.5)
      ) {
        event.preventDefault();
        change((current, planNow) => panBy(current, planNow, natural, -event.deltaX, -event.deltaY));
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [change, fullscreen, natural, ready]);

  // ---- pointers: one pans, two pinch, two quick taps zoom.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>({ kind: 'none' });
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  const [dragging, setDragging] = useState(false);

  const local = (event: PointerEvent<HTMLElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const startDrag = (id: number, point: Point): void => {
    gesture.current = { at: Date.now(), id, kind: 'drag', last: point, start: point };
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that already ended, or an environment without capture: the gesture still works unpinned.
    }
    if (pointers.current.size === 1) startDrag(event.pointerId, point);
    else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      const { centre, distance } = pinchOf(a, b);
      const v = latest.current.view;
      if (v !== null && distance > 0) gesture.current = { centre, distance, kind: 'pinch', view: v };
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    const g = gesture.current;
    if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      const now = pinchOf(a, b);
      if (now.distance <= 0) return;
      setDragging(true);
      change((_current, p) => {
        const zoomed = zoomTo(g.view, p, natural, g.view.scale * (now.distance / g.distance), g.centre);
        return panBy(zoomed, p, natural, now.centre.x - g.centre.x, now.centre.y - g.centre.y);
      });
      return;
    }
    if (g.kind !== 'drag' || g.id !== event.pointerId) return;
    const dx = point.x - g.last.x;
    const dy = point.y - g.last.y;
    gesture.current = { ...g, last: point };
    if (Math.hypot(point.x - g.start.x, point.y - g.start.y) < TAP_SLOP_PX) return;
    setDragging(true);
    change((current, p) => panBy(current, p, natural, dx, dy));
  };

  const endPointer = (event: PointerEvent<HTMLElement>, cancelled: boolean): void => {
    const known = pointers.current.get(event.pointerId);
    pointers.current.delete(event.pointerId);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Not captured: nothing to release.
    }
    const g = gesture.current;
    if (known === undefined) return;
    if (g.kind === 'drag' && g.id === event.pointerId) {
      gesture.current = { kind: 'none' };
      setDragging(false);
      const still = Math.hypot(known.x - g.start.x, known.y - g.start.y) < TAP_SLOP_PX;
      if (!cancelled && still) {
        const now = Date.now();
        const before = lastTap.current;
        if (
          before !== null &&
          now - before.at < DOUBLE_TAP_MS &&
          Math.hypot(known.x - before.point.x, known.y - before.point.y) < DOUBLE_TAP_DISTANCE_PX
        ) {
          lastTap.current = null;
          change((current, p) => toggleZoom(current, p, natural, known));
        } else lastTap.current = { at: now, point: known };
      }
      return;
    }
    if (g.kind === 'pinch') {
      gesture.current = { kind: 'none' };
      setDragging(false);
      lastTap.current = null;
      // One finger left: it carries on as a pan from where it is, not from where it was.
      const [id, point] = [...pointers.current.entries()][0] ?? [];
      if (id !== undefined && point !== undefined) startDrag(id, point);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const { plan: p, view: v } = latest.current;
    if (p === null || v === null) return;
    const overX = natural.width * v.scale > p.box.width + 0.5;
    const overY = natural.height * v.scale > p.box.height + 0.5;
    const pan = (dx: number, dy: number, allowed: boolean): void => {
      if (!allowed) return;
      event.preventDefault();
      change((current, planNow) => panBy(current, planNow, natural, dx, dy));
    };
    switch (event.key) {
      case '+':
      case '=':
        event.preventDefault();
        zoomIn();
        break;
      case '-':
      case '_':
        event.preventDefault();
        zoomOut();
        break;
      case '0':
        event.preventDefault();
        reset();
        break;
      case 'ArrowLeft':
        pan(KEY_PAN_PX, 0, overX);
        break;
      case 'ArrowRight':
        pan(-KEY_PAN_PX, 0, overX);
        break;
      case 'ArrowUp':
        pan(0, KEY_PAN_PX, overY);
        break;
      case 'ArrowDown':
        pan(0, -KEY_PAN_PX, overY);
        break;
      default:
    }
  };

  const atRest = plan === null || view === null ? true : isAtRest(view, plan, natural);
  const canZoomIn = plan !== null && view !== null && view.scale < plan.max - 0.001;
  const canZoomOut = plan !== null && view !== null && view.scale > plan.min + 0.001;
  const overflowing =
    plan !== null &&
    view !== null &&
    (natural.width * view.scale > plan.box.width + 0.5 || natural.height * view.scale > plan.box.height + 0.5);

  return (
    <div
      className="fy-render-viewport"
      data-fy-render-viewport={fullscreen ? 'fullscreen' : 'inline'}
      data-fy-render-zoomed={atRest ? 'false' : 'true'}
      ref={outerRef}
    >
      {plan !== null && view !== null ? (
        <>
          {/* A keyboard-reachable group, not an application: it names itself and says how to use it, and only
              claims the keys it acts on. */}
          {/* biome-ignore lint/a11y/useSemanticElements: a labelled region, not a form group */}
          <div
            aria-describedby={hintId}
            aria-label={`${kind}: ${alt}`}
            className="fy-render-pan"
            data-fy-render-dragging={dragging ? 'true' : 'false'}
            data-fy-render-fit={plan.rest > plan.fit + 0.001 ? 'legible' : 'whole'}
            data-fy-render-pannable={overflowing ? 'true' : 'false'}
            data-fy-render-scale={view.scale.toFixed(3)}
            onKeyDown={onKeyDown}
            onPointerCancel={event => endPointer(event, true)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={event => endPointer(event, false)}
            ref={panRef}
            role="group"
            style={{
              height: fullscreen ? '100%' : `${plan.box.height}px`,
              touchAction: touchActionFor(view, plan, natural),
            }}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a pannable box must be a tab stop so a keyboard can pan and zoom it
            tabIndex={0}
          >
            <img
              alt={alt}
              className="fy-render-image"
              data-fy-render-diagram={diagram ? 'true' : undefined}
              data-fy-render-sized="true"
              draggable={false}
              onError={onError}
              src={src}
              style={{
                height: `${natural.height * view.scale}px`,
                transform: `translate(${view.x}px, ${view.y}px)`,
                width: `${natural.width * view.scale}px`,
              }}
            />
          </div>
          <span className="sr-only" id={hintId}>
            Drag to pan. Pinch, or hold Control and scroll, to zoom. Plus and minus zoom, zero resets, arrow keys pan.
          </span>
          {/* biome-ignore lint/a11y/useSemanticElements: a toolbar of buttons, not a form group */}
          <div className="fy-render-zoom" role="group" aria-label={`${kind} zoom`}>
            <button
              aria-label="Zoom in"
              className="fy-render-tool"
              disabled={!canZoomIn}
              onClick={zoomIn}
              type="button"
            >
              <ZoomIn aria-hidden="true" size={14} />
            </button>
            <button
              aria-label="Zoom out"
              className="fy-render-tool"
              disabled={!canZoomOut}
              onClick={zoomOut}
              type="button"
            >
              <ZoomOut aria-hidden="true" size={14} />
            </button>
            <button aria-label="Reset zoom" className="fy-render-tool" disabled={atRest} onClick={reset} type="button">
              <Scan aria-hidden="true" size={14} />
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
