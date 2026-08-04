/**
 * SOLE OWNER of the `fy-onboarding-v2` browser-storage key.
 *
 * Setup happens across two devices and a terminal: the reader leaves to run a
 * command and comes back minutes — or hours, after the tab was evicted — later.
 * Losing their place is the cheapest possible way to make this feel broken, so
 * both the ROUTE they chose and the step they are on are a persisted preference,
 * following the versioned `fy-<thing>-v<n>` document convention
 * `lib/theme-preferences.ts` records.
 *
 * The key moved from `v1` to `v2` when the single fixed arc became three routes.
 * A `v1` document describes a step list that no longer exists, and there is no
 * honest mapping from "step 3 of the old four" onto a route nobody chose — so it
 * is ignored, and its owner is asked the question once. That is a lost place, not
 * lost work: nothing on this page is state the daemon does not already hold.
 *
 * Deliberately NOT daemon-scoped: this state exists before any daemon does, and
 * it is not evidence of anything. The AUTHORITATIVE "setup is over" signal is a
 * paired connection in `DaemonConnectionStore`; progress only decides which
 * screen to resume on.
 *
 * DAMAGED STATE IS NOT PROGRESS. A malformed, wrong-version or self-inconsistent
 * document reads as the chooser rather than as "everything is done": the benign
 * reading would drop someone who never installed anything onto a pairing screen
 * with nothing to pair.
 */

import {
  type ConnectionMethodId,
  firstOnboardingStep,
  furthestOnboardingStep,
  isConnectionMethodId,
  isOnboardingRouteId,
  isOnboardingStepId,
  isStepOfRoute,
  type OnboardingRouteId,
  type OnboardingStepId,
  onboardingStepIndex,
} from './onboarding-model.ts';

export const ONBOARDING_PROGRESS_KEY = 'fy-onboarding-v2';
export const ONBOARDING_PROGRESS_VERSION = 2;

/** The chooser is on the glass: no route, and therefore no step. */
export interface OnboardingChoosing {
  readonly v: typeof ONBOARDING_PROGRESS_VERSION;
  readonly stage: 'choose';
}

/** A route is being walked, and only steps belonging to THAT route can be here. */
export interface OnboardingWalking {
  readonly v: typeof ONBOARDING_PROGRESS_VERSION;
  readonly stage: 'walk';
  readonly route: OnboardingRouteId;
  /** The second chooser's answer. Only first-time setup has one. */
  readonly connection?: ConnectionMethodId;
  /** Where the reader is now. */
  readonly current: OnboardingStepId;
  /** The furthest step they have reached on this route, which is what stays jumpable. */
  readonly furthest: OnboardingStepId;
}

/**
 * A union rather than nullable fields.
 *
 * A `route: null` beside a `current: 'install'` is two fields that can disagree,
 * and every reader of them has to decide what a disagreement means. A closed
 * union cannot be in that state, so nothing downstream has to handle it.
 */
export type OnboardingProgress = OnboardingChoosing | OnboardingWalking;

export const FRESH_ONBOARDING_PROGRESS: OnboardingChoosing = Object.freeze({
  v: ONBOARDING_PROGRESS_VERSION,
  stage: 'choose' as const,
});

const fresh = (): OnboardingProgress => ({ ...FRESH_ONBOARDING_PROGRESS });

/** Opening a route: its first step, and nothing remembered from any other route. */
export const enterOnboardingRoute = (route: OnboardingRouteId): OnboardingWalking => ({
  v: ONBOARDING_PROGRESS_VERSION,
  stage: 'walk',
  route,
  current: firstOnboardingStep(route),
  furthest: firstOnboardingStep(route),
});

/**
 * Parse, do not validate: anything that is not exactly a version-2 document
 * whose two steps both belong to its own route, with `current` no further than
 * `furthest`, is the chooser. There is no partial recovery, because a
 * half-trusted step is indistinguishable from a made-up one.
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
  if (fields.stage === 'choose') return fresh();
  if (fields.stage !== 'walk') return fresh();
  const { route, current, furthest, connection } = fields;
  if (!isOnboardingRouteId(route)) return fresh();
  if (!isOnboardingStepId(current) || !isOnboardingStepId(furthest)) return fresh();
  if (connection !== undefined && (!isConnectionMethodId(connection) || route !== 'first-time')) return fresh();
  /* A step from another route's list is not this reader's place; it is a mismatch. */
  if (!isStepOfRoute(route, current, connection) || !isStepOfRoute(route, furthest, connection)) return fresh();
  if (onboardingStepIndex(route, current, connection) > onboardingStepIndex(route, furthest, connection))
    return fresh();
  return {
    v: ONBOARDING_PROGRESS_VERSION,
    stage: 'walk',
    route,
    ...(connection === undefined ? {} : { connection }),
    current,
    furthest,
  };
};

/**
 * Setup is only over if something is actually paired.
 *
 * Progress is a hint about where the reader was, never evidence of what they
 * achieved: the pairing registry is the authority on that. So a stored document
 * that claims the arc reached its end, read by a browser holding no daemon at
 * all, is inconsistent across the two stores — a cleared registry, a different
 * profile, a half-finished attempt — and the honest reading is the chooser. The
 * benign one would greet someone with "You are set up" beside a panel explaining
 * that nothing is paired.
 */
