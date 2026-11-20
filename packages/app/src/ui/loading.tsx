/**
 * THE ONE LOADING SYSTEM. Every "this is not here yet" the reader watches is one of two things, and this file owns both:
 *
 *  - INTRUSIVE — {@link Loading} `kind="page"`: a full-area animation for a change the person is waiting on (a page, a
 *    machine switch, the first load). It REPLACES the content, so draw it once per page, never once per panel.
 *  - NON-INTRUSIVE — a thin bar across the very top of the window for work that does NOT replace anything (a refresh,
 *    a poll, a panel's own read). A view says it is busy with {@link useBackgroundLoad}; the shell draws ONE bar
 *    ({@link LoadingBarHost}) however many views are busy, so ten panels reading at once are one bar, not ten lines.
 *
 * Both wait the one 300 ms threshold (`loading-gate.ts`, drawn by `loading.css`) before they show: a read that answers
 * inside it paints nothing, which is what stops a fast load from flashing. Reduced motion (the OS setting or Settings › Appearance › Motion) keeps both
 * visible and stills the movement. The mark and the bar read colour from the theme's tokens, light and dark alike.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LOADING_DELAY_MS, LOADING_FADE_MS, LOADING_MIN_MS, loadingGateStyle } from './loading-gate.ts';
import { useLoadingHold } from './loading-hold.ts';
import { Spinner } from './spinner.tsx';

export { LOADING_DELAY_MS, LOADING_FADE_MS, LOADING_MIN_MS };

export interface LoadingGate {
  readonly delay?: number;
  readonly min?: number;
  readonly fade?: number;
}

/**
 * HOLDS A LOADER STEADY. Returns whether the loader should be MOUNTED for a wait that is `active`; the stylesheet keeps a
 * freshly mounted loader invisible for the same delay, so the two together give:
 *  - a wait that ends inside `delay` mounts nothing that was ever seen (no flash);
 *  - a wait that outlasts it is held until `delay + fade + min` after it began (so it is fully shown for `min`), however soon the answer arrives (no blink);
 *  - a wait that starts again while the loader is still held is the SAME loader, not a new one (no stutter, no stack).
 * The caller keeps showing what it was waiting for until this answers false.
 */
export function useHeldLoading(active: boolean, gate: LoadingGate = {}): boolean {
  const delay = gate.delay ?? LOADING_DELAY_MS;
  const min = gate.min ?? LOADING_MIN_MS;
  const fade = gate.fade ?? LOADING_FADE_MS;
  const began = useRef<number | undefined>(undefined);
  const [held, setHeld] = useState(active);
  if (active && began.current === undefined) began.current = Date.now();
  useEffect(() => {
    if (active) {
      setHeld(true);
      return undefined;
    }
    const start = began.current;
    if (start === undefined) {
      setHeld(false);
      return undefined;
    }
    const elapsed = Date.now() - start;
    const release = (): void => {
      began.current = undefined;
      setHeld(false);
    };
    // Never visible: let go now. Visible: stay until the minimum has run out.
    const remaining = elapsed < delay ? 0 : delay + fade + min - elapsed;
    if (remaining <= 0) {
      release();
      return undefined;
    }
    const timer = setTimeout(release, remaining);
    return () => clearTimeout(timer);
  }, [active, delay, min, fade]);
  return active || held;
}

const delayStyle = loadingGateStyle();

export interface LoadingProps {
  /**
   * `page`: the full-area animation, which REPLACES what is being waited for (draw it once per page).
   * `bar`: a non-intrusive wait — draws nothing in place and puts the shell's one top bar up while it is mounted.
   */
  readonly kind: 'page' | 'bar';
  /** What is being waited for, in the reader's words ("Checking what this daemon offers…"). */
  readonly label?: string;
  readonly className?: string;
  /**
   * `page` only: a small loader with no minimum height, for a small container (a popover, a dialog, a card, a panel inside
   * a page) that must not jump tall while it waits. A page-sized wait leaves this off.
   */
  readonly compact?: boolean;
  /** `data-*` attributes a test or another feature reads off the loader (the marker the inline line used to carry). */
  readonly marks?: Readonly<Record<`data-${string}`, string>>;
}

export function Loading({ kind, label, className, compact = false, marks }: LoadingProps) {
  if (kind === 'bar') return <BackgroundLoading label={label} marks={marks} />;
  return <PageLoading className={className} compact={compact} label={label} marks={marks} />;
}

function PageLoading({ label, className, compact, marks }: Omit<LoadingProps, 'kind'> & { readonly compact: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  // Mounted straight off a read, it would vanish the moment the read answers: keep it for its minimum (loading-hold.ts).
  useLoadingHold(root, { cover: true });
  const extra = (compact ? ' fy-loading--compact' : '') + (className === undefined ? '' : ` ${className}`);
  return (
    <div
      aria-live="polite"
      className={`fy-loading fy-loading--page${extra}`}
      data-loading="page"
      ref={root}
      role="status"
      style={delayStyle}
      {...marks}
    >
      <span aria-hidden="true" className="fy-loading__orb">
        <span className="fy-loading__ring" />
        <span className="fy-loading__ring fy-loading__ring--late" />
        <Spinner className="fy-loading__spin" size={compact ? 24 : 38} />
      </span>
      <span className="fy-loading__label">{label ?? 'Loading…'}</span>
    </div>
  );
}

/** The non-intrusive kind: the words only for a screen reader, and the shell's one bar for everyone else. */
function BackgroundLoading({
  label,
  marks,
}: {
  readonly label: string | undefined;
  readonly marks: LoadingProps['marks'];
}) {
  useBackgroundLoad(true);
  return (
    <span className="sr-only" data-loading="background" role="status" {...marks}>
      {label ?? 'Loading…'}
    </span>
  );
}

/** The bar itself — drawn only by {@link LoadingBarHost}, once. Fixed to the top of the window, so it moves nothing. */
function TopBar() {
  return (
    <div aria-label="Loading" className="fy-loading-bar" data-loading="bar" role="progressbar" style={delayStyle}>
      <span className="fy-loading-bar__run" />
    </div>
  );
}

// ---- the background count: one bar for however many views are busy ------------------------------------------------

let busy = 0;
const listeners = new Set<() => void>();

function change(by: 1 | -1): void {
  busy += by;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const anyBusy = (): boolean => busy > 0;

/**
 * Says this view is doing background work while `active` is true (a refresh, a poll, a read behind content that is
 * already drawn). It draws nothing itself: the shell's one top bar shows while ANY view is active.
 */
export function useBackgroundLoad(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    change(1);
    return () => change(-1);
  }, [active]);
}

/** Whether any view is busy in the background right now. */
export function useAnyBackgroundLoad(): boolean {
  return useSyncExternalStore(subscribe, anyBusy, () => false);
}

/** The shell's one top bar: drawn while any view says it is busy, nothing otherwise. Mount it once. */
export function LoadingBarHost() {
  const held = useHeldLoading(useAnyBackgroundLoad());
  return held ? <TopBar /> : null;
}
