/**
 * THE LIVE BAR: a pure view of `LiveView` (`lib/voice-chat/live-view.ts`).
 *
 * Every rule about wording and about which control is offered is decided there and tested without a DOM;
 * this file only draws it. On a phone it is the big button, its ring and a row of 48 px targets; on a
 * computer it is one compact strip above the composer with the keys written on the buttons.
 *
 * ACCESSIBILITY (ADHD / dyslexia first, docs/voice.md › Live voice):
 *   - The state is always WORDS (`stateWord`, then `detail` under it). Colour only restates it.
 *   - The countdown is also a number. With reduced motion the ring is not drawn and the number is large;
 *     the level bars become one still level meter (a labelled track that fills with the voice).
 *   - A visually hidden polite live region says what changed: the phase, "Sending in 2 seconds" ONCE when
 *     the ring starts (not every tick), the notice line. It never carries the reply (that would speak
 *     over the voice that reads it).
 *   - Keys run only while focus is not in a text field, and never with ctrl, meta or alt held.
 */

import { AlertCircle } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '../lib/class-names.ts';
import { type LiveKeyAction, type LiveView, liveKeyAction } from '../lib/voice-chat/live-view.ts';
import { usePrefersReducedMotion } from '../shell/bottom-sheet.tsx';

export interface LiveVoiceBarProps {
  readonly view: LiveView;
  readonly layout: 'phone' | 'desktop';
  /** The microphone level, 0..1, newest last. Only the last {@link MAX_BARS} are drawn. */
  readonly levels: readonly number[];
  /** Defaults to the page's own `prefers-reduced-motion`. */
  readonly reducedMotion?: boolean;
  onHold(): void;
  onSendNow(): void;
  onResume(): void;
  onEnd(): void;
  onSkip(): void;
  onRepeat(): void;
}

export const MAX_BARS = 32;
const RING_RADIUS = 54;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const MIN_BAR = 0.06;

/** A level from anything: clamped into 0..1, garbage is silence. */
const clampLevel = (level: number): number => (Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0);

/** The bars to draw: the last {@link MAX_BARS} levels, or ONE bar (the newest) when motion is reduced. */
export function barLevels(levels: readonly number[], reduced: boolean): readonly number[] {
  const recent = levels.slice(-MAX_BARS).map(clampLevel);
  if (reduced) return [recent.length === 0 ? 0 : (recent.at(-1) ?? 0)];
  return recent;
}

/** What the live region says about `view`, and the key that says when it is a new thing to say. */
export function liveAnnouncement(view: LiveView): { readonly key: string; readonly text: string } | null {
  if (!view.visible || view.phase === 'off') return null;
  const base = (() => {
    switch (view.phase) {
      case 'starting':
        return { key: 'starting', text: 'Starting' };
      case 'listening':
        return { key: 'listening', text: 'Listening' };
      case 'hearing':
        return { key: 'hearing', text: 'Hearing you' };
      case 'sending':
        // The ring's ticks are not news: said once, when it starts.
        return view.ring === null || view.ring.secondsLeft === 0
          ? { key: `sending:${view.stateWord}`, text: view.stateWord }
          : {
              key: 'sending:ring',
              text: `Sending in ${view.ring.secondsLeft} ${view.ring.secondsLeft === 1 ? 'second' : 'seconds'}`,
            };
      case 'working':
        return { key: 'working', text: 'Ferret is working' };
      case 'reading':
        // The state in words, never the reply itself: the voice is already saying it.
        return { key: `reading:${view.stateWord}`, text: view.stateWord };
      case 'hold':
        return { key: `hold:${view.stateWord}`, text: view.stateWord };
      case 'paused':
        return { key: 'paused', text: 'Paused' };
    }
  })();
  return view.detail === null ? base : { key: `${base.key}|${view.detail}`, text: `${base.text}. ${view.detail}` };
}

const isTextField = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;

/** A control that already answers Enter and Space itself: handling them here too would act twice. */
const isActivatable = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('button, a[href], [role="button"]') !== null;

function Dot() {
  return <span className="fy-live-dot" aria-hidden="true" />;
}

