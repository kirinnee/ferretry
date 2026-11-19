/**
 * THE SETTING PREVIEW — a small mini-frame (about 160 × 100) drawn with divs that sits beside a setting and shows
 * what the setting does: a short loop of "before → after" for the value being hovered or chosen.
 *
 *   <SettingRow name="Side" preview={<SettingPreview label="The menu on the left" value="left" before={…} after={…} />} …/>
 *
 * The caller owns the scene (`before` and `after` are the mini-frame drawn for the old and the new value); this file
 * owns when it moves:
 *
 *   - It loops `before` → `after` → `before` as one slow cross-fade (`setting-preview.css`), and replays from the start
 *     whenever `value` changes, so choosing a value answers with the movement.
 *   - It pauses while the tab is hidden (`useDocumentVisible`) or the frame is scrolled off-screen
 *     (`IntersectionObserver`): a thing nobody sees costs nothing.
 *   - With motion off (the OS's reduced-motion query OR Settings › Appearance › Motion = reduced) it shows the FINAL
 *     state only — `after` — and mounts nothing else. The stylesheet's resting state is also the final one, so a
 *     stylesheet that never matches still draws the answer.
 *
 * No library, no timer and no per-frame script: the loop is CSS on `opacity`, one composited layer per state.
 * A scene that wants to move a piece of itself (a menu sliding, a line being typed) hangs its own animation off
 * `.fy-sp[data-sp-state='playing']` and reads the loop length from `var(--sp-loop)`.
 */

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useDocumentVisible } from '../ui/hooks/use-document-visible.ts';
import { cn } from '../ui/lib/class-names.ts';
import './setting-preview.css';

/** The length of one loop, in milliseconds (also `--sp-loop` in the stylesheet). */
export const SETTING_PREVIEW_LOOP_MS = 4200;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** `still` (final state only), `playing`, or `paused` (hidden tab or scrolled off-screen). */
export type SettingPreviewState = 'still' | 'playing' | 'paused';

/** The app's two motion switches, as one: the OS query and `<html data-motion="reduced">`. */
const motionAllowedNow = (): boolean =>
  typeof document !== 'undefined' &&
  document.documentElement.dataset.motion !== 'reduced' &&
  !(typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches);

function useMotionAllowed(): boolean {
  const [allowed, setAllowed] = useState(motionAllowedNow);
  useEffect(() => {
    const sync = (): void => setAllowed(motionAllowedNow());
    sync();
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION) : undefined;
    media?.addEventListener('change', sync);
    const watcher = new MutationObserver(sync);
    watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    return () => {
      media?.removeEventListener('change', sync);
      watcher.disconnect();
    };
  }, []);
  return allowed;
}

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

export interface SettingPreviewProps {
  /** What the frame shows once it has settled: the value's effect in a few words (its accessible name). */
  readonly label: string;
  /** The value being previewed. A change replays the loop from the start. */
  readonly value: string;
  /** The frame drawn for the value before this one. Without it, or with motion off, only `after` is drawn. */
  readonly before?: ReactNode;
  /** The frame drawn for `value`: the final state. */
  readonly after: ReactNode;
  readonly className?: string;
}

export function SettingPreview({ label, value, before, after, className }: SettingPreviewProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const motionAllowed = useMotionAllowed();
  const visible = useDocumentVisible();
  const onScreen = useOnScreen(frame);
  const state: SettingPreviewState =
    !motionAllowed || before === undefined ? 'still' : visible && onScreen ? 'playing' : 'paused';
  return (
    <div
      ref={frame}
      role="img"
      aria-label={label}
      data-setting-preview=""
      data-sp-state={state}
      data-sp-value={value}
      className={cn('fy-sp', className)}
    >
      {/* Keyed by the value: a new value is a new stage, so its loop starts again from `before`. */}
      <div key={value} className="fy-sp__stage" aria-hidden="true">
        {state === 'still' ? null : <div className="fy-sp__layer fy-sp__layer--before">{before}</div>}
        <div className="fy-sp__layer fy-sp__layer--after">{after}</div>
      </div>
    </div>
  );
}
