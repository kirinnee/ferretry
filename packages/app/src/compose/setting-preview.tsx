/**
 * THE SETTING PREVIEW — a small mini-frame (about 160 × 100) drawn with divs that sits beside a setting and shows
 * what the setting does: ONE short movement of "before → after" when the value changes, then it rests.
 *
 *   <SettingRow name="Side" preview={<SettingPreview label="The menu on the left" value="left" before={…} after={…} />} …/>
 *
 * The caller owns the scene (`before` and `after` are the mini-frame drawn for the old and the new value); this file
 * owns when it moves:
 *
 *   - It RESTS on the selected value (`after` only): the frame is never blank and never loops. Repeating does not
 *     help (owner, !A565), so there is no loop at all.
 *   - When `value` changes it plays once, as two layers taking turns (`setting-preview.css`): `before` fades out, then
 *     `after` in, never both at once, so no label lands on another. When the movement ends (`animationend`) it returns to
 *     rest. Choosing a value answers with the movement; opening the tab does not.
 *   - Until its content has mounted (a lazy scene) it draws a SKELETON of the same size, not an empty box.
 *   - `fit="contain"` draws a scene authored at `sceneSize` scaled to whatever box it is given.
 *   - It pauses a movement while the tab is hidden (`useDocumentVisible`) or the frame is scrolled off-screen
 *     (`IntersectionObserver`): a thing nobody sees costs nothing.
 *   - With motion off (the OS's reduced-motion query OR Settings › Appearance › Motion) it shows the FINAL
 *     state only — `after` — and mounts nothing else. The stylesheet's resting state is also the final one.
 *
 * No library and no per-frame script: the movement is CSS on `opacity`, one composited layer per state. A scene
 * that wants to move a piece of itself (a menu sliding, a line being typed) hangs its own animation off
 * `.fy-sp:not([data-sp-state='still'])` (so a pause holds its phase) and reads the length from `var(--sp-loop)`.
 */

import { type CSSProperties, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { useDocumentVisible } from '../ui/hooks/use-document-visible.ts';
import { cn } from '../ui/lib/class-names.ts';
import { useMotionAllowed } from '../ui/use-motion-allowed.ts';
import './setting-preview.css';

/** The length of the one movement, in milliseconds (also `--sp-loop` in the stylesheet). */
export const SETTING_PREVIEW_PLAY_MS = 1400;

/** `still` (resting on the final state), `playing` (the one movement), or `paused` (it, in a hidden tab or off-screen). */
export type SettingPreviewState = 'still' | 'playing' | 'paused';

/** Is `element` in view? An environment with no observer counts as in view. */
function useOnScreen(element: { current: Element | null }): boolean {
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const target = element.current;
    if (target === null || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(entries => {
      const last = entries[entries.length - 1];
      if (last !== undefined) setOnScreen(last.isIntersecting);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return onScreen;
}

/**
 * Is a frame worth animating right now: the document is visible AND the frame is in view. Every moving preview gates
 * its loop on this one answer (the setting-preview frame, and the chat-width strip that draws its own), so none keeps
 * running in a hidden tab or off-screen.
 */
export function usePreviewPlaying(element: { current: Element | null }): boolean {
  const visible = useDocumentVisible();
  const onScreen = useOnScreen(element);
  return visible && onScreen;
}

/** The size a scene is authored at, which `fit="contain"` scales into the frame it is given. */
const SCENE_SIZE = { width: 160, height: 100 } as const;

/** The scale that fits a scene of `scene` size inside the frame, never above 1 and 1 where nothing can measure. */
function useContainScale(
  frame: { current: HTMLElement | null },
  scene: { readonly width: number; readonly height: number },
  active: boolean,
): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const target = frame.current;
    if (!active || target === null || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const { clientWidth, clientHeight } = target;
      if (clientWidth > 0 && clientHeight > 0) {
        setScale(Math.min(1, clientWidth / scene.width, clientHeight / scene.height));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [frame, scene.width, scene.height, active]);
  return scale;
}

/** The same-size placeholder a lazy scene shows before it has mounted: quiet blocks, no motion, never a blank box. */
function SceneSkeleton() {
  return (
    <div className="fy-sp__skeleton" data-sp-skeleton="">
      <span className="fy-sp__skeleton-bar" />
      <span className="fy-sp__skeleton-bar fy-sp__skeleton-bar--short" />
      <span className="fy-sp__skeleton-block" />
    </div>
  );
}

export interface SettingPreviewProps {
  /**
   * What the frame shows once it has settled: the value's effect in a few words. The frame is decorative
   * (`aria-hidden`, no role, no name: the row's own control already says it), so this is a `data-sp-label` for tests.
   */
  readonly label: string;
  /** The value being previewed. A change plays the movement once, then the frame rests on it. */
  readonly value: string;
  /** The frame drawn for the value before this one. Without it, or with motion off, only `after` is drawn. */
  readonly before?: ReactNode;
  /** The frame drawn for `value`: the final state, and the resting one. */
  readonly after: ReactNode;
  /** `contain` scales a scene authored at `sceneSize` to the box the frame is given (a caller's `className` may size it). */
  readonly fit?: 'none' | 'contain';
  /** The size the scene is authored at; defaults to the 160 × 100 frame. */
  readonly sceneSize?: { readonly width: number; readonly height: number };
  readonly className?: string;
}

export function SettingPreview({
  label,
  value,
  before,
  after,
  fit = 'none',
  sceneSize = SCENE_SIZE,
  className,
}: SettingPreviewProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const motionAllowed = useMotionAllowed();
  const visible = usePreviewPlaying(frame);
  const canMove = motionAllowed && before !== undefined;
  // A new value starts the one movement in the SAME render (no frame of the final state first); a first mount rests.
  // It is armed whatever motion says right now: the Motion setting changes its own preference and its value in one act.
  const [seen, setSeen] = useState(value);
  const [playing, setPlaying] = useState(false);
  if (seen !== value) {
    setSeen(value);
    setPlaying(true);
  }
  const moving = canMove && playing;
  const state: SettingPreviewState = !moving ? 'still' : visible ? 'playing' : 'paused';
  const rest = () => setPlaying(false);
  const scale = useContainScale(frame, sceneSize, fit === 'contain');
  const stageStyle: CSSProperties | undefined =
    fit === 'contain'
      ? { width: sceneSize.width, height: sceneSize.height, transform: `translate(-50%, -50%) scale(${scale})` }
      : undefined;
  return (
    <div
      ref={frame}
      aria-hidden="true"
      data-setting-preview=""
      data-sp-label={label}
      data-sp-state={state}
      data-sp-value={value}
      data-sp-fit={fit}
      className={cn('fy-sp', className)}
    >
      {/* Keyed by the value: a new value is a new stage, so its movement starts again from `before`. */}
      <div
        key={value}
        className={cn('fy-sp__stage', fit === 'contain' && 'fy-sp__stage--fit')}
        style={stageStyle}
        aria-hidden="true"
      >
        <Suspense fallback={<SceneSkeleton />}>
          {!moving ? null : <div className="fy-sp__layer fy-sp__layer--before">{before}</div>}
          <div
            className="fy-sp__layer fy-sp__layer--after"
            onAnimationEnd={event => {
              if (event.target === event.currentTarget) rest();
            }}
          >
            {after}
          </div>
        </Suspense>
      </div>
    </div>
  );
}
