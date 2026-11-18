/**
 * A PICTURE THAT OPENS FULL-SIZE. The owner's ask: "i need picture that can zoom — is that a low res image?"
 *
 * An image in a message is drawn at the column's width and at most 60% of the screen, so a large picture is
 * a shrunken copy of itself and a reader cannot tell whether it is sharp. This wraps that same `<img>` in a
 * button; pressing it (tap, click, or Enter / Space) opens a viewer over the app that shows the SAME bytes
 * at their natural resolution — no second, downscaled copy is made, and the `src` is the one the inline
 * picture already holds.
 *
 * IN THE VIEWER
 *   - the picture rests at "fit" (the whole thing, never scaled up past 100%);
 *   - Zoom in / Zoom out / Fit / 100% buttons, `+` `-` `0` and the arrow keys;
 *   - the wheel (and Ctrl / pinch on a trackpad) zooms about the cursor;
 *   - two fingers pinch about their midpoint;
 *   - drag to pan once zoomed; a double tap or double click toggles fit and 100%;
 *   - Escape, the Close button, or a tap on the empty backdrop closes it, and focus returns to the picture.
 *
 * Focus is the app's own dialog contract (`useDialogFocus`: Escape stack, focus in, Tab trap). Focus is also
 * returned to the picture by hand, because Safari does not focus a button on a tap and the hook can only
 * restore what it saw focused.
 *
 * REDUCED MOTION: a button, key or double-tap zoom eases over a moment only when the reader has not asked for
 * reduced motion (CSS, `fy-render-image-zoom.css`); a drag, a pinch and the wheel never ease.
 *
 * THE SINK IS UNCHANGED. The viewer's `<img>` takes the same URL the inline one was given — a `blob:` this page
 * minted or the block's own `data:` URL — so nothing new reaches the page and no CSP widens. The viewer is a
 * portal to `document.body`, and it stops its pointer, click and key events at its own root so the message it
 * was opened from (a row click, a swipe deck, a long-press) never sees them.
 */

import { Minimize2, ScanLine, X, ZoomIn, ZoomOut } from 'lucide-react';
import {
  type ImgHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useDialogFocus } from '@ferretry/app/ui';
import './fy-render-image-zoom.css';

/** The most a picture can be enlarged to, as a multiple of its natural size. */
const MAX_SCALE = 8;
/** One press of Zoom in / Zoom out, and one `+` / `-`. */
const BUTTON_STEP = 1.5;
/** A press that moves less than this is a tap, not the start of a pan. */
const TAP_SLOP_PX = 6;
/** Two taps this close in time and space are a double tap. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DISTANCE_PX = 32;
/** One arrow key pans this far. */
const KEY_PAN_PX = 60;

