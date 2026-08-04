/**
 * Resuming setup, and refusing to invent progress that was never made.
 *
 * The failure this suite exists to prevent is the benign one: reading damaged
 * storage as "they finished" and dropping someone who installed nothing onto a
 * pairing screen with nothing to pair.
 *
 * With three routes there is a second shape of the same failure — a step from
 * ANOTHER route's list, which describes a place this reader's journey does not
 * have. That is damage too, and it is read as the chooser rather than repaired.
 */

import { describe, expect, it } from 'bun:test';

import {
  browserOnboardingStorage,
  enterOnboardingRoute,
  FRESH_ONBOARDING_PROGRESS,
  ONBOARDING_PROGRESS_KEY,
  ONBOARDING_PROGRESS_VERSION,
  type OnboardingProgressStorage,
  OnboardingProgressStore,
  parseOnboardingProgress,
  reconcileOnboardingProgress,
  resetOnboardingProgress,
} from '../../../src/features/onboarding/onboarding-progress.ts';

const stored = (value: unknown): string => JSON.stringify(value);

/** A version-2 walking document, spelled out so the tests read as documents. */
const walking = (route: string, current: string, furthest = current): string =>
  stored({ v: ONBOARDING_PROGRESS_VERSION, stage: 'walk', route, current, furthest });

class MemoryStorage implements OnboardingProgressStorage {
  readonly writes: string[] = [];
  constructor(private value: string | null = null) {}
  getItem(): string | null {
    return this.value;
  }
  setItem(_key: string, next: string): void {
    this.value = next;
    this.writes.push(next);
  }
}

class HostileStorage implements OnboardingProgressStorage {
  getItem(): string | null {
    throw new Error('storage is denied in this context');
  }
  setItem(): void {
    throw new Error('storage is denied in this context');
  }
}

describe('parseOnboardingProgress', () => {
  it('reads a well-formed document back exactly', () => {
    expect(parseOnboardingProgress(walking('first-time', 'daemon', 'pair'))).toEqual({
      v: 2,
      stage: 'walk',
      route: 'first-time',
      current: 'daemon',
      furthest: 'pair',
    });
  });

  it('starts at the question on anything it cannot fully trust', () => {
    const damaged = [
      null,
      undefined,
      '',
      'not json at all',
      stored(null),
      stored([{ v: 2, stage: 'walk', route: 'first-time', current: 'pair', furthest: 'pair' }]),
      stored('done'),
      // Version 1 described a single fixed arc; there is no honest mapping.
      stored({ v: 1, current: 'pair', furthest: 'done' }),
      stored({ v: 3, stage: 'walk', route: 'first-time', current: 'pair', furthest: 'done' }),
      // A stage this store does not ship, and the chooser itself.
      stored({ v: 2, stage: 'browse' }),
      stored({ v: 2, stage: 'choose' }),
      // Unknown route, unknown steps, missing fields.
      walking('stepper', 'install'),
      walking('first-time', 'billing', 'done'),
      stored({ v: 2, stage: 'walk', route: 'first-time', current: 'install', furthest: 7 }),
      stored({ v: 2, stage: 'walk', route: 'first-time', current: 'install' }),
      // A step from another route's list: not this reader's place, a mismatch.
      walking('have-link', 'install'),
      walking('agent', 'connect', 'done'),
      // Self-inconsistent: further along than the furthest point ever reached.
      walking('first-time', 'done', 'daemon'),
    ];
    for (const raw of damaged) {
      expect(parseOnboardingProgress(raw)).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    }
  });
});

describe('enterOnboardingRoute', () => {
  it('opens a route on its own first step and remembers nothing else', () => {
    expect(enterOnboardingRoute('agent')).toEqual({
      v: 2,
      stage: 'walk',
      route: 'agent',
      current: 'brief',
      furthest: 'brief',
    });
  });
});

