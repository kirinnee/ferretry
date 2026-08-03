/**
 * SOLE OWNER of the `fy-onboarding-v1` browser-storage key.
 *
 * Setup happens across two devices and a terminal: the reader leaves to run a
 * command and comes back minutes — or hours, after the tab was evicted — later.
 * Losing their place is the cheapest possible way to make this feel broken, so
 * the step they are on is a persisted preference, following the versioned
 * `fy-<thing>-v1` document convention `lib/theme-preferences.ts` records.
 *
 * Deliberately NOT daemon-scoped: this state exists before any daemon does, and
 * it is not evidence of anything. The AUTHORITATIVE "setup is over" signal is a
 * paired connection in `DaemonConnectionStore`; progress only decides which
 * step to resume on.
 *
 * DAMAGED STATE IS NOT PROGRESS. A malformed, wrong-version or self-inconsistent
 * document reads as a fresh start rather than as "everything is done": the
 * benign reading would drop someone who never installed anything onto a pairing
 * screen with nothing to pair.
 */

import {
  furthestOnboardingStep,
  isOnboardingStepId,
  onboardingStepIndex,
  type OnboardingStepId,
} from './onboarding-model.ts';

export const ONBOARDING_PROGRESS_KEY = 'fy-onboarding-v1';
export const ONBOARDING_PROGRESS_VERSION = 1;

export interface OnboardingProgress {
  readonly v: typeof ONBOARDING_PROGRESS_VERSION;
  /** Where the reader is now. */
  readonly current: OnboardingStepId;
  /** The furthest step they have ever reached, which is what stays jumpable. */
  readonly furthest: OnboardingStepId;
}

export const FRESH_ONBOARDING_PROGRESS: OnboardingProgress = Object.freeze({
  v: ONBOARDING_PROGRESS_VERSION,
  current: 'install' as const,
  furthest: 'install' as const,
});

const fresh = (): OnboardingProgress => ({ ...FRESH_ONBOARDING_PROGRESS });

/**
 * Parse, do not validate: anything that is not exactly a version-1 document
 * with two known steps and `current` no further than `furthest` is a fresh
 * start. There is no partial recovery, because a half-trusted step number is
 * indistinguishable from a made-up one.
 */
export const parseOnboardingProgress = (raw: string | null | undefined): OnboardingProgress => {
  if (!raw) return fresh();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fresh();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fresh();
  const fields = parsed as Record<string, unknown>;
  if (fields.v !== ONBOARDING_PROGRESS_VERSION) return fresh();
  const { current, furthest } = fields;
  if (!isOnboardingStepId(current) || !isOnboardingStepId(furthest)) return fresh();
  if (onboardingStepIndex(current) > onboardingStepIndex(furthest)) return fresh();
  return { v: ONBOARDING_PROGRESS_VERSION, current, furthest };
};

export interface OnboardingProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `localStorage`, or nothing — Safari private mode throws on the property itself. */
export const browserOnboardingStorage = (): OnboardingProgressStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: OnboardingProgressStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

export interface OnboardingProgressStoreOptions {
  readonly storage?: OnboardingProgressStorage | undefined;
  /**
   * A step the ARRIVAL itself proves the reader has reached — a tab opened from
   * a pairing link is past install whatever storage remembers. Applied on read
   * rather than written, so merely opening a link never rewrites progress.
   */
  readonly entry?: OnboardingStepId | undefined;
}

/**
 * The stepper's place in the arc, shaped for `useSyncExternalStore`:
 * `snapshot()` is identity-stable between commits, and the first read hydrates.
 */
export class OnboardingProgressStore {
  readonly #storage: OnboardingProgressStorage | undefined;
  readonly #entry: OnboardingStepId | undefined;
  readonly #listeners = new Set<() => void>();
  #snapshot: OnboardingProgress | null = null;

  constructor(options: OnboardingProgressStoreOptions = {}) {
    this.#storage = 'storage' in options ? options.storage : browserOnboardingStorage();
    this.#entry = options.entry;
  }

  snapshot = (): OnboardingProgress => {
    this.#snapshot ??= this.#load();
    return this.#snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Moves the reader, remembering the furthest point so the jump back is reversible. */
  goTo(step: OnboardingStepId): OnboardingProgress {
    const next: OnboardingProgress = {
      v: ONBOARDING_PROGRESS_VERSION,
      current: step,
      furthest: furthestOnboardingStep(this.snapshot().furthest, step),
    };
    this.#snapshot = next;
    this.#save(next);
    for (const listener of this.#listeners) listener();
    return next;
  }

  #load(): OnboardingProgress {
    const stored = this.#read();
    const entry = this.#entry;
    if (entry === undefined) return stored;
    return { v: ONBOARDING_PROGRESS_VERSION, current: entry, furthest: furthestOnboardingStep(stored.furthest, entry) };
  }

  #read(): OnboardingProgress {
    if (!this.#storage) return fresh();
    try {
      return parseOnboardingProgress(this.#storage.getItem(ONBOARDING_PROGRESS_KEY));
    } catch {
      return fresh();
    }
  }

  /** A refused write never blocks the stepper; the tab keeps its place in memory. */
  #save(progress: OnboardingProgress): void {
    if (!this.#storage) return;
    try {
      this.#storage.setItem(ONBOARDING_PROGRESS_KEY, JSON.stringify(progress));
    } catch {
      /* storage denial is an ordinary browser condition, not a setup failure */
    }
  }
}
