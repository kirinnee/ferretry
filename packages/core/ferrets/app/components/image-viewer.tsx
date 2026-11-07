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

import { Download, ExternalLink as ExternalIcon, ImageOff, Loader2, X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ExternalLink as ExternalAnchor } from '../features/browser/external-link.tsx';
import { useDialogFocus } from '../hooks/use-dialog-focus.ts';
import { cn } from '../lib/class-names.ts';
import {
  clampTransform,
  distance,
  fittedSize,
  IDENTITY,
  midpoint,
  neighbour,
  type Point,
  panBy,
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
}

export interface ImageViewerProps {
  readonly images: readonly ViewerImage[];
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
}

const BUTTON =
  'inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-control px-2 text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:hover:bg-transparent';

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

  const fitted = fittedSize(natural, stage);
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
      );
      setView(panBy(zoomed, mid.x - start.mid.x, mid.y - start.mid.y, fit.current, stageSize.current));
      return;
    }
    const current = press.current;
    if (!current) return;
    if (Math.hypot(point.x - current.start.x, point.y - current.start.y) > 6) current.moved = true;
    if (viewRef.current.scale > 1.01) {
      setView(panBy(viewRef.current, point.x - previous.x, point.y - previous.y, fit.current, stageSize.current));
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
      setView(toggleZoom(viewRef.current, fromCentre(end.x, end.y), fit.current, stageSize.current));
    } else {
      lastTap.current = { at: now, point: end };
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>): void => {
    dialogFocus.onKeyDown(event);
    if (event.defaultPrevented) return;
    const centre = { x: 0, y: 0 };
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        step(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        step(1);
        break;
      case '+':
      case '=':
        event.preventDefault();
        setView(zoomAround(view, view.scale * 1.5, centre, fitted, stage));
        break;
      case '-':
      case '_':
        event.preventDefault();
        setView(zoomAround(view, view.scale / 1.5, centre, fitted, stage));
        break;
      case '0':
        event.preventDefault();
        setView(IDENTITY);
        break;
      default:
    }
  };

  if (!image) return null;
  const shown = clampTransform(view, fitted, stage);
  const count = images.length;
  const zoomed = shown.scale > 1.01;

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      aria-modal="true"
      aria-label={`Image viewer: ${image.alt}`}
      data-testid="image-viewer"
      className="fixed inset-0 z-50 m-0 flex h-dvh max-h-none w-dvw max-w-none flex-col overflow-hidden border-0 bg-bg p-0 text-fg backdrop:bg-scrim"
      onKeyDown={onKeyDown}
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
            <ExternalAnchor
              aria-label={`Open ${image.filename} in a new tab`}
              className={BUTTON}
              href={image.src}
              title="Open in a new tab"
            >
              <ExternalIcon aria-hidden="true" size={18} />
              <span className="hidden sm:inline">Open</span>
            </ExternalAnchor>
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
              className="max-h-full max-w-full object-contain will-change-transform"
              draggable={false}
              onLoad={event =>
                setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
              }
              src={image.src}
              style={{
                transform: `translate3d(${shown.x}px, ${shown.y}px, 0) scale(${shown.scale})`,
                transition: dragging ? 'none' : 'transform 120ms ease-out',
              }}
            />
          ) : (
            <div className="flex items-center gap-2 text-muted text-sm" role="status">
              <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={18} />
              Loading image…
            </div>
          )}
        </div>

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
