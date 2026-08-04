/**
 * SOLE OWNER of the `fy-onboarding-v3` browser-storage key.
 *
 * Setup happens across two devices and a terminal: the reader leaves to run a
 * command and comes back minutes — or hours, after the tab was evicted — later.
 * Losing their place is the cheapest possible way to make this feel broken, so
 * both the ROUTE they chose and the step they are on are a persisted preference,
 * following the versioned `fy-<thing>-v<n>` document convention
 * `lib/theme-preferences.ts` records.
 *
 * The key moved from `v1` to `v2` when the single fixed arc became three routes,
 * and from `v2` to `v3` when those three routes stopped being about what the
 * reader was HOLDING and became about what the DEVICE IS. `have-link` and the old
 * `agent` no longer named anything, and a stored place inside one of them
 * describes a journey that is gone — so an older document is ignored, and its
 * owner is asked the question once. That is a lost place, not lost work: nothing
 * on this page is state the daemon does not already hold.
 *
 * IT DID NOT MOVE AGAIN when "who does the work" became the first question, and
 * that is deliberate rather than an omission. Every place a `v3` document can
 * name still exists and still means the same thing — `first-time` at `install` is
 * the same screen it was — so a reader mid-install keeps their place across the
 * change. The only `v3` state with no successor is the device question itself,
 * which is now one question in rather than the first, and it survives as exactly
 * that: `stage: 'choose'` still resumes on the device question, with the first
 * question one Back away.
 *
 * THE DEVICE IS NEVER STORED. It is detected on every load, because the same
 * document can legitimately be read by two different devices — that is exactly
 * what a hand-off does — and a phone that inherited a laptop's "this is a
 * desktop" would be offered an install command it cannot run. The route is a
 * decision; the device is an observation, and observations are re-made.
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

import type { DeviceKind } from './device-kind.ts';
import {
  type ConnectionMethodId,
  doerRoute,
  firstOnboardingStep,
  furthestOnboardingStep,
  isConnectionMethodId,
  isOnboardingRouteId,
  isOnboardingStepId,
  isStepOfRoute,
  type OnboardingDoerId,
  type OnboardingPath,
  type OnboardingRouteId,
  type OnboardingStepId,
  onboardingStepIndex,
  questionBehindRoute,
} from './onboarding-model.ts';
import { landSetupHandoff, type SetupHandoff } from './setup-handoff.ts';

export const ONBOARDING_PROGRESS_KEY = 'fy-onboarding-v3';
export const ONBOARDING_PROGRESS_VERSION = 3;

/** The FIRST question is on the glass: no doer, no route, no step. */
export interface OnboardingAsking {
  readonly v: typeof ONBOARDING_PROGRESS_VERSION;
  readonly stage: 'who';
}

/** The device question is on the glass: an answer to the first one, but no route yet. */
export interface OnboardingChoosing {
  readonly v: typeof ONBOARDING_PROGRESS_VERSION;
  readonly stage: 'choose';
}