interface Size {
  readonly width: number;
  readonly height: number;
}
interface Point {
  readonly x: number;
  readonly y: number;
}
/** `scale` is a multiple of the natural size; `x`/`y` is where the picture's top-left sits in the stage. */
interface View {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

/** The scale that shows the whole picture in the stage, and never enlarges it. */
const fitScale = (stage: Size, natural: Size): number =>
  Math.min(1, stage.width / natural.width, stage.height / natural.height);

/** One axis: centred while the picture is smaller than the stage, otherwise never past either edge. */
const clampAxis = (offset: number, content: number, room: number): number =>
  content <= room ? (room - content) / 2 : Math.min(0, Math.max(room - content, offset));

const clampView = (view: View, stage: Size, natural: Size): View => ({
  scale: view.scale,
  x: clampAxis(view.x, natural.width * view.scale, stage.width),
  y: clampAxis(view.y, natural.height * view.scale, stage.height),
});

/** Zoom to `target`, keeping the picture point under `about` (stage coordinates) where it is. */
const zoomAbout = (view: View, target: number, about: Point, stage: Size, natural: Size): View => {
  const scale = Math.min(MAX_SCALE, Math.max(fitScale(stage, natural), target));
  const ratio = scale / view.scale;
  return clampView(
    { scale, x: about.x - (about.x - view.x) * ratio, y: about.y - (about.y - view.y) * ratio },
    stage,
    natural,
  );
};

const percentOf = (scale: number): string => `${Math.round(scale * 100)}%`;

interface ViewerProps {
  readonly alt: string;
  readonly src: string;
  /** The natural size when the inline picture had already loaded; the viewer's own load refines it. */
  readonly initial: Size | null;
  readonly dialogRef: { readonly current: HTMLDivElement | null };
  readonly onClose: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

function Viewer({ alt, src, initial, dialogRef, onClose, onKeyDown }: ViewerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<Size | null>(initial);
  const [stage, setStage] = useState<Size>({ height: 0, width: 0 });
  /** `null` is "fitted": the view follows the fit as the window resizes. */
  const [raw, setRaw] = useState<View | null>(null);
  const [animate, setAnimate] = useState(false);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (element === null) return;
    const read = (): void => {
      const next = { height: element.clientHeight, width: element.clientWidth };
      setStage(previous => (previous.width === next.width && previous.height === next.height ? previous : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const known = natural !== null && natural.width > 0 && natural.height > 0 && stage.width > 0 && stage.height > 0;
  const fit = known ? fitScale(stage, natural) : 1;
  const view: View | null = known
    ? raw === null
      ? clampView({ scale: fit, x: 0, y: 0 }, stage, natural)
      : clampView({ ...raw, scale: Math.max(fit, raw.scale) }, stage, natural)
    : null;
  const atFit = view === null || view.scale <= fit + 0.001;

  // The gesture state lives in refs: it changes on every pointer event and must not re-render by itself.
  const latest = useRef({ fit, natural, stage, view });
  latest.current = { fit, natural, stage, view };
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{
    readonly mode: 'pan' | 'pinch';
    readonly startView: View;
    readonly startPoint: Point;
    readonly startDistance: number;
    readonly startMid: Point;
    moved: boolean;
    readonly downTarget: EventTarget | null;
  } | null>(null);
  const lastTap = useRef<{ readonly at: number; readonly point: Point } | null>(null);

  const local = useCallback((clientX: number, clientY: number): Point => {
    const box = stageRef.current?.getBoundingClientRect();
    return { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) };
  }, []);

  /** Move to `target` about `about`; a button, key or double tap eases, a gesture never does. */
  const zoomTo = useCallback((target: number, about: Point | null, ease: boolean): void => {
    const { natural: size, stage: room, view: now } = latest.current;
    if (size === null || now === null) return;
    setAnimate(ease);
    setRaw(zoomAbout(now, target, about ?? { x: room.width / 2, y: room.height / 2 }, room, size));
  }, []);
  const zoomStep = (factor: number): void => zoomTo((latest.current.view?.scale ?? 1) * factor, null, true);
  const toFit = (): void => {
    setAnimate(true);
    setRaw(null);
  };
  /** The scale a double tap or double click leaves a fitted picture at: natural size, or 2x when it already is. */
  const actualSize = (): number => (latest.current.fit < 0.999 ? 1 : 2);
  const toggle = (about: Point | null): void => {
    const { fit: resting, view: now } = latest.current;
    if (now !== null && now.scale > resting + 0.001) toFit();
    else zoomTo(actualSize(), about, true);
  };

  // A wheel listener must be non-passive to be allowed to stop the page behind scrolling.
  useEffect(() => {
    const element = stageRef.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const { view: now } = latest.current;
      if (now === null) return;
      const lines = event.deltaMode === 1 ? 16 : 1;
      const factor = Math.exp(-event.deltaY * lines * (event.ctrlKey ? 0.01 : 0.002));
      zoomTo(now.scale * factor, local(event.clientX, event.clientY), false);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [local, zoomTo]);

  const begin = (): void => {
    const { view: now } = latest.current;
    if (now === null) return;
    const [first, second] = [...pointers.current.values()];
    if (first === undefined) {
      gesture.current = null;
      return;
    }
    gesture.current = {
      downTarget: null,
      mode: second === undefined ? 'pan' : 'pinch',
      moved: second !== undefined,
      startDistance: second === undefined ? 0 : Math.hypot(second.x - first.x, second.y - first.y),
      startMid: second === undefined ? first : { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
      startPoint: first,
      startView: now,
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured; the gesture simply ends with it.
    }
    const target = event.target;
    begin();
    if (gesture.current !== null && pointers.current.size === 1) {
      gesture.current = { ...gesture.current, downTarget: target };
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const current = gesture.current;
    if (current === null || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const { natural: size, stage: room } = latest.current;
    if (size === null) return;
    if (current.mode === 'pan') {
      const dx = event.clientX - current.startPoint.x;
      const dy = event.clientY - current.startPoint.y;
      if (!current.moved && Math.hypot(dx, dy) < TAP_SLOP_PX) return;
      current.moved = true;
      setDragging(true);
      setAnimate(false);
      setRaw(
        clampView(
          { scale: current.startView.scale, x: current.startView.x + dx, y: current.startView.y + dy },
          room,
          size,
        ),
      );
      return;
    }
    const [first, second] = [...pointers.current.values()];
    if (first === undefined || second === undefined || current.startDistance === 0) return;
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    const mid = local((first.x + second.x) / 2, (first.y + second.y) / 2);
    const startMid = local(current.startMid.x, current.startMid.y);
    const scale = Math.min(
      MAX_SCALE,
      Math.max(latest.current.fit, current.startView.scale * (distance / current.startDistance)),
    );
    const ratio = scale / current.startView.scale;
    setDragging(true);
    setAnimate(false);
    setRaw(
      clampView(
        {
          scale,
          x: mid.x - (startMid.x - current.startView.x) * ratio,
          y: mid.y - (startMid.y - current.startView.y) * ratio,
        },
        room,
        size,
      ),
    );
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const current = gesture.current;
    pointers.current.delete(event.pointerId);
    setDragging(false);
    if (current === null) return;
    if (current.mode === 'pinch' || pointers.current.size > 0) {
      // A finger lifted from a pinch: carry on as a pan from where the other one is, without a jump.
      begin();
      if (gesture.current !== null) gesture.current = { ...gesture.current, moved: true };
      return;
    }
    gesture.current = null;
    if (current.moved) return;
    // A TAP. On the empty backdrop it closes; on the picture, two of them toggle fit and actual size.
    if (current.downTarget === event.currentTarget) {
      onClose();
      return;
    }
    const point = { x: event.clientX, y: event.clientY };
    const now = Date.now();
    const before = lastTap.current;
    if (
      before !== null &&
      now - before.at < DOUBLE_TAP_MS &&
      Math.hypot(point.x - before.point.x, point.y - before.point.y) < DOUBLE_TAP_DISTANCE_PX
    ) {
      lastTap.current = null;
      toggle(local(point.x, point.y));
    } else {
      lastTap.current = { at: now, point };
    }
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(event.pointerId);
    gesture.current = null;
    setDragging(false);
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown(event);
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const { natural: size, stage: room, view: now } = latest.current;
    const pan = (dx: number, dy: number): void => {
      if (size === null || now === null) return;
      event.preventDefault();
      setAnimate(false);
      setRaw(clampView({ scale: now.scale, x: now.x + dx, y: now.y + dy }, room, size));
    };
    switch (event.key) {
      case '+':
      case '=':
        event.preventDefault();
        zoomStep(BUTTON_STEP);
        break;
      case '-':
      case '_':
        event.preventDefault();
        zoomStep(1 / BUTTON_STEP);
        break;
      case '0':
        event.preventDefault();
        toFit();
        break;
      case 'ArrowLeft':
        pan(KEY_PAN_PX, 0);
        break;
      case 'ArrowRight':
        pan(-KEY_PAN_PX, 0);
        break;
      case 'ArrowUp':
        pan(0, KEY_PAN_PX);
        break;
      case 'ArrowDown':
        pan(0, -KEY_PAN_PX);
        break;
    }
    // Nothing typed in here is the message's business — except Escape, which the dialog hook hears on `document`
    // and which stopping here would silence whenever focus is on one of the viewer's own buttons.
    if (event.key !== 'Escape') event.stopPropagation();
  };

  const onLoad = (event: SyntheticEvent<HTMLImageElement>): void => {
    const { naturalHeight, naturalWidth } = event.currentTarget;
    if (naturalWidth > 0 && naturalHeight > 0) setNatural({ height: naturalHeight, width: naturalWidth });
  };

  const scale = view?.scale ?? 1;
  const atMax = scale >= MAX_SCALE - 0.001;
  const sized = view !== null && natural !== null;
  const stop = (event: SyntheticEvent): void => event.stopPropagation();

  return (
    <div
      aria-label={`Full-size picture: ${alt}`}
      aria-modal="true"
      className="fy-zoom"
      data-fy-render-zoom="open"
      onClick={stop}
      onKeyDown={onKey}
      onPointerDown={stop}
      onPointerUp={stop}
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <div
        className="fy-zoom-stage"
        data-fy-render-zoom-dragging={dragging ? 'true' : 'false'}
        data-fy-render-zoom-fit={atFit ? 'true' : 'false'}
        data-fy-render-zoom-scale={scale.toFixed(3)}
        onPointerCancel={onPointerCancel}
        onPointerDown={event => {
          event.stopPropagation();
          onPointerDown(event);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={event => {
          event.stopPropagation();
          onPointerUp(event);
        }}
        ref={stageRef}
      >
        <img
          alt={alt}
          className="fy-zoom-img"
          data-fy-render-zoom-animate={animate ? 'true' : 'false'}
          draggable={false}
          onLoad={onLoad}
          src={src}
          style={
            sized
              ? {
                  height: `${natural.height}px`,
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                  width: `${natural.width}px`,
                }
              : undefined
          }
        />
      </div>
      <div className="fy-zoom-bar">
        <span className="fy-zoom-readout" data-fy-render-zoom-readout="true">
          {percentOf(scale)}
          {natural === null ? '' : ` · ${natural.width}×${natural.height}`}
        </span>
        <button
          aria-label="Zoom out"
          className="fy-zoom-btn"
          aria-disabled={atFit}
          onClick={() => zoomStep(1 / BUTTON_STEP)}
          type="button"
        >
          <ZoomOut aria-hidden="true" size={16} />
        </button>
        <button
          aria-label="Zoom in"
          className="fy-zoom-btn"
          aria-disabled={atMax}
          onClick={() => zoomStep(BUTTON_STEP)}
          type="button"
        >
          <ZoomIn aria-hidden="true" size={16} />
        </button>
        <button aria-disabled={atFit} aria-label="Fit to screen" className="fy-zoom-btn" onClick={toFit} type="button">
          <Minimize2 aria-hidden="true" size={16} />
        </button>
        <button
          aria-label="Actual size"
          className="fy-zoom-btn"
          aria-disabled={Math.abs(scale - 1) < 0.001}
          onClick={() => zoomTo(1, null, true)}
          type="button"
        >
          <ScanLine aria-hidden="true" size={16} />
        </button>
        <button aria-label="Close" className="fy-zoom-btn" onClick={onClose} type="button">
          <X aria-hidden="true" size={16} />
        </button>
      </div>
    </div>
  );
}

export interface FyRenderZoomImageProps
  extends Pick<ImgHTMLAttributes<HTMLImageElement>, 'alt' | 'className' | 'onError' | 'src'> {
  readonly alt: string;
  readonly src: string;
  /** Carried onto the inline `<img>` so a test or a screenshot can find which stage drew it. */
  readonly 'data-fy-render-media'?: string;
}

/** An inline picture that opens in the viewer. The `<img>` it renders is the one the caller would have. */
export function FyRenderZoomImage({ alt, className, onError, src, ...rest }: FyRenderZoomImageProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initial = useRef<Size | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const focus = useDialogFocus(open, dialogRef, close);

  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const show = (): void => {
    const image = imageRef.current;
    initial.current =
      image !== null && image.naturalWidth > 0 && image.naturalHeight > 0
        ? { height: image.naturalHeight, width: image.naturalWidth }
        : null;
    setOpen(true);
  };

  return (
    <>
      <button
        aria-haspopup="dialog"
        aria-label={`Open full size: ${alt}`}
        className="fy-zoom-open"
        data-fy-render-zoom-trigger="true"
        onClick={show}
        ref={triggerRef}
        type="button"
      >
        <img alt={alt} className={className} onError={onError} ref={imageRef} src={src} {...rest} />
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <Viewer
              alt={alt}
              dialogRef={dialogRef}
              initial={initial.current}
              onClose={close}
              onKeyDown={focus.onKeyDown}
              src={src}
            />,
            document.body,
          )
        : null}
    </>
  );
}
