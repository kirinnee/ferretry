/**
 * SOLE OWNER of the `fy-onboarding-v4` browser-storage key.
 *
 * Setup happens across two devices and a terminal: the reader leaves to run a
 * command and comes back minutes — or hours, after the tab was evicted — later.
 * Losing their place is the cheapest possible way to make this feel broken, so
 * every answer they gave AND the step they are on are a persisted preference,
 * following the versioned `fy-<thing>-v<n>` document convention
 * `lib/theme-preferences.ts` records.
 *
 * The key moved from `v1` to `v2` when the single fixed arc became three routes,
 * from `v2` to `v3` when those routes stopped being about what the reader was
 * HOLDING and became about what the DEVICE IS, and from `v3` to `v4` when the
 * device question was deleted outright. What replaced it is two questions about
 * the ARRANGEMENT — which computer runs the daemon, and who installs it — so a
 * `v3` walking document names a route without saying either. `first-time` at
 * `install` used to mean "this machine, by hand" by implication; inferring that
 * from an old document would be guessing on the reader's behalf about the one
 * thing this flow exists to establish. An older document is therefore ignored and
 * its owner is asked once. That is a lost place, not lost work: nothing on this
 * page is state the daemon does not already hold.
 *
 * THE DEVICE IS NEVER STORED. It is detected on every load, because the same
 * document can legitimately be read by two different devices — that is exactly
 * what a hand-off does — and a phone that inherited a laptop's "this computer runs
 * the daemon" would be offered an install command it cannot run. The answers are
 * decisions; the device is an observation, and observations are re-made.
 *
 * Deliberately NOT daemon-scoped: this state exists before any daemon does, and
 * it is not evidence of anything. The AUTHORITATIVE "setup is over" signal is a
 * paired connection in `DaemonConnectionStore`; progress only decides which
 * screen to resume on.
 *
 * DAMAGED STATE IS NOT PROGRESS. A malformed, wrong-version or self-inconsistent
 * document reads as the first question rather than as "everything is done": the
 * benign reading would drop someone who never installed anything onto a pairing
 * screen with nothing to pair.
 */

import type { DeviceKind } from './device-kind.ts';
import {
  type ConnectionMethodId,
  firstOnboardingStep,
  furthestOnboardingStep,
  isConnectionMethodId,
  isDaemonRouteId,
  isOnboardingDoerId,
  isOnboardingRouteId,
  isOnboardingStepId,
  isSetupTargetId,
  isStepOfRoute,
  isTargetPossible,
  type OnboardingDaemonRouteId,
  type OnboardingDoerId,
  type OnboardingJourney,
  type OnboardingPath,
  type OnboardingRouteId,
  type OnboardingStepId,
  onboardingStepIndex,
  presumedTarget,
  questionBehindDoer,
  questionBehindRoute,
  type SetupTargetId,
} from './onboarding-model.ts';
import { landSetupHandoff, type SetupHandoff } from './setup-handoff.ts';

export const ONBOARDING_PROGRESS_KEY = 'fy-onboarding-v4';
export const ONBOARDING_PROGRESS_VERSION = 4;

/** The ENTRY question is on the glass: nothing has been answered at all. */
export interface OnboardingAsking {
  readonly v: typeof ONBOARDING_PROGRESS_VERSION;
  readonly stage: 'entry';
}

/** WHICH COMPUTER runs the daemon — asked only when this device does not settle it. */
export interface OnboardingTargeting {
  readonly v: typeof ONBOARDING_PROGRESS_VERSION;
  readonly stage: 'target';
  readonly route: OnboardingDaemonRouteId;
}

/** WHO INSTALLS IT — asked on every daemon journey, with the machine already known. */
export interface OnboardingChoosingDoer {
  readonly v: typeof ONBOARDING_PROGRESS_VERSION;
  readonly stage: 'doer';
  readonly route: OnboardingDaemonRouteId;
  readonly target: SetupTargetId;
}

/**
 * A journey is being walked, and only steps belonging to THAT journey can be here.
 *
 * The journey is spread in rather than nested so the stored document stays flat,
 * and it is a union rather than three optional fields so the pairing entry cannot
 * be caught holding a carrier answer it was never asked for.
 */