describe('OnboardingProgressStore', () => {
  it('hydrates once, publishes moves, and remembers the furthest point', () => {
    const storage = new MemoryStorage(walking('first-time', 'daemon'));
    const store = new OnboardingProgressStore({ storage });
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.snapshot().stage));

    expect(store.snapshot()).toEqual({
      v: 2,
      stage: 'walk',
      route: 'first-time',
      current: 'daemon',
      furthest: 'daemon',
    });
    // Identity-stable between commits, so React does not re-render on a read.
    expect(store.snapshot()).toBe(store.snapshot());

    store.goTo('pair');
    expect(store.snapshot()).toEqual({
      v: 2,
      stage: 'walk',
      route: 'first-time',
      current: 'pair',
      furthest: 'pair',
    });
    store.goTo('install');
    // Stepping back does NOT erase where they got to.
    expect(store.snapshot()).toEqual({
      v: 2,
      stage: 'walk',
      route: 'first-time',
      current: 'install',
      furthest: 'pair',
    });
    expect(seen).toEqual(['walk', 'walk']);
    expect(JSON.parse(storage.writes[storage.writes.length - 1] ?? '{}')).toEqual({
      v: 2,
      stage: 'walk',
      route: 'first-time',
      current: 'install',
      furthest: 'pair',
    });

    unsubscribe();
    store.goTo('done');
    expect(seen).toEqual(['walk', 'walk']);
  });

  it('answers the question, and lets the reader take the answer back', () => {
    const storage = new MemoryStorage();
    const store = new OnboardingProgressStore({ storage });
    expect(store.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });

    store.choose('agent');
    expect(store.snapshot()).toEqual(enterOnboardingRoute('agent'));

    // Picking the wrong answer has to be survivable: back out and pick again.
    store.backToChooser();
    expect(store.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    store.choose('have-link');
    expect(store.snapshot()).toEqual(enterOnboardingRoute('have-link'));
  });

  it('refuses a step that is not on this route, rather than inventing a place', () => {
    const store = new OnboardingProgressStore({ storage: undefined });
    // The chooser is up: no route, so there is no step to be on.
    expect(store.goTo('install')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });

    store.choose('have-link');
    // `install` belongs to the first-time route only; this route never has it.
    expect(store.goTo('install')).toEqual(enterOnboardingRoute('have-link'));
    expect(store.goTo('done')).toEqual({
      v: 2,
      stage: 'walk',
      route: 'have-link',
      current: 'done',
      furthest: 'done',
    });
  });

  it('survives a reload by rehydrating from the same key', () => {
    const storage = new MemoryStorage();
    const first = new OnboardingProgressStore({ storage });
    first.choose('first-time');
    first.goTo('daemon');
    // A new tab, hours later, with only storage between them.
    expect(new OnboardingProgressStore({ storage }).snapshot()).toEqual({
      v: 2,
      stage: 'walk',
      route: 'first-time',
      current: 'daemon',
      furthest: 'daemon',
    });
    expect(ONBOARDING_PROGRESS_KEY).toBe('fy-onboarding-v2');
  });

  it('lets an arrival answer the question without rewriting their history', () => {
    const storage = new MemoryStorage(walking('first-time', 'install'));
    const store = new OnboardingProgressStore({ storage, entry: 'have-link' });

    // A tab opened from a pairing link IS the reader holding a link, whatever
    // storage remembers…
    expect(store.snapshot()).toEqual(enterOnboardingRoute('have-link'));
    // …and merely opening the link wrote nothing.
    expect(storage.writes).toEqual([]);
  });

  it('does not restart a route the arrival is already inside', () => {
    // Second visit from the same link, already past the scan: the arrival must
    // not throw them back to the start of the route they are walking.
    const storage = new MemoryStorage(walking('have-link', 'done'));
    const store = new OnboardingProgressStore({ storage, entry: 'have-link', paired: true });
    expect(store.snapshot()).toEqual({
      v: 2,
      stage: 'walk',
      route: 'have-link',
      current: 'done',
      furthest: 'done',
    });
  });

  it('keeps working when storage is absent or refuses', () => {
    const withoutStorage = new OnboardingProgressStore({ storage: undefined });
    expect(withoutStorage.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    withoutStorage.choose('first-time');
    expect(withoutStorage.snapshot().stage).toBe('walk');

    const hostile = new OnboardingProgressStore({ storage: new HostileStorage() });
    expect(hostile.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // A refused write is an ordinary browser condition, not a setup failure.
    expect(hostile.choose('first-time')).toEqual(enterOnboardingRoute('first-time'));
  });

  it('defaults to the browser store, and accepts a browser that has none', () => {
    expect(browserOnboardingStorage()).toBe(globalThis.localStorage as unknown as OnboardingProgressStorage);
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: 'not a function' } });
    try {
      expect(browserOnboardingStorage()).toBeUndefined();
      // The default path, exercised: no storage seam passed at all.
      expect(new OnboardingProgressStore().snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
      // And the reset falls back to the same absent default without throwing.
      resetOnboardingProgress();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'localStorage');
    }
  });
});

describe('resetOnboardingProgress', () => {
  it('sends the next visit back to the question', () => {
    // "Set up another machine": every new machine is a first-time setup for that
    // machine, so the finished journey of a different host must not be resumed.
    const storage = new MemoryStorage(walking('first-time', 'done'));
    resetOnboardingProgress(storage);
    expect(JSON.parse(storage.writes[0] ?? '{}')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    expect(new OnboardingProgressStore({ storage, paired: true }).snapshot()).toEqual({
      ...FRESH_ONBOARDING_PROGRESS,
    });
  });

  it('is a no-op when there is nowhere to write, and never throws', () => {
    resetOnboardingProgress(undefined);
    resetOnboardingProgress(new HostileStorage());
  });
});

describe('reconcileOnboardingProgress', () => {
  it('refuses to call setup finished for a browser that is paired with nothing', () => {
    const storage = new MemoryStorage(walking('first-time', 'done'));

    // Cross-store inconsistency: progress says finished, the pairing registry —
    // which is the authority — holds nothing. The question again, not congratulations.
    expect(new OnboardingProgressStore({ storage, paired: false }).snapshot()).toEqual({
      ...FRESH_ONBOARDING_PROGRESS,
    });
    // Absent evidence is the same answer: the default is fail-closed.
    expect(new OnboardingProgressStore({ storage }).snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // With a pairing, the stored place is exactly what it says.
    expect(new OnboardingProgressStore({ storage, paired: true }).snapshot()).toEqual({
      v: 2,
      stage: 'walk',
      route: 'first-time',
      current: 'done',
      furthest: 'done',
    });
  });

  it('leaves every unfinished document alone, paired or not', () => {
    const midway = { v: 2, stage: 'walk', route: 'first-time', current: 'daemon', furthest: 'pair' } as const;
    expect(reconcileOnboardingProgress(midway, false)).toBe(midway);
    expect(reconcileOnboardingProgress(midway, true)).toBe(midway);
    // Having once reached the end is also unbelievable without a pairing.
    expect(
      reconcileOnboardingProgress(
        { v: 2, stage: 'walk', route: 'first-time', current: 'install', furthest: 'done' },
        false,
      ),
    ).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // The chooser has nothing to reconcile and is passed straight back.
    expect(reconcileOnboardingProgress(FRESH_ONBOARDING_PROGRESS, false)).toBe(FRESH_ONBOARDING_PROGRESS);
  });
});
