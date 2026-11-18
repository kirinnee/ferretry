/**
 * THE FULL-SCREEN IMAGE VIEWER. One lightbox for every picture the app shows the reader: a chip in the
 * composer tray, and an image in a sent or received message.
 *
 * It is a modal `<dialog>` (real top layer, focus trap, Escape through the app's escape stack) that
 * fills the screen. The picture is fitted to the stage; a pinch, a wheel or a double tap zooms it, a
 * drag pans it, and an unzoomed horizontal swipe — or an arrow key — moves to the neighbouring picture
 * of the same message. The arithmetic is `image-viewer-model.ts`, pure and tested on its own.
 *
 * IT OWNS NO BYTES. Every picture arrives as an already-resolved `src` — the full-resolution object URL
 * the thumbnail itself shows, or the composer's own local file — so the viewer adds no request, on any
 * carrier, and a picture that is still arriving or has failed is a state it draws, not a fetch it makes.
 */

import {
  Download,
  ExternalLink as ExternalIcon,
  ImageOff,
  Minimize2,
  ScanLine,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from './lib/class-names.ts';
import { Loading } from './loading.tsx';
import { ExternalLink as ExternalAnchor } from './external-link.tsx';
import { useDialogFocus } from './hooks/use-dialog-focus.ts';
import {
  clampTransform,
  distance,
  IDENTITY,
  maxScaleFor,
  midpoint,
  neighbour,
  type Point,
  panBy,
  restingSize,
  type Size,
  swipeStep,
  toggleZoom,
  type ViewTransform,
  wheelScale,
  zoomAround,
} from './image-viewer-model.ts';

export interface ViewerImage {
  readonly key: string;
  /** The full-resolution object URL, or null while it is still arriving. */
  readonly src: string | null;
  readonly failed: boolean;
  readonly alt: string;
  readonly filename: string;
  /** "246 KB" and the like, shown beside the name. */
  readonly meta?: string;
  /** False for an address a browser will not open in a tab (a `data:` URL): the viewer then offers no Open link. */
  readonly openable?: boolean;
}

export interface ImageViewerProps {
  readonly images: readonly ViewerImage[];
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
}

const BUTTON =
  'inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-control px-2 text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:hover:bg-transparent';

/** One press of Zoom in / Zoom out, and one `+` / `-`. */
const BUTTON_STEP = 1.5;
/** One arrow key pans this far while the picture is zoomed. */
const KEY_PAN_PX = 60;
const TOOL = `${BUTTON} aria-disabled:opacity-40 aria-disabled:hover:bg-transparent`;

const percentOf = (scale: number): string => `${Math.round(scale * 100)}%`;

const TAP_MS = 300;
const TAP_SLOP = 24;

interface PinchStart {
  readonly distance: number;
  readonly view: ViewTransform;
  readonly focus: Point;
  readonly mid: Point;
}

export function ImageViewer({ images, index, onIndexChange, onClose }: ImageViewerProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const image = images[index];
  const [view, setView] = useState<ViewTransform>(IDENTITY);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size>({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Taken BEFORE showModal moves focus into the dialog: it is where focus returns when the viewer goes.
    const opener = document.activeElement;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const dialogFocus = useDialogFocus(true, dialogRef, onClose);

  const imageKey = image?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the picture changing is the trigger.
  useEffect(() => {
    setView(IDENTITY);
    setNatural({ width: 0, height: 0 });
  }, [imageKey]);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = (): void => setStage({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // What the picture is drawn at when it rests: the whole of it, never enlarged past its own pixels.
  const fitted = restingSize(natural, stage);
  const rest = natural.width > 0 ? fitted.width / natural.width : 1;
  const maxScale = maxScaleFor(rest);
  const ceiling = useRef(maxScale);
  ceiling.current = maxScale;
  const fit = useRef(fitted);
  fit.current = fitted;
  const stageSize = useRef(stage);
  stageSize.current = stage;

  /** A stage point relative to the stage CENTRE, which is the transform's origin. */
  const fromCentre = useCallback((clientX: number, clientY: number): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }, []);

  const step = useCallback(
    (direction: -1 | 1): void => {
      const next = neighbour(index, direction, images.length);
      if (next !== null) onIndexChange(next);
    },
    [images.length, index, onIndexChange],
  );

  // A wheel must not scroll the page behind, and React's own wheel handler is passive.
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const current = viewRef.current;
      setView(
        zoomAround(
          current,
          current.scale * wheelScale(event.deltaY, event.ctrlKey),
          fromCentre(event.clientX, event.clientY),
          fit.current,
          stageSize.current,
          ceiling.current,
        ),
      );
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [fromCentre]);

  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<PinchStart | null>(null);
  const press = useRef<{ start: Point; moved: boolean } | null>(null);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    setDragging(true);
    if (pointers.current.size === 1) {
      press.current = { start: point, moved: false };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      const mid = midpoint(a, b);
      pinch.current = {
        distance: Math.max(distance(a, b), 1),
        view: viewRef.current,
        focus: fromCentre(mid.x, mid.y),
        mid,
      };
      press.current = null;
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    const start = pinch.current;
    if (start && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      const mid = midpoint(a, b);
      const zoomed = zoomAround(
        start.view,
        start.view.scale * (distance(a, b) / start.distance),
        start.focus,
        fit.current,
        stageSize.current,
        ceiling.current,
      );
      setView(panBy(zoomed, mid.x - start.mid.x, mid.y - start.mid.y, fit.current, stageSize.current, ceiling.current));
      return;
    }
    const current = press.current;
    if (!current) return;
    if (Math.hypot(point.x - current.start.x, point.y - current.start.y) > 6) current.moved = true;
    if (viewRef.current.scale > 1.01) {
      setView(
        panBy(
          viewRef.current,
          point.x - previous.x,
          point.y - previous.y,
          fit.current,
          stageSize.current,
          ceiling.current,
        ),
      );
    }
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const point = pointers.current.get(event.pointerId);
    if (!point) return;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size > 0) return;
    setDragging(false);
    const current = press.current;
    press.current = null;
    if (!current || event.type === 'pointercancel') return;
    const end = { x: event.clientX, y: event.clientY };
    const dx = end.x - current.start.x;
    const dy = end.y - current.start.y;
    const direction = swipeStep(viewRef.current, dx, dy);
    if (direction !== 0) {
      lastTap.current = null;
      step(direction);
      return;
    }
    if (current.moved) return;
    const now = event.timeStamp;
    const before = lastTap.current;
    if (before && now - before.at < TAP_MS && Math.hypot(end.x - before.point.x, end.y - before.point.y) < TAP_SLOP) {
      lastTap.current = null;
      setView(toggleZoom(viewRef.current, fromCentre(end.x, end.y), fit.current, stageSize.current, ceiling.current));
    } else {
      lastTap.current = { at: now, point: end };
    }
  };

  const zoomBy = (factor: number): void =>
    setView(zoomAround(view, view.scale * factor, { x: 0, y: 0 }, fitted, stage, maxScale));
  const actualSize = (): void => setView(zoomAround(view, 1 / rest, { x: 0, y: 0 }, fitted, stage, maxScale));

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>): void => {
    // ESCAPE ENDS HERE. It closes the viewer and goes no further: a React ancestor (the message, a block's own
    // fullscreen) must not also hear it and close itself behind the picture. Stopping it here also keeps it from
    // `document`, so this handler is the one that closes — focus is always inside a modal dialog.
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    // Nothing typed in here is the page behind's business.
    event.stopPropagation();
    dialogFocus.onKeyDown(event);
    if (event.defaultPrevented) return;
    const centre = { x: 0, y: 0 };
    const pan = (dx: number, dy: number, direction: -1 | 1): void => {
      event.preventDefault();
      if (viewRef.current.scale > 1.01)
        setView(panBy(viewRef.current, dx, dy, fit.current, stageSize.current, ceiling.current));
      else step(direction);
    };
    switch (event.key) {
      case 'ArrowLeft':
        pan(KEY_PAN_PX, 0, -1);
        break;
      case 'ArrowRight':
        pan(-KEY_PAN_PX, 0, 1);
        break;
      case 'ArrowUp':
        if (viewRef.current.scale > 1.01) pan(0, KEY_PAN_PX, -1);
        break;
      case 'ArrowDown':
        if (viewRef.current.scale > 1.01) pan(0, -KEY_PAN_PX, 1);
        break;
      case '+':
      case '=':
        event.preventDefault();
        setView(zoomAround(view, view.scale * BUTTON_STEP, centre, fitted, stage, maxScale));
        break;
      case '-':
      case '_':
        event.preventDefault();
        setView(zoomAround(view, view.scale / BUTTON_STEP, centre, fitted, stage, maxScale));
        break;
      case '0':
        event.preventDefault();
        setView(IDENTITY);
        break;
      default:
    }
  };

  if (!image) return null;
  const shown = clampTransform(view, fitted, stage, maxScale);
  const count = images.length;
  const zoomed = shown.scale > 1.01;
  const sized = natural.width > 0 && !image.failed && image.src !== null;
  const stop = (event: SyntheticEvent): void => event.stopPropagation();

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      aria-modal="true"
      aria-label={`Image viewer: ${image.alt}`}
      data-testid="image-viewer"
      className="fixed inset-0 z-50 m-0 flex h-dvh max-h-none w-dvw max-w-none flex-col overflow-hidden border-0 bg-bg p-0 text-fg backdrop:bg-scrim"
      onClick={stop}
      onKeyDown={onKeyDown}
      onPointerDown={stop}
      onPointerUp={stop}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      onClose={event => {
        // StrictMode closes and re-opens the dialog on mount; that close event is not the reader leaving.
        if (!event.currentTarget.open) onClose();
      }}
    >
      <header className="flex min-h-[52px] shrink-0 items-center gap-1 border-border-soft border-b bg-surface px-2 pt-[env(safe-area-inset-top)]">
        <div className="min-w-0 flex-1 px-1 leading-tight">
          <span className="block truncate font-medium text-fg text-sm" title={image.filename}>
            {image.filename}
          </span>
          <span aria-live="polite" className="block truncate text-faint text-meta">
            {count > 1 ? `${index + 1} of ${count}` : ''}
            {count > 1 && image.meta ? ' · ' : ''}
            {image.meta ?? ''}
          </span>
        </div>
        {image.src ? (
          <>
            <a
              aria-label={`Download ${image.filename}`}
              className={BUTTON}
              download={image.filename}
              href={image.src}
              title="Download"
            >
              <Download aria-hidden="true" size={18} />
              <span className="hidden sm:inline">Download</span>
            </a>
            {image.openable === false ? null : (
              <ExternalAnchor
                aria-label={`Open ${image.filename} in a new tab`}
                className={BUTTON}
                href={image.src}
                title="Open in a new tab"
              >
                <ExternalIcon aria-hidden="true" size={18} />
                <span className="hidden sm:inline">Open</span>
              </ExternalAnchor>
            )}
          </>
        ) : null}
        <button aria-label="Close image viewer" className={BUTTON} onClick={onClose} type="button">
          <X aria-hidden="true" size={20} />
        </button>
      </header>

      <div className="relative min-h-0 flex-1 bg-surface-2">
        <div
          ref={stageRef}
          className={cn(
            'absolute inset-0 flex select-none items-center justify-center overflow-hidden [touch-action:none]',
            zoomed ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in',
          )}
          data-testid="image-viewer-stage"
          onPointerCancel={onPointerEnd}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
        >
          {image.failed ? (
            <div className="flex flex-col items-center gap-2 text-muted text-sm" role="status">
              <ImageOff aria-hidden="true" size={28} />
              This image is no longer available
            </div>
          ) : image.src ? (
            <img
              alt={image.alt}
              className="max-h-full max-w-full object-contain transition-transform duration-[120ms] ease-out will-change-transform motion-reduce:transition-none"
              draggable={false}
              onLoad={event =>
                setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
              }
              src={image.src}
              style={{
                transform: `translate3d(${shown.x}px, ${shown.y}px, 0) scale(${shown.scale})`,
                transition: dragging ? 'none' : undefined,
              }}
            />
          ) : (
            <Loading kind="page" label="Loading image…" />
          )}
        </div>

        {sized ? (
          <div
            className="absolute bottom-[max(0.5rem,env(safe-area-inset-bottom))] left-1/2 flex max-w-[calc(100%-1rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-0.5 rounded-control border border-border bg-surface/90 px-1 shadow"
            data-testid="image-viewer-toolbar"
          >
            <span className="px-2 text-fg-soft text-meta tabular-nums" data-testid="image-viewer-readout">
              {percentOf(shown.scale * rest)} · {natural.width}×{natural.height}
            </span>
            <button
              aria-disabled={shown.scale <= 1.001}
              aria-label="Zoom out"
              className={TOOL}
              onClick={() => zoomBy(1 / BUTTON_STEP)}
              type="button"
            >
              <ZoomOut aria-hidden="true" size={18} />
            </button>
            <button
              aria-disabled={shown.scale >= maxScale - 0.001}
              aria-label="Zoom in"
              className={TOOL}
              onClick={() => zoomBy(BUTTON_STEP)}
              type="button"
            >
              <ZoomIn aria-hidden="true" size={18} />
            </button>
            <button
              aria-disabled={shown.scale <= 1.001}
              aria-label="Fit to screen"
              className={TOOL}
              onClick={() => setView(IDENTITY)}
              type="button"
            >
              <Minimize2 aria-hidden="true" size={18} />
            </button>
            <button
              aria-disabled={Math.abs(shown.scale * rest - 1) < 0.001}
              aria-label="Actual size"
              className={TOOL}
              onClick={actualSize}
              type="button"
            >
              <ScanLine aria-hidden="true" size={18} />
            </button>
          </div>
        ) : null}

        {count > 1 ? (
          <>
            <button
              aria-label="Previous image"
              className={cn(
                BUTTON,
                'absolute top-1/2 left-2 -translate-y-1/2 border border-border bg-surface/90 shadow',
              )}
              disabled={index === 0}
              onClick={() => step(-1)}
              type="button"
            >
              <span aria-hidden="true" className="text-lg leading-none">
                ‹
              </span>
            </button>
            <button
              aria-label="Next image"
              className={cn(
                BUTTON,
                'absolute top-1/2 right-2 -translate-y-1/2 border border-border bg-surface/90 shadow',
              )}
              disabled={index === count - 1}
              onClick={() => step(1)}
              type="button"
            >
              <span aria-hidden="true" className="text-lg leading-none">
                ›
              </span>
            </button>
          </>
        ) : null}
      </div>
    </dialog>
  );
}