export type OnboardingWalking = {
  readonly v: typeof ONBOARDING_PROGRESS_VERSION;
  readonly stage: 'walk';
  /** Where the reader is now. */
  readonly current: OnboardingStepId;
  /** The furthest step they have reached on this journey, which is what stays jumpable. */
  readonly furthest: OnboardingStepId;
} & OnboardingJourney;

/**
 * A union rather than nullable fields.
 *
 * A `route: null` beside a `current: 'install'` is two fields that can disagree,
 * and every reader of them has to decide what a disagreement means. A closed
 * union cannot be in that state, so nothing downstream has to handle it.
 */
export type OnboardingProgress = OnboardingAsking | OnboardingTargeting | OnboardingChoosingDoer | OnboardingWalking;

export const FRESH_ONBOARDING_PROGRESS: OnboardingAsking = Object.freeze({
  v: ONBOARDING_PROGRESS_VERSION,
  stage: 'entry' as const,
});

const fresh = (): OnboardingProgress => ({ ...FRESH_ONBOARDING_PROGRESS });

/** The target question, for an entry that this device does not answer by itself. */
export const targetQuestion = (route: OnboardingDaemonRouteId): OnboardingTargeting => ({
  v: ONBOARDING_PROGRESS_VERSION,
  stage: 'target',
  route,
});

/** The doer question, which every daemon journey reaches with its machine settled. */
export const doerQuestion = (route: OnboardingDaemonRouteId, target: SetupTargetId): OnboardingChoosingDoer => ({
  v: ONBOARDING_PROGRESS_VERSION,
  stage: 'doer',
  route,
  target,
});

/**
 * WHERE ANSWERING THE ENTRY QUESTION LANDS, which is not always a journey.
 *
 * The pairing entry has nothing left to ask, so it opens its steps immediately. A
 * daemon entry asks who installs it always, and asks which computer first only
 * when this device has not already settled that — a phone never can, and a
 * computer setting up for the first time is assumed to mean itself.
 */
export const enterOnboardingRoute = (route: OnboardingRouteId, device: DeviceKind): OnboardingProgress => {
  if (!isDaemonRouteId(route)) return walk({ route }, device);
  const target = presumedTarget(route, device);
  return target === undefined ? targetQuestion(route) : doerQuestion(route, target);
};

/** Opening a journey on its own first step, with nothing remembered from any other. */
export const walk = (journey: OnboardingJourney, device: DeviceKind): OnboardingWalking => {
  const first = firstOnboardingStep({ ...journey, device });
  return { v: ONBOARDING_PROGRESS_VERSION, stage: 'walk', ...journey, current: first, furthest: first };
};

/** Opening a journey AT A KNOWN PLACE, which is what a hand-off link asks for. */
export const resumeOnboardingRoute = (handoff: SetupHandoff, device: DeviceKind): OnboardingProgress => {
  const landing = landSetupHandoff(handoff, device);
  if (landing.kind === 'ask') {
    return landing.question === 'target'
      ? targetQuestion(landing.route)
      : /* The `doer` landing always carries the target it settled; the type says so. */
        doerQuestion(landing.route, landing.target ?? 'other');
  }
  return {
    v: ONBOARDING_PROGRESS_VERSION,
    stage: 'walk',
    ...landing.journey,
    current: landing.step,
    furthest: landing.step,
  };
};