/** The microphone's level: moving bars, or with reduced motion ONE still, labelled meter. */
function Bars({ levels, reduced }: { levels: readonly number[]; reduced: boolean }) {
  const drawn = barLevels(levels, reduced);
  if (reduced) {
    const level = drawn[0] ?? 0;
    return (
      <span className="fy-live-level" data-level={Math.round(level * 100)} aria-hidden="true">
        <span className="fy-live-level-label">Mic level</span>
        <span className="fy-live-level-track">
          <span className="fy-live-level-fill" style={{ width: `${Math.round(level * 100)}%` }} />
        </span>
      </span>
    );
  }
  return (
    <span className="fy-live-bars" data-bars={drawn.length} aria-hidden="true">
      {drawn.map((level, index) => (
        <span
          // Newest last and the window slides, so the position is the identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: a sliding window of anonymous levels
          key={index}
          className="fy-live-bar"
          style={{ height: `${Math.round(Math.max(MIN_BAR, level) * 100)}%` }}
        />
      ))}
    </span>
  );
}

/** The countdown as a bar along the strip: it fills from the pause to the send. */
function Progress({ progress }: { progress: number }) {
  return (
    <span className="fy-live-progress" data-progress={Math.round(progress * 100)} aria-hidden="true">
      <span className="fy-live-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
    </span>
  );
}

function Key({ children }: { children: string }) {
  return <kbd className="fy-live-key">{children}</kbd>;
}

function Ring({ progress }: { progress: number }) {
  return (
    <svg className="fy-live-ring" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <circle className="fy-live-ring-track" cx="60" cy="60" r={RING_RADIUS} />
      <circle
        className="fy-live-ring-fill"
        cx="60"
        cy="60"
        r={RING_RADIUS}
        strokeDasharray={RING_LENGTH}
        strokeDashoffset={RING_LENGTH * (1 - progress)}
      />
    </svg>
  );
}

