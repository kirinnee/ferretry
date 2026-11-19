/**
 * CI run page, the live half (r9 E9): one read, then a re-read every few seconds while anything still runs, and a clock
 * that ticks once a second while it does, so a running step's duration moves without a request. Nothing runs while the
 * tab is hidden or when everything has finished.
 */
import { useDocumentVisible } from '@ferretry/app';
import { type ReadPress, readPress } from '@ferretry/app/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CiRun } from '../../../contract/wire.ts';
import { type CiFailure, failureOf } from './ci-api.ts';
import { anyLive } from './ci-format.ts';

/** How often a live run is re-read. The daemon answers from GitHub's ETag cache, so a quiet minute costs no budget. */
const LIVE_REFRESH_MS = 10_000;

export type CiLoad<Value> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: Value; readonly refreshFailed?: CiFailure }
  | { readonly kind: 'failed'; readonly failure: CiFailure };

/** `read` once, and again every `LIVE_REFRESH_MS` while `live(value)` says something still moves. */
export function useLiveRead<Value>(
  key: string,
  read: (signal: AbortSignal, press: ReadPress) => Promise<Value>,
  live: (value: Value) => boolean,
): { readonly state: CiLoad<Value>; readonly reload: () => void } {
  // The load is kept WITH the subject it answers, so a different subject reads as loading at once (never the last subject's rows).
  const [round, setRound] = useState(0);
  // Set by Try again, spent by the very next read: only that one is the person's press.
  const pressed = useRef(false);
  // "Try again" is a new subject: it reads as loading, then answers.
  const subject = round === 0 ? key : `${key}#${round}`;
  const [held, setHeld] = useState<{ readonly key: string; readonly load: CiLoad<Value> }>({
    key: subject,
    load: { kind: 'loading' },
  });
  const state: CiLoad<Value> = held.key === subject ? held.load : { kind: 'loading' };
  const visible = useDocumentVisible();
  const reader = useRef(read);
  reader.current = read;
  const isLive = useRef(live);
  isLive.current = live;

  useEffect(() => {
    if (!visible) return undefined;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let press = readPress(pressed.current);
    pressed.current = false;
    const tick = (): void => {
      const spent = press;
      press = {};
      reader.current(abort.signal, spent).then(
        value => {
          if (abort.signal.aborted) return;
          setHeld({ key: subject, load: { kind: 'ready', value } });
          if (isLive.current(value)) timer = setTimeout(tick, LIVE_REFRESH_MS);
        },
        (cause: unknown) => {
          if (abort.signal.aborted) return;
          const failure = failureOf(cause);
          // A read that fails after one that worked keeps what was shown and says the refresh failed.
          setHeld(previous => {
            const kept = previous.key === subject ? previous.load : undefined;
            return {
              key: subject,
              load:
                kept?.kind === 'ready'
                  ? { kind: 'ready', value: kept.value, refreshFailed: failure }
                  : { kind: 'failed', failure },
            };
          });
          timer = setTimeout(tick, LIVE_REFRESH_MS);
        },
      );
    };
    tick();
    return () => {
      abort.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [subject, visible]);

  const reload = useCallback(() => {
    pressed.current = true;
    setRound(value => value + 1);
  }, []);
  return { state, reload };
}

/** The clock for a running bar: `fixed` (a test, a screenshot) is returned as given and starts no timer. */
export function useSecondClock(running: boolean, fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined || !running) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fixed, running]);
  return fixed ?? now;
}

export const runsLive = (runs: readonly CiRun[]): boolean => anyLive(runs);