/** A route is being walked, and only steps belonging to THAT route can be here. */
export interface OnboardingWalking {
  readonly v: typeof ONBOARDING_PROGRESS_VERSION;
  readonly stage: 'walk';
  readonly route: OnboardingRouteId;
  /** The connection chooser's answer. Only the daemon-bearing routes ask it. */
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
export type OnboardingProgress = OnboardingAsking | OnboardingChoosing | OnboardingWalking;

export const FRESH_ONBOARDING_PROGRESS: OnboardingAsking = Object.freeze({
  v: ONBOARDING_PROGRESS_VERSION,
  stage: 'who' as const,
});

/** The second question, once the first one has been answered with "I do it myself". */
export const DEVICE_QUESTION_PROGRESS: OnboardingChoosing = Object.freeze({
  v: ONBOARDING_PROGRESS_VERSION,
  stage: 'choose' as const,
});

const fresh = (): OnboardingProgress => ({ ...FRESH_ONBOARDING_PROGRESS });

const deviceQuestion = (): OnboardingProgress => ({ ...DEVICE_QUESTION_PROGRESS });

/** Opening a route: its first step, and nothing remembered from any other route. */
export const enterOnboardingRoute = (route: OnboardingRouteId, device: DeviceKind): OnboardingWalking => {
  const first = firstOnboardingStep({ route, device });
  return { v: ONBOARDING_PROGRESS_VERSION, stage: 'walk', route, current: first, furthest: first };
};

/** Opening a route AT A KNOWN PLACE, which is what a hand-off link asks for. */
export const resumeOnboardingRoute = (handoff: SetupHandoff, device: DeviceKind): OnboardingWalking => {
  const landed = landSetupHandoff(handoff, device);
  return {
    v: ONBOARDING_PROGRESS_VERSION,
    stage: 'walk',
    route: handoff.route,
    ...(landed.path.connection === undefined ? {} : { connection: landed.path.connection }),
    current: landed.step,
    furthest: landed.step,
  };
};

/**
 * Parse, do not validate: anything that is not exactly a version-3 document
 * whose two steps both belong to its own route ON THIS DEVICE, with `current` no
 * further than `furthest`, is the chooser. There is no partial recovery, because
 * a half-trusted step is indistinguishable from a made-up one.
 *
 * The device is an argument because it changes the answer: a laptop's stored
 * `install` is a real place, and the same document read on a phone names a step
 * that phone's route does not have. Refusing there is not pedantry — it is the
 * difference between resuming and dropping somebody onto a screen full of
 * commands they have nowhere to type.
 */
export const parseOnboardingProgress = (raw: string | null | undefined, device: DeviceKind): OnboardingProgress => {
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
  if (fields.stage === 'who') return fresh();
  /* A reader who answered "I do it myself" and got as far as the device question is AT it. */
  if (fields.stage === 'choose') return deviceQuestion();
  if (fields.stage !== 'walk') return fresh();
  const { route, current, furthest, connection } = fields;
  if (!isOnboardingRouteId(route)) return fresh();
  if (!isOnboardingStepId(current) || !isOnboardingStepId(furthest)) return fresh();
  /* `add-client` never asks the connection question, so a stored answer for it is not this document. */
  if (connection !== undefined && (!isConnectionMethodId(connection) || route === 'add-client')) return fresh();
  const path: OnboardingPath = { route, device, connection };
  /* A step from another route's list is not this reader's place; it is a mismatch. */
  if (!isStepOfRoute(path, current) || !isStepOfRoute(path, furthest)) return fresh();
  if (onboardingStepIndex(path, current) > onboardingStepIndex(path, furthest)) return fresh();
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
  if (paired || progress.stage !== 'walk') return progress;
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
   * What this device is, decided by observation and never by storage.
   *
   * Defaults to `desktop` for the same reason `detectDeviceKind` does: the
   * caller that cannot say should not be the one that hides the daemon route
   * from the only kind of machine that can host one.
   */
  readonly device?: DeviceKind;
  /**
   * The place an ARRIVAL itself proves.
   *
   * A tab opened from a live pairing code is demonstrably a client being added,
   * whatever storage remembers — and it is past the step that says to go and run
   * `fy pair`, because somebody already did. So the arrival names a STEP as well
   * as a route; landing a reader holding a two-minute code on an instruction to
   * produce one is the same mistake as asking them which of three they are.
   *
   * Applied on read rather than written, so merely opening a link never rewrites
   * progress.
   */
  readonly entry?: SetupHandoff | undefined;
  /**
   * A place another device handed to this one.
   *
   * Beats `entry` and beats storage, because it is the most recent deliberate
   * act by a human: somebody stood at one device, pressed hand-off, and walked
   * to this one. It is applied on read for the same reason as `entry` — landing
   * here must not overwrite a place this device might still want.
   */
  readonly handoff?: SetupHandoff | undefined;
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
  readonly #entry: SetupHandoff | undefined;
  readonly #handoff: SetupHandoff | undefined;
  readonly #paired: boolean;
  readonly #device: DeviceKind;
  readonly #listeners = new Set<() => void>();
  #snapshot: OnboardingProgress | null = null;

  constructor(options: OnboardingProgressStoreOptions = {}) {
    this.#storage = 'storage' in options ? options.storage : browserOnboardingStorage();
    this.#entry = options.entry;
    this.#handoff = options.handoff;
    this.#paired = options.paired ?? false;
    this.#device = options.device ?? 'desktop';
  }

  /** What this device is, so every screen derives its path from one observation. */
  get device(): DeviceKind {
    return this.#device;
  }

  /** The route being walked, with the device folded in — the argument every model helper wants. */
  path(at: OnboardingWalking): OnboardingPath {
    return { route: at.route, device: this.#device, connection: at.connection };
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

  /**
   * Answers the FIRST question: who is doing this.
   *
   * "An agent does it" opens a route immediately, because there is nothing left
   * to ask — the agent is on the machine that becomes the daemon, so this browser
   * is the client and the device question has no work to do. "I do it myself"
   * opens that question instead.
   */
  chooseDoer(doer: OnboardingDoerId): OnboardingProgress {
    const route = doerRoute(doer);
    return this.#commit(route === undefined ? deviceQuestion() : enterOnboardingRoute(route, this.#device));
  }

  /** Answers the device question. A route always opens on its own first step. */
  choose(route: OnboardingRouteId): OnboardingProgress {
    return this.#commit(enterOnboardingRoute(route, this.#device));
  }

  /** Answers the second chooser and immediately starts that answer's real work. */
  chooseConnection(connection: ConnectionMethodId): OnboardingProgress {
    const at = this.snapshot();
    if (at.stage !== 'walk' || at.current !== 'connect') return at;
    const current = connection === 'own-relay' ? 'relay-fingerprint' : 'local';
    return this.#commit({
      v: ONBOARDING_PROGRESS_VERSION,
      stage: 'walk',
      route: at.route,
      connection,
      current,
      furthest: current,
    });
  }

  /**
   * Back out of a route, to WHICHEVER QUESTION OPENED IT.
   *
   * Keeping nothing, because the next answer may be a different route — and
   * landing on the question the reader actually answered, because the agent route
   * was opened one question earlier than the three device ones. Sending somebody
   * back to a question they never saw is how two questions start feeling like a
   * maze; sending them forward past the one they did answer hides their mistake.
   */
  leaveRoute(): OnboardingProgress {
    const at = this.snapshot();
    if (at.stage !== 'walk') return at;
    return this.#commit(questionBehindRoute(at.route) === 'who' ? fresh() : deviceQuestion());
  }

  /** Back from the device question to the first one. */
  backToWho(): OnboardingProgress {
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
    if (at.stage !== 'walk') return at;
    const path = this.path(at);
    if (!isStepOfRoute(path, step)) return at;
    return this.#commit({
      v: ONBOARDING_PROGRESS_VERSION,
      stage: 'walk',
      route: at.route,
      ...(at.connection === undefined ? {} : { connection: at.connection }),
      current: step,
      furthest: furthestOnboardingStep(path, at.furthest, step),
    });
  }

  #commit(next: OnboardingProgress): OnboardingProgress {
    this.#snapshot = next;
    this.#save(next);
    for (const listener of this.#listeners) listener();
    return next;
  }

  /**
   * Where this visit opens, in order of how much a human meant it.
   *
   * A HAND-OFF WINS. Somebody stood at another device, pressed a button that
   * says "continue on this one", and carried it here; nothing in storage is more
   * recent than that. An ARRIVAL comes next: a tab opened from a live pairing
   * code is a client being added, whatever it remembers. Storage is last, and is
   * only ever a memory of where somebody was.
   */
  #load(): OnboardingProgress {
    const stored = reconcileOnboardingProgress(this.#read(), this.#paired);
    const handoff = this.#handoff;
    if (handoff !== undefined) return resumeOnboardingRoute(handoff, this.#device);
    const entry = this.#entry;
    if (entry === undefined) return stored;
    /* Already walking the route the arrival proves? Keep the place; do not restart it. */
    if (stored.stage === 'walk' && stored.route === entry.route) return stored;
    return resumeOnboardingRoute(entry, this.#device);
  }

  #read(): OnboardingProgress {
    if (!this.#storage) return fresh();
    try {
      return parseOnboardingProgress(this.#storage.getItem(ONBOARDING_PROGRESS_KEY), this.#device);
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