export const reconcileOnboardingProgress = (progress: OnboardingProgress, paired: boolean): OnboardingProgress => {
  if (paired || progress.stage === 'choose') return progress;
  return progress.current === 'done' || progress.furthest === 'done' ? fresh() : progress;
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

/**
 * Forgets where the reader was, so the next visit asks the question again.
 *
 * This is what "add another machine" needs. Every new machine is a first-time
 * setup FOR THAT MACHINE, so somebody who finished a laptop and is now standing
 * at a server must be offered the same three answers and the same instructions —
 * not dropped onto the last screen of a journey they finished for a different
 * host. A refused write is not a failure: the visit will simply resume, which is
 * the pre-existing behaviour and never wrong, only unhelpful.
 */
export const resetOnboardingProgress = (
  storage: OnboardingProgressStorage | undefined = browserOnboardingStorage(),
): void => {
  if (!storage) return;
  try {
    storage.setItem(ONBOARDING_PROGRESS_KEY, JSON.stringify(FRESH_ONBOARDING_PROGRESS));
  } catch {
    /* storage denial is an ordinary browser condition, not a setup failure */
  }
};

export interface OnboardingProgressStoreOptions {
  readonly storage?: OnboardingProgressStorage | undefined;
  /**
   * A route the ARRIVAL itself proves: a tab opened from a pairing link is on
   * the "I have a link" route whatever storage remembers, because it demonstrably
   * has one. Applied on read rather than written, so merely opening a link never
   * rewrites progress.
   */
  readonly entry?: OnboardingRouteId | undefined;
  /**
   * Whether this browser holds a pairing at the moment the store hydrates.
   *
   * Defaults to `false`, which is the fail-closed reading: a caller that cannot
   * say loses a stale "finished" rather than asserting one. Read ONCE, on
   * hydration — a daemon forgotten later, while the last stage is already on the
   * glass, is answered by that stage's own honest fallback instead of by yanking
   * the screen out from under the reader.
   */
  readonly paired?: boolean;
}

/**
 * The reader's place in first-run, shaped for `useSyncExternalStore`:
 * `snapshot()` is identity-stable between commits, and the first read hydrates.
 */
export class OnboardingProgressStore {
  readonly #storage: OnboardingProgressStorage | undefined;
  readonly #entry: OnboardingRouteId | undefined;
  readonly #paired: boolean;
  readonly #listeners = new Set<() => void>();
  #snapshot: OnboardingProgress | null = null;

  constructor(options: OnboardingProgressStoreOptions = {}) {
    this.#storage = 'storage' in options ? options.storage : browserOnboardingStorage();
    this.#entry = options.entry;
    this.#paired = options.paired ?? false;
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

  /** Answers the chooser. A route always opens on its own first step. */
  choose(route: OnboardingRouteId): OnboardingProgress {
    return this.#commit(enterOnboardingRoute(route));
  }

  /** Answers the second chooser and immediately starts that answer's real work. */
  chooseConnection(connection: ConnectionMethodId): OnboardingProgress {
    const at = this.snapshot();
    if (at.stage !== 'walk' || at.route !== 'first-time' || at.current !== 'connect') return at;
    const current = connection === 'own-relay' ? 'relay-fingerprint' : 'pair';
    return this.#commit({
      v: ONBOARDING_PROGRESS_VERSION,
      stage: 'walk',
      route: at.route,
      connection,
      current,
      furthest: current,
    });
  }

  /** Back to the question, keeping nothing: the next answer may be a different route. */
  backToChooser(): OnboardingProgress {
    return this.#commit(fresh());
  }

  /**
   * Moves the reader within their route, remembering the furthest point so the
   * jump back is reversible. A step that does not belong to the current route —
   * or any step at all while the chooser is up — is refused rather than
   * coerced: it can only be a caller bug, and inventing a place for the reader
   * to be is exactly the damaged-state-as-empty-state mistake.
   */
  goTo(step: OnboardingStepId): OnboardingProgress {
    const at = this.snapshot();
    if (at.stage !== 'walk' || !isStepOfRoute(at.route, step, at.connection)) return at;
    return this.#commit({
      v: ONBOARDING_PROGRESS_VERSION,
      stage: 'walk',
      route: at.route,
      ...(at.connection === undefined ? {} : { connection: at.connection }),
      current: step,
      furthest: furthestOnboardingStep(at.route, at.furthest, step, at.connection),
    });
  }

  #commit(next: OnboardingProgress): OnboardingProgress {
    this.#snapshot = next;
    this.#save(next);
    for (const listener of this.#listeners) listener();
    return next;
  }

  #load(): OnboardingProgress {
    const stored = reconcileOnboardingProgress(this.#read(), this.#paired);
    const entry = this.#entry;
    if (entry === undefined) return stored;
    /* Already walking the route the arrival proves? Keep the place; do not restart it. */
    if (stored.stage === 'walk' && stored.route === entry) return stored;
    return enterOnboardingRoute(entry);
  }

  #read(): OnboardingProgress {
    if (!this.#storage) return fresh();
    try {
      return parseOnboardingProgress(this.#storage.getItem(ONBOARDING_PROGRESS_KEY));
    } catch {
      return fresh();
    }
  }

  /** A refused write never blocks the reader; the tab keeps its place in memory. */
  #save(progress: OnboardingProgress): void {
    if (!this.#storage) return;
    try {
      this.#storage.setItem(ONBOARDING_PROGRESS_KEY, JSON.stringify(progress));
    } catch {
      /* storage denial is an ordinary browser condition, not a setup failure */
    }
  }
}
