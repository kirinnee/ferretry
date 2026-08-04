/**
 * Resuming setup, and refusing to invent progress that was never made.
 *
 * The failure this suite exists to prevent is the benign one: reading damaged
 * storage as "they finished" and dropping someone who installed nothing onto a
 * pairing screen with nothing to pair.
 *
 * There are now two more shapes of the same failure. A step from ANOTHER route's
 * list describes a place this reader's journey does not have. And a step from the
 * SAME route on a DIFFERENT DEVICE describes a place this reader's hardware
 * cannot act on — a laptop's stored `install`, read on a phone, is a screen of
 * commands with nowhere to type them. Both are damage, and both read as the
 * chooser rather than being repaired.
 */

import { describe, expect, it } from 'bun:test';

import type { DeviceKind } from '../../../src/features/onboarding/device-kind.ts';
import {
  browserOnboardingStorage,
  DEVICE_QUESTION_PROGRESS,
  enterOnboardingRoute,
  FRESH_ONBOARDING_PROGRESS,
  ONBOARDING_PROGRESS_KEY,
  ONBOARDING_PROGRESS_VERSION,
  type OnboardingProgressStorage,
  OnboardingProgressStore,
  parseOnboardingProgress,
  reconcileOnboardingProgress,
  resetOnboardingProgress,
  resumeOnboardingRoute,
} from '../../../src/features/onboarding/onboarding-progress.ts';

const stored = (value: unknown): string => JSON.stringify(value);

/** A version-3 walking document, spelled out so the tests read as documents. */
const walking = (route: string, current: string, furthest = current): string =>
  stored({ v: ONBOARDING_PROGRESS_VERSION, stage: 'walk', route, current, furthest });

/** Every store in this suite states its device, because the device changes the answer. */
const onDevice = (
  device: DeviceKind,
  options: ConstructorParameters<typeof OnboardingProgressStore>[0] = {},
): OnboardingProgressStore => new OnboardingProgressStore({ device, ...options });

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
    expect(parseOnboardingProgress(walking('first-time', 'daemon', 'local'), 'desktop')).toEqual({
      v: 3,
      stage: 'walk',
      route: 'first-time',
      current: 'daemon',
      furthest: 'local',
    });
  });

  it('keeps a connection answer that the route really asks for', () => {
    expect(
      parseOnboardingProgress(
        stored({
          v: 3,
          stage: 'walk',
          route: 'first-time',
          connection: 'own-relay',
          current: 'relay-source',
          furthest: 'relay-source',
        }),
        'desktop',
      ),
    ).toEqual({
      v: 3,
      stage: 'walk',
      route: 'first-time',
      connection: 'own-relay',
      current: 'relay-source',
      furthest: 'relay-source',
    });
  });

  it('starts at the question on anything it cannot fully trust', () => {
    const damaged = [
      null,
      undefined,
      '',
      'not json at all',
      stored(null),
      stored([{ v: 3, stage: 'walk', route: 'first-time', current: 'local', furthest: 'local' }]),
      stored('done'),
      // Version 1 was a single fixed arc; version 2's routes named what the
      // reader was holding. Neither maps onto a question about the device.
      stored({ v: 1, current: 'pair', furthest: 'done' }),
      stored({ v: 2, stage: 'walk', route: 'have-link', current: 'scan', furthest: 'done' }),
      stored({ v: 4, stage: 'walk', route: 'first-time', current: 'local', furthest: 'done' }),
      // A stage this store does not ship, and the first question itself.
      stored({ v: 3, stage: 'browse' }),
      stored({ v: 3, stage: 'who' }),
      // Unknown route, unknown steps, missing fields.
      walking('stepper', 'install'),
      walking('first-time', 'billing', 'done'),
      stored({ v: 3, stage: 'walk', route: 'first-time', current: 'install', furthest: 7 }),
      stored({ v: 3, stage: 'walk', route: 'first-time', current: 'install' }),
      // A step from another route's list: not this reader's place, a mismatch.
      walking('add-client', 'install'),
      walking('add-daemon', 'handoff', 'done'),
      // A carrier answer on the one route that never asks the carrier question.
      stored({ v: 3, stage: 'walk', route: 'add-client', connection: 'direct', current: 'pair', furthest: 'pair' }),
      stored({
        v: 3,
        stage: 'walk',
        route: 'first-time',
        connection: 'tunnel',
        current: 'install',
        furthest: 'install',
      }),
      // Self-inconsistent: further along than the furthest point ever reached.
      walking('first-time', 'done', 'daemon'),
    ];
    for (const raw of damaged) {
      expect(parseOnboardingProgress(raw, 'desktop')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    }
  });

  it('refuses a place the reading device cannot stand in', () => {
    // The very same document. A laptop resumes at the install command; a phone
    // has nowhere to type it, so the honest answer is the question again.
    const document = walking('first-time', 'install');
    expect(parseOnboardingProgress(document, 'desktop')).toMatchObject({ current: 'install' });
    expect(parseOnboardingProgress(document, 'mobile')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // And the mirror: a phone's own place is not a step a desktop route has.
    expect(parseOnboardingProgress(walking('first-time', 'need-computer'), 'mobile')).toMatchObject({
      current: 'need-computer',
    });
    expect(parseOnboardingProgress(walking('first-time', 'need-computer'), 'desktop')).toEqual({
      ...FRESH_ONBOARDING_PROGRESS,
    });
  });
});