export function LiveVoiceBar(props: LiveVoiceBarProps) {
  const { view, layout, levels, onHold, onSendNow, onResume, onEnd, onSkip, onRepeat } = props;
  const pageReduced = usePrefersReducedMotion();
  const reduced = props.reducedMotion ?? pageReduced;

  const keyed = view.visible && view.phase !== 'off';
  useEffect(() => {
    if (!keyed) return;
    const run: Record<LiveKeyAction, () => void> = {
      hold: onHold,
      'send-now': onSendNow,
      resume: onResume,
      skip: onSkip,
      repeat: onRepeat,
      end: onEnd,
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      if (isTextField(event.target)) return;
      if ((event.key === 'Enter' || event.key === ' ') && isActivatable(event.target)) return;
      const action = liveKeyAction(event.key, view);
      if (action === null) return;
      event.preventDefault();
      run[action]();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [keyed, view, onHold, onSendNow, onResume, onSkip, onRepeat, onEnd]);

  // The live region: filled AFTER mount (a region that arrives full is not read), and only when the
  // announcement's key changes.
  const announcement = liveAnnouncement(view);
  const [said, setSaid] = useState<{ key: string; text: string } | null>(null);
  if ((announcement?.key ?? null) !== (said?.key ?? null)) setSaid(announcement);
  const [spoken, setSpoken] = useState('');
  useEffect(() => setSpoken(said?.text ?? ''), [said]);

  if (!view.visible) return null;

  if (view.phase === 'off') {
    // Live refused to start: the words say why and what to do; there is nothing to press.
    return (
      <div className="fy-live fy-live-notice" data-live-notice data-tone={view.tone} role="status">
        <AlertCircle size={16} aria-hidden="true" className="fy-live-notice-icon" />
        <p className="fy-live-notice-text">{view.detail}</p>
      </div>
    );
  }

  // The big number is for a countdown with seconds left; "Getting your words…" is words, set at the normal size.
  const countdownBig = reduced && view.ring !== null && view.ring.secondsLeft > 0;
  const region = (
    <span className="fy-live-sr" aria-live="polite" aria-atomic="true" data-live-region>
      {spoken}
    </span>
  );
  const stateLine = (
    <p className={cn('fy-live-state', countdownBig && 'fy-live-state--count')} data-live-state>
      {view.stateWord}
    </p>
  );
  const detailLine = (
    <p className="fy-live-detail" data-live-detail>
      {view.detail}
    </p>
  );
  const words = (
    <p className="fy-live-words" data-live-words={view.liveWords === '' ? 'empty' : 'heard'}>
      {view.liveWords}
    </p>
  );
  // Only where the microphone is listening and nothing is counting down: a meter of a closed mic would be a lie.
  const bars = view.micOpen && view.ring === null ? <Bars levels={levels} reduced={reduced} /> : null;
  const progress = view.ring !== null && !reduced ? <Progress progress={view.ring.progress} /> : null;

  if (layout === 'desktop') {
    const action = (label: string, key: string, shortcut: string, onPress: () => void): ReactNode => (
      <button
        type="button"
        className="fy-live-btn"
        aria-keyshortcuts={shortcut}
        onClick={onPress}
        data-live-action={label}
      >
        {label} <Key>{key}</Key>
      </button>
    );
    // While a reply is being read Esc stops the reading, so End is a button only.
    const plainAction = (label: string, onPress: () => void): ReactNode => (
      <button type="button" className="fy-live-btn" onClick={onPress} data-live-action={label}>
        {label}
      </button>
    );
    return (
      <section
        className="fy-live fy-live--desktop"
        aria-label="Live voice"
        data-live-phase={view.phase}
        data-tone={view.tone}
      >
        <div className="fy-live-row">
          <span className="fy-live-pill fy-live-pill--static">
            <Dot />
            LIVE
          </span>
          {stateLine}
          {bars}
          {words}
          <span className="fy-live-actions">
            {view.canHold ? action('Hold', 'H', 'H', onHold) : null}
            {view.canSendNow ? action('Send now', '↵', 'Enter', onSendNow) : null}
            {view.canResume ? action(view.big.label === 'Listen' ? 'Listen' : 'Resume', 'Space', ' ', onResume) : null}
            {view.canSkip ? action('Stop reading', 'Space', 'Space Escape S', onSkip) : null}
            {view.canRepeat ? action('Repeat', 'R', 'R', onRepeat) : null}
            {view.canEnd ? (view.canSkip ? plainAction('End', onEnd) : action('End', 'Esc', 'Escape', onEnd)) : null}
          </span>
        </div>
        {progress}
        {detailLine}
        {region}
      </section>
    );
  }

  const bigAction: Record<typeof view.big.action, (() => void) | null> = {
    hold: onHold,
    resume: onResume,
    skip: onSkip,
    none: null,
  };
  const press = bigAction[view.big.action];
  return (
    <section
      className="fy-live fy-live--phone"
      aria-label="Live voice"
      data-live-phase={view.phase}
      data-tone={view.tone}
    >
      <div className="fy-live-top">
        <button type="button" className="fy-live-pill" aria-label="End Live voice" onClick={onEnd}>
          <Dot />
          LIVE
        </button>
        {stateLine}
      </div>
      {detailLine}
      {words}
      {bars}
      <div className="fy-live-big">
        {view.ring !== null && !reduced ? <Ring progress={view.ring.progress} /> : null}
        <button
          type="button"
          className="fy-live-bigbtn"
          disabled={press === null}
          onClick={press ?? undefined}
          data-live-big={view.big.action}
        >
          {view.big.label}
        </button>
      </div>
      <div className="fy-live-targets">
        {/* Hold is the big button wherever it is offered: one Hold on screen, not two. */}
        {view.canSendNow ? (
          <button type="button" className="fy-live-btn" onClick={onSendNow}>
            Send now
          </button>
        ) : null}
        {view.canRepeat ? (
          <button type="button" className="fy-live-btn" onClick={onRepeat} aria-keyshortcuts="R">
            Repeat
          </button>
        ) : null}
        {view.canEnd ? (
          <button type="button" className="fy-live-btn" onClick={onEnd}>
            End
          </button>
        ) : null}
      </div>
      {region}
    </section>
  );
}