/**
 * Parse, do not validate: anything that is not exactly a version-4 document whose
 * answers are possible ON THIS DEVICE and whose two steps both belong to its own
 * journey, with `current` no further than `furthest`, is the first question. There
 * is no partial recovery, because a half-trusted step is indistinguishable from a
 * made-up one.
 *
 * The device is an argument because it changes the answer twice over. A stored
 * "this computer runs the daemon" read on a phone is not a place, it is an
 * impossibility — and a laptop's stored `install` names a step a phone's journey
 * does not have. Refusing there is not pedantry: it is the difference between
 * resuming and dropping somebody onto a screen full of commands they have nowhere
 * to type.
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
  if (fields.stage === 'entry') return fresh();
  if (fields.stage === 'target') return parseQuestion(fields, device);
  if (fields.stage === 'doer') return parseQuestion(fields, device);
  if (fields.stage !== 'walk') return fresh();
  return parseWalk(fields, device);
};

/** A stored question, which is only a place if this device would ask it at all. */
const parseQuestion = (fields: Record<string, unknown>, device: DeviceKind): OnboardingProgress => {
  const { route, target } = fields;
  if (!isOnboardingRouteId(route) || !isDaemonRouteId(route)) return fresh();
  if (fields.stage === 'target') {
    /* A device that settles the target itself would never have shown this screen. */
    return presumedTarget(route, device) === undefined ? targetQuestion(route) : enterOnboardingRoute(route, device);
  }
  if (!isSetupTargetId(target) || !isTargetPossible(target, device)) return fresh();
  return doerQuestion(route, target);
};

/** A stored journey, refused unless every answer on it is one this device could hold. */
const parseWalk = (fields: Record<string, unknown>, device: DeviceKind): OnboardingProgress => {
  const { route, current, furthest, target, doer, connection } = fields;
  if (!isOnboardingRouteId(route)) return fresh();
  if (!isOnboardingStepId(current) || !isOnboardingStepId(furthest)) return fresh();
  const journey = parseJourney(route, device, target, doer, connection);
  if (journey === undefined) return fresh();
  const path: OnboardingPath = { ...journey, device };
  /* A step from another journey's list is not this reader's place; it is a mismatch. */
  if (!isStepOfRoute(path, current) || !isStepOfRoute(path, furthest)) return fresh();
  if (onboardingStepIndex(path, current) > onboardingStepIndex(path, furthest)) return fresh();
  return { v: ONBOARDING_PROGRESS_VERSION, stage: 'walk', ...journey, current, furthest };
};

/** The stored answers as a journey, or nothing when they do not make one. */
const parseJourney = (
  route: OnboardingRouteId,
  device: DeviceKind,
  target: unknown,
  doer: unknown,
  connection: unknown,
): OnboardingJourney | undefined => {
  if (!isDaemonRouteId(route)) {
    /* The pairing entry answers neither question, so a document holding one is not this. */
    return target === undefined && doer === undefined && connection === undefined ? { route } : undefined;
  }
  if (!isSetupTargetId(target) || !isTargetPossible(target, device)) return undefined;
  if (!isOnboardingDoerId(doer)) return undefined;
  /* Only a daemon standing up on THIS machine is ever asked which carrier to use. */
  if (connection !== undefined && (!isConnectionMethodId(connection) || target !== 'this' || doer !== 'self')) {
    return undefined;
  }
  return {
    route,
    target,
    doer,
    ...(connection === undefined ? {} : { connection: connection as ConnectionMethodId }),
  };
};

