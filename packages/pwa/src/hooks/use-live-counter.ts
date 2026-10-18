import type { SessionLiveActivity } from '@ferretry/protocol';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { LiveActivityFeed } from '../lib/live-activity-feed.ts';
import { countUpValue, COUNT_UP_MS, msToNextSecond, wholeSecondsSince } from '../lib/live-counter.ts';
import { useTranscriptHold } from './use-live-clock.ts';

/**
 * The clock and timer a live readout runs on — injected, so a suite drives a fake clock instead of
 * waiting on the wall, and the browser's own is the default.
 */
export interface LiveScheduler {
  now(): number;
  /** Runs `action` after `ms`; the returned function cancels it. */
  after(ms: number, action: () => void): () => void;
}

const browserLiveScheduler: LiveScheduler = {
  now: () => Date.now(),
  after: (ms, action) => {
    const timer = setTimeout(action, ms);
    return () => clearTimeout(timer);
  },
};

/** One animation frame, near enough: the count-up's step. */
const FRAME_MS = 16;

export interface LiveCounterOptions {
  readonly scheduler?: LiveScheduler;
  /** While true the value stops advancing. Absent, the transcript's selection hold decides. */
  readonly hold?: boolean;
}

/**
 * Whole seconds since `start`, ticking exactly as each second is crossed, or `null` with no start.
 *
 * Each tick is scheduled for the instant the elapsed time reaches its next whole second
 * (`msToNextSecond`), so `41s` becomes `42s` on the turn's own clock, not on whatever phase the page
 * happened to mount at. A held transcript (a reader selecting text) freezes it and catches up on release.
 */
export function useLiveElapsed(start: number | null, options: LiveCounterOptions = {}): number | null {
  const { scheduler = browserLiveScheduler } = options;
  const transcriptHold = useTranscriptHold();
  const frozen = options.hold ?? transcriptHold;
  const [now, setNow] = useState(() => scheduler.now());
  useEffect(() => {
    if (start === null || frozen) return undefined;
    let cancel: () => void = () => undefined;
    const tick = (): void => {
      const instant = scheduler.now();
      setNow(instant);
      cancel = scheduler.after(msToNextSecond(start, instant), tick);
    };
    tick();
    return () => cancel();
  }, [frozen, scheduler, start]);
  return start === null ? null : wholeSecondsSince(start, now);
}

export interface CountUpOptions extends LiveCounterOptions {
  /** A new key starts a new count: the shown value jumps to the target instead of counting from the old turn's. */
  readonly resetKey?: string;
  readonly durationMs?: number;
}

/**
 * `target`, counted up to over {@link COUNT_UP_MS} each time it grows, never counted down.
 *
 * `null` stays `null` — an unknown count is shown as unknown, never as a zero that then counts up. A
 * new `resetKey` (a new turn) shows its first reading at once.
 */
export function useCountUp(target: number | null, options: CountUpOptions = {}): number | null {
  const { scheduler = browserLiveScheduler, resetKey = '', durationMs = COUNT_UP_MS } = options;
  const transcriptHold = useTranscriptHold();
  const frozen = options.hold ?? transcriptHold;
  const [shown, setShown] = useState<number | null>(target);
  const shownRef = useRef<number | null>(target);
  const keyRef = useRef(resetKey);

  useEffect(() => {
    const show = (value: number | null): void => {
      shownRef.current = value;
      setShown(value);
    };
    const from = shownRef.current;
    if (target === null || from === null || keyRef.current !== resetKey) {
      keyRef.current = resetKey;
      show(target);
      return undefined;
    }
    if (frozen || target <= from) return undefined;
    const began = scheduler.now();
    let cancel: () => void = () => undefined;
    const step = (): void => {
      const value = countUpValue(from, target, scheduler.now() - began, durationMs);
      show(value);
      if (value < target) cancel = scheduler.after(FRAME_MS, step);
    };
    step();
    return () => cancel();
  }, [durationMs, frozen, resetKey, scheduler, target]);

  return shown;
}

const NO_FEED: LiveActivityFeed = { subscribe: () => () => undefined, current: () => null };

/** The latest live sample a session's feed carried, or `null` with no feed or none yet. */
export const useLiveActivity = (feed: LiveActivityFeed | undefined): SessionLiveActivity | null => {
  const source = feed ?? NO_FEED;
  return useSyncExternalStore(source.subscribe, source.current, () => null);
};
