/**
 * Is this reader on a device where focusing a text field summons a keyboard?
 *
 * Ported from the `touchAffected` half of kteam's `hooks/useInputModality.ts`.
 * The other half of that hook — `enterSends`, and the global pointer tracking
 * that feeds it — belongs to the composer, not here: autofocusing a textarea
 * needs to know what the pointing device IS, never what it last DID.
 *
 * THE BIAS IS DELIBERATE AND ONE-WAY. Every signal must positively say
 * "fine-pointer, hovering, no coarse pointer anywhere" before a surface is
 * allowed to autofocus. An unknown environment, a hybrid laptop with a
 * touchscreen, and a phone all read as touch-affected. Being wrong in that
 * direction costs a desktop reader one click; being wrong in the other throws
 * a keyboard over half a phone screen the instant a panel opens.
 */

import { useSyncExternalStore } from 'react';

/** What the five media queries answered, or `null` where nothing answered. */
export interface TouchModalitySignals {
  readonly finePrimary: boolean | null;
  readonly coarsePrimary: boolean | null;
  readonly hoverPrimary: boolean | null;
  readonly noHoverPrimary: boolean | null;
  readonly anyCoarse: boolean | null;
}

const MEDIA_QUERIES = {
  finePrimary: '(pointer: fine)',
  coarsePrimary: '(pointer: coarse)',
  hoverPrimary: '(hover: hover)',
  noHoverPrimary: '(hover: none)',
  anyCoarse: '(any-pointer: coarse)',
} as const satisfies Record<keyof TouchModalitySignals, string>;

/**
 * The pure policy, exported so the whole device table can be asserted without
 * a DOM. Note every comparison is against an explicit `true`/`false`: a `null`
 * signal is not "no", it is "nobody said", and it lands on touch-affected.
 */
export const touchAffectedFrom = (signals: TouchModalitySignals): boolean =>
  signals.finePrimary !== true ||
  signals.coarsePrimary !== false ||
  signals.hoverPrimary !== true ||
  signals.noHoverPrimary !== false ||
  signals.anyCoarse !== false;

/** The slice of `MediaQueryList` this needs, so a test never fakes a whole DOM. */
export interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
}

export type MediaMatcher = (query: string) => MediaQueryListLike | null;

const ambientMatcher = (): MediaMatcher | null => {
  // Read through the host object rather than a detached reference: several
  // engines reject `matchMedia` invoked without its window as the receiver.
  const host = globalThis as typeof globalThis & { matchMedia?: (query: string) => MediaQueryListLike };
  if (typeof host.matchMedia !== 'function') return null;
  return query => {
    try {
      return host.matchMedia?.(query) ?? null;
    } catch {
      // A browser that refuses a query it does not understand must not take
      // the surface down with it; an unreadable signal is simply unknown.
      return null;
    }
  };
};

const signalsFrom = (matcher: MediaMatcher | null): TouchModalitySignals => {
  const read = (query: string): boolean | null => matcher?.(query)?.matches ?? null;
  return {
    finePrimary: read(MEDIA_QUERIES.finePrimary),
    coarsePrimary: read(MEDIA_QUERIES.coarsePrimary),
    hoverPrimary: read(MEDIA_QUERIES.hoverPrimary),
    noHoverPrimary: read(MEDIA_QUERIES.noHoverPrimary),
    anyCoarse: read(MEDIA_QUERIES.anyCoarse),
  };
};

/** Reads the ambient environment once. Absent `matchMedia` ⇒ touch-affected. */
export const readTouchAffected = (): boolean => touchAffectedFrom(signalsFrom(ambientMatcher()));

/**
 * Re-reads when a query flips — a tablet gaining a keyboard, a laptop losing a
 * mouse. Listener registration is best-effort: a matcher without
 * `addEventListener` still reports its current value, it just will not update.
 */
export const subscribeToTouchAffected = (onChange: () => void): (() => void) => {
  const matcher = ambientMatcher();
  if (matcher === null) return () => undefined;
  const detach: Array<() => void> = [];
  for (const query of Object.values(MEDIA_QUERIES)) {
    const list = matcher(query);
    if (list?.addEventListener === undefined) continue;
    list.addEventListener('change', onChange);
    detach.push(() => list.removeEventListener?.('change', onChange));
  }
  return () => {
    for (const off of detach) off();
  };
};

/** Prerender snapshot: nothing has been measured yet, so assume touch. */
export const serverTouchAffected = (): boolean => true;

/**
 * `useSyncExternalStore` rather than an effect, because the answer is needed by
 * the very render that decides `autoFocus` — a value that arrives one commit
 * late has already missed the only moment it mattered.
 */
export const useTouchAffected = (): boolean =>
  useSyncExternalStore(subscribeToTouchAffected, readTouchAffected, serverTouchAffected);