describe('enterOnboardingRoute', () => {
  it('opens a route on the first step THAT DEVICE has', () => {
    expect(enterOnboardingRoute('first-time', 'desktop')).toEqual({
      v: 3,
      stage: 'walk',
      route: 'first-time',
      current: 'install',
      furthest: 'install',
    });
    expect(enterOnboardingRoute('first-time', 'mobile')).toEqual({
      v: 3,
      stage: 'walk',
      route: 'first-time',
      current: 'need-computer',
      furthest: 'need-computer',
    });
  });
});

describe('resumeOnboardingRoute', () => {
  it('lands exactly where the other device said, when that place exists here', () => {
    expect(resumeOnboardingRoute({ route: 'add-client', step: 'pair' }, 'mobile')).toEqual({
      v: 3,
      stage: 'walk',
      route: 'add-client',
      current: 'pair',
      furthest: 'pair',
    });
  });

  it('lands on the route rather than the step when the step is not for this device', () => {
    // A stale or hostile link proposing `install` to a phone still gets the
    // route it was sent to, and never a screen the phone cannot act on.
    expect(resumeOnboardingRoute({ route: 'first-time', step: 'install' }, 'mobile')).toEqual({
      v: 3,
      stage: 'walk',
      route: 'first-time',
      current: 'need-computer',
      furthest: 'need-computer',
    });
  });

  it('carries a connection answer through the hand-off when one was made', () => {
    expect(
      resumeOnboardingRoute({ route: 'first-time', step: 'relay-source', connection: 'own-relay' }, 'desktop'),
    ).toEqual({
      v: 3,
      stage: 'walk',
      route: 'first-time',
      connection: 'own-relay',
      current: 'relay-source',
      furthest: 'relay-source',
    });
  });
});