/**
 * Setup is only over if something is actually paired.
 *
 * Progress is a hint about where the reader was, never evidence of what they
 * achieved: the pairing registry is the authority on that. So a stored document
 * that claims the arc reached its end, read by a browser holding no daemon at
 * all, is inconsistent across the two stores — a cleared registry, a different
 * profile, a half-finished attempt — and the honest reading is the first question.
 * The benign one would greet somebody with "You are set up" beside a panel
 * explaining that nothing is paired.
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
 * at a server must be offered the same entries and the same instructions — not
 * dropped onto the last screen of a journey they finished for a different host. A
 * refused write is not a failure: the visit will simply resume, which is the
 * pre-existing behaviour and never wrong, only unhelpful.
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
   * caller that cannot say should not be the one that hides the daemon journey
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

  /** The journey being walked, with the device folded in — what every model helper wants. */
  path(at: OnboardingWalking): OnboardingPath {
    return at.route === 'add-client'
      ? { route: 'add-client', device: this.#device }
      : {
          route: at.route,
          target: at.target,
          doer: at.doer,
          ...(at.connection === undefined ? {} : { connection: at.connection }),
          device: this.#device,
        };
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

  /** Answers the entry question, which opens whichever question that entry still needs. */
  choose(route: OnboardingRouteId): OnboardingProgress {
    return this.#commit(enterOnboardingRoute(route, this.#device));
  }

  /**
   * Answers WHICH COMPUTER, whether it was asked or merely assumed.
   *
   * The escape from the assumption comes through here too, from a step rather
   * than from the question — so it accepts a route as well, and a target this
   * device cannot hold is refused rather than stored.
   */
  chooseTarget(target: SetupTargetId, route?: OnboardingDaemonRouteId): OnboardingProgress {
    const at = this.snapshot();
    const on = route ?? routeOf(at);
    if (on === undefined || !isTargetPossible(target, this.#device)) return at;
    return this.#commit(doerQuestion(on, target));
  }

  /** Answers WHO INSTALLS IT, which is the last thing any daemon journey needs. */
  chooseDoer(doer: OnboardingDoerId): OnboardingProgress {
    const at = this.snapshot();
    if (at.stage !== 'doer') return at;
    return this.#commit(walk({ route: at.route, target: at.target, doer }, this.#device));
  }

  /**
   * CHANGES THE ANSWER FROM INSIDE THE JOURNEY, which is a different act from
   * answering the question.
   *
   * A reader looking at commands they did not want should not have to find their
   * way back to a question and re-answer it. The carrier choice does not survive:
   * an agent is not asked it, so keeping it would leave a stored answer that the
   * new journey never collects and `parseJourney` would refuse on the next load.
   */
  switchDoer(doer: OnboardingDoerId): OnboardingProgress {
    const at = this.snapshot();
    if (at.stage !== 'walk' || at.route === 'add-client') return at;
    return this.#commit(walk({ route: at.route, target: at.target, doer }, this.#device));
  }

  /** Answers the carrier chooser and immediately starts that answer's real work. */
  chooseConnection(connection: ConnectionMethodId): OnboardingProgress {
    const at = this.snapshot();
    if (at.stage !== 'walk' || at.current !== 'connect' || at.route === 'add-client') return at;
    const current = connection === 'own-relay' ? 'relay-fingerprint' : 'local';
    return this.#commit({
      v: ONBOARDING_PROGRESS_VERSION,
      stage: 'walk',
      route: at.route,
      target: at.target,
      doer: at.doer,
      connection,
      current,
      furthest: current,
    });
  }

  /**
   * Back out of a journey, to WHICHEVER QUESTION OPENED IT.
   *
   * Keeping the answers behind that question, because they are still true: a
   * reader backing out of the install steps is changing who installs it, not
   * which computer. Landing on the question they actually answered is what keeps
   * two questions from feeling like a maze.
   */
  leaveRoute(): OnboardingProgress {
    const at = this.snapshot();
    if (at.stage !== 'walk') return at;
    if (questionBehindRoute(at.route) === 'entry' || at.route === 'add-client') return this.#commit(fresh());
    return this.#commit(doerQuestion(at.route, at.target));
  }

  /** Back from a question to the one before it, which depends on what was asked. */
  back(): OnboardingProgress {
    const at = this.snapshot();
    if (at.stage === 'target') return this.#commit(fresh());
    if (at.stage !== 'doer') return at;
    return this.#commit(questionBehindDoer(at.route, this.#device) === 'target' ? targetQuestion(at.route) : fresh());
  }

  /**
   * Moves the reader within their journey, remembering the furthest point so the
   * jump back is reversible. A step that does not belong to the current journey —
   * or any step at all while a question is up — is refused rather than coerced:
   * it can only be a caller bug, and inventing a place for the reader to be is
   * exactly the damaged-state-as-empty-state mistake.
   */
  goTo(step: OnboardingStepId): OnboardingProgress {
    const at = this.snapshot();
    if (at.stage !== 'walk') return at;
    const path = this.path(at);
    if (!isStepOfRoute(path, step)) return at;
    return this.#commit({
      ...at,
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
    /* Already walking the journey the arrival proves? Keep the place; do not restart it. */
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

/** The daemon entry a state belongs to, when it belongs to one at all. */
const routeOf = (at: OnboardingProgress): OnboardingDaemonRouteId | undefined => {
  if (at.stage === 'entry') return undefined;
  return at.route === 'add-client' ? undefined : at.route;
};