describe('OnboardingProgressStore', () => {
  it('hydrates once, publishes moves, and remembers the furthest point', () => {
    const storage = new MemoryStorage(walking('first-time', 'daemon'));
    const store = onDevice('desktop', { storage });
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.snapshot().stage));

    expect(store.snapshot()).toEqual({
      v: 3,
      stage: 'walk',
      route: 'first-time',
      current: 'daemon',
      furthest: 'daemon',
    });
    // Identity-stable between commits, so React does not re-render on a read.
    expect(store.snapshot()).toBe(store.snapshot());

    store.goTo('local');
    expect(store.snapshot()).toEqual({
      v: 3,
      stage: 'walk',
      route: 'first-time',
      current: 'local',
      furthest: 'local',
    });
    store.goTo('install');
    // Stepping back does NOT erase where they got to.
    expect(store.snapshot()).toEqual({
      v: 3,
      stage: 'walk',
      route: 'first-time',
      current: 'install',
      furthest: 'local',
    });
    expect(seen).toEqual(['walk', 'walk']);
    expect(JSON.parse(storage.writes[storage.writes.length - 1] ?? '{}')).toEqual({
      v: 3,
      stage: 'walk',
      route: 'first-time',
      current: 'install',
      furthest: 'local',
    });

    unsubscribe();
    store.goTo('done');
    expect(seen).toEqual(['walk', 'walk']);
  });

  it('states the device it observed, and the path every screen derives from it', () => {
    const store = onDevice('mobile', { storage: undefined });
    expect(store.device).toBe('mobile');
    store.choose('first-time');
    const at = store.snapshot();
    if (at.stage !== 'walk') throw new Error('expected a walking document');
    expect(store.path(at)).toEqual({ route: 'first-time', device: 'mobile', connection: undefined });
  });

  it('answers the question, and lets the reader take the answer back', () => {
    const storage = new MemoryStorage();
    const store = onDevice('desktop', { storage });
    // The FIRST question, not the device one: nothing is stored yet.
    expect(store.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });

    store.chooseDoer('self');
    expect(store.snapshot()).toEqual({ ...DEVICE_QUESTION_PROGRESS });
    store.choose('add-daemon');
    expect(store.snapshot()).toEqual(enterOnboardingRoute('add-daemon', 'desktop'));

    // Picking the wrong answer has to be survivable: back out and pick again.
    // A device route came from the DEVICE question, so that is where Back lands.
    store.leaveRoute();
    expect(store.snapshot()).toEqual({ ...DEVICE_QUESTION_PROGRESS });
    store.choose('add-client');
    expect(store.snapshot()).toEqual(enterOnboardingRoute('add-client', 'desktop'));
  });

  it('sends "an agent does it" straight into its own route, with no device question', () => {
    // The agent is on the machine that becomes the daemon, so this browser is the
    // client and there is nothing left to ask.
    const store = onDevice('mobile', { storage: undefined });
    expect(store.chooseDoer('agent')).toEqual(enterOnboardingRoute('agent', 'mobile'));
    expect(store.snapshot()).toMatchObject({ route: 'agent', current: 'brief' });

    // And Back out of it reaches the question that OPENED it — the first one,
    // which is a screen this reader has actually seen.
    store.leaveRoute();
    expect(store.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
  });

  it('walks the agent route identically on a phone and on a computer', () => {
    // Nothing on this route happens on the device holding the page, so nothing
    // about that device changes the journey.
    for (const device of ['desktop', 'mobile'] as const) {
      const store = onDevice(device, { storage: undefined });
      store.chooseDoer('agent');
      store.goTo('agent-pair');
      expect(store.snapshot()).toMatchObject({ route: 'agent', current: 'agent-pair' });
    }
  });

  it('leaves the device question by the first question, and refuses to leave a question as a route', () => {
    const store = onDevice('desktop', { storage: undefined });
    store.chooseDoer('self');
    store.backToWho();
    expect(store.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // Nothing is being walked, so there is no route to leave: refused, not coerced.
    expect(store.leaveRoute()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
  });

  it('resumes a reader who was AT the device question, rather than asking again', () => {
    // The one v3 state with no direct successor: it is now one question in, and
    // it survives as exactly that, with the first question one Back away.
    const storage = new MemoryStorage(stored({ v: 3, stage: 'choose' }));
    expect(onDevice('desktop', { storage }).snapshot()).toEqual({ ...DEVICE_QUESTION_PROGRESS });
  });

  it('persists the second chooser answer with the expanded self-hosted route', () => {
    const storage = new MemoryStorage();
    const store = onDevice('desktop', { storage });
    store.choose('first-time');
    store.goTo('connect');

    expect(store.chooseConnection('own-relay')).toEqual({
      v: 3,
      stage: 'walk',
      route: 'first-time',
      connection: 'own-relay',
      current: 'relay-fingerprint',
      furthest: 'relay-fingerprint',
    });
    expect(onDevice('desktop', { storage }).snapshot()).toEqual(store.snapshot());
  });

  it('sends every other carrier straight to the same-machine pairing step', () => {
    // No QR and no code: the daemon is on the machine reading this page.
    const store = onDevice('desktop', { storage: undefined });
    store.choose('add-daemon');
    store.goTo('connect');
    expect(store.chooseConnection('direct')).toMatchObject({ current: 'local', connection: 'direct' });
  });

  it('refuses a carrier answer from anywhere but the carrier question', () => {
    const store = onDevice('desktop', { storage: undefined });
    // The chooser is up: there is no route to answer for.
    expect(store.chooseConnection('direct')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    store.choose('first-time');
    // On the install step, this is a caller bug rather than a reader's choice.
    expect(store.chooseConnection('direct')).toEqual(enterOnboardingRoute('first-time', 'desktop'));
  });

  it('refuses a step that is not on this route, rather than inventing a place', () => {
    const store = onDevice('desktop', { storage: undefined });
    // The chooser is up: no route, so there is no step to be on.
    expect(store.goTo('install')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });

    store.choose('add-client');
    // `install` belongs to the daemon-bearing routes; a client never has it.
    expect(store.goTo('install')).toEqual(enterOnboardingRoute('add-client', 'desktop'));
    expect(store.goTo('done')).toEqual({
      v: 3,
      stage: 'walk',
      route: 'add-client',
      current: 'done',
      furthest: 'done',
    });
  });

  it('survives a reload by rehydrating from the same key', () => {
    const storage = new MemoryStorage();
    const first = onDevice('desktop', { storage });
    first.choose('first-time');
    first.goTo('daemon');
    // A new tab, hours later, with only storage between them.
    expect(onDevice('desktop', { storage }).snapshot()).toEqual({
      v: 3,
      stage: 'walk',
      route: 'first-time',
      current: 'daemon',
      furthest: 'daemon',
    });
    expect(ONBOARDING_PROGRESS_KEY).toBe('fy-onboarding-v3');
  });

  it('lets an arrival answer the question without rewriting their history', () => {
    const storage = new MemoryStorage(walking('first-time', 'install'));
    const store = onDevice('desktop', { storage, entry: { route: 'add-client', step: 'scan' } });

    // A tab opened from a pairing link IS a client being added, whatever storage
    // remembers…
    expect(store.snapshot()).toMatchObject({ route: 'add-client', current: 'scan' });
    // …and merely opening the link wrote nothing.
    expect(storage.writes).toEqual([]);
  });

  it('does not restart a route the arrival is already inside', () => {
    // Second visit from the same link, already past the scan: the arrival must
    // not throw them back to the start of the route they are walking.
    const storage = new MemoryStorage(walking('add-client', 'done'));
    const store = onDevice('desktop', { storage, entry: { route: 'add-client', step: 'scan' }, paired: true });
    expect(store.snapshot()).toEqual({
      v: 3,
      stage: 'walk',
      route: 'add-client',
      current: 'done',
      furthest: 'done',
    });
  });

  it('lets a hand-off outrank both storage and an arrival', () => {
    // Somebody stood at another device and pressed "continue on this one".
    // Nothing in storage is more recent than that deliberate act.
    const storage = new MemoryStorage(walking('first-time', 'need-computer'));
    const store = onDevice('mobile', {
      storage,
      entry: { route: 'add-client', step: 'scan' },
      handoff: { route: 'add-client', step: 'scan' },
    });
    expect(store.snapshot()).toEqual({
      v: 3,
      stage: 'walk',
      route: 'add-client',
      current: 'scan',
      furthest: 'scan',
    });
    // Landing here wrote nothing either: the link is a proposal, not a commit.
    expect(storage.writes).toEqual([]);
  });

  it('keeps working when storage is absent or refuses', () => {
    const withoutStorage = onDevice('desktop', { storage: undefined });
    expect(withoutStorage.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    withoutStorage.choose('first-time');
    expect(withoutStorage.snapshot().stage).toBe('walk');

    const hostile = onDevice('desktop', { storage: new HostileStorage() });
    expect(hostile.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // A refused write is an ordinary browser condition, not a setup failure.
    expect(hostile.choose('first-time')).toEqual(enterOnboardingRoute('first-time', 'desktop'));
  });

  it('defaults to the browser store, a desktop reading, and accepts neither being there', () => {
    expect(browserOnboardingStorage()).toBe(globalThis.localStorage as unknown as OnboardingProgressStorage);
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: 'not a function' } });
    try {
      expect(browserOnboardingStorage()).toBeUndefined();
      // The default path, exercised: no storage seam and no device passed at all.
      const bare = new OnboardingProgressStore();
      expect(bare.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
      // Desktop is the unknown-device answer, because hiding the daemon route
      // from the only kind of machine that can host one is the worse mistake.
      expect(bare.device).toBe('desktop');
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
    expect(onDevice('desktop', { storage, paired: true }).snapshot()).toEqual({
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
    expect(onDevice('desktop', { storage, paired: false }).snapshot()).toEqual({
      ...FRESH_ONBOARDING_PROGRESS,
    });
    // Absent evidence is the same answer: the default is fail-closed.
    expect(onDevice('desktop', { storage }).snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // With a pairing, the stored place is exactly what it says.
    expect(onDevice('desktop', { storage, paired: true }).snapshot()).toEqual({
      v: 3,
      stage: 'walk',
      route: 'first-time',
      current: 'done',
      furthest: 'done',
    });
  });

  it('leaves every unfinished document alone, paired or not', () => {
    const midway = { v: 3, stage: 'walk', route: 'first-time', current: 'daemon', furthest: 'local' } as const;
    expect(reconcileOnboardingProgress(midway, false)).toBe(midway);
    expect(reconcileOnboardingProgress(midway, true)).toBe(midway);
    // Having once reached the end is also unbelievable without a pairing.
    expect(
      reconcileOnboardingProgress(
        { v: 3, stage: 'walk', route: 'first-time', current: 'install', furthest: 'done' },
        false,
      ),
    ).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // The chooser has nothing to reconcile and is passed straight back.
    expect(reconcileOnboardingProgress(FRESH_ONBOARDING_PROGRESS, false)).toBe(FRESH_ONBOARDING_PROGRESS);
  });
});
