/**
 * Resuming setup, and refusing to invent progress that was never made.
 *
 * The failure this suite exists to prevent is the benign one: reading damaged
 * storage as "they finished" and dropping someone who installed nothing onto a
 * pairing screen with nothing to pair.
 *
 * THREE MORE SHAPES OF THE SAME FAILURE, all of them about a document read on a
 * device that did not write it — which is not an edge case, it is what a hand-off
 * does every time. A stored "this computer runs the daemon", read on a phone, is
 * an impossibility rather than a place. A step from another journey's list is a
 * place this reader's journey does not have. And a step from the same journey on
 * the other kind of device is a screen of commands with nowhere to type them.
 * All three are damage, and all three read as a question rather than being
 * repaired.
 */

import { describe, expect, it } from 'bun:test';

import type { DeviceKind } from '../../../app/device-kind.ts';
import {
  browserOnboardingStorage,
  enterOnboardingRoute,
  FRESH_ONBOARDING_PROGRESS,
  ONBOARDING_PROGRESS_KEY,
  ONBOARDING_PROGRESS_FORMAT,
  type OnboardingProgressStorage,
  OnboardingProgressStore,
  parseOnboardingProgress,
  resetOnboardingProgress,
  startOnboardingPairing,
  resumeOnboardingRoute,
  targetQuestion,
  walk,
} from '../../../app/onboarding-progress.ts';

const stored = (value: unknown): string => JSON.stringify(value);

/** A format-1 walking document for a daemon standing up on this machine. */
const walking = (route: string, current: string, furthest = current): string =>
  stored({ format: ONBOARDING_PROGRESS_FORMAT, stage: 'walk', route, target: 'this', current, furthest });

/** The same, for a daemon that lives on a machine the reader has to walk to. */
const walkingAway = (route: string, current: string, furthest = current): string =>
  stored({
    format: ONBOARDING_PROGRESS_FORMAT,
    stage: 'walk',
    route,
    target: 'other',
    current,
    furthest,
  });

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
      format: 1,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      current: 'daemon',
      furthest: 'local',
    });
  });

  it('reads a document an older build wrote, with its retired answer on it, as the same place', () => {
    // The "who installs it" answer is gone (C59 O7); a stored place that still carries one is not damage.
    expect(
      parseOnboardingProgress(
        stored({
          format: 1,
          stage: 'walk',
          route: 'first-time',
          target: 'this',
          doer: 'self',
          current: 'daemon',
          furthest: 'local',
        }),
        'desktop',
      ),
    ).toEqual({ format: 1, stage: 'walk', route: 'first-time', target: 'this', current: 'daemon', furthest: 'local' });
  });

  it('refuses a stored place inside the removed agent journey', () => {
    for (const current of ['brief', 'agent-pair']) {
      expect(
        parseOnboardingProgress(
          stored({
            format: 1,
            stage: 'walk',
            route: 'first-time',
            target: 'this',
            doer: 'agent',
            current,
            furthest: current,
          }),
          'desktop',
        ),
      ).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    }
  });

  it('starts at the entry question on anything it cannot fully trust', () => {
    const damaged = [
      null,
      undefined,
      '',
      'not json at all',
      stored(null),
      stored([{ format: 1, stage: 'walk', route: 'first-time', current: 'local', furthest: 'local' }]),
      stored('done'),
      // Any other format is not read, whatever else it holds.
      stored({
        format: 0,
        stage: 'walk',
        route: 'first-time',
        target: 'this',
        current: 'local',
        furthest: 'done',
      }),
      stored({
        format: 2,
        stage: 'walk',
        route: 'first-time',
        target: 'this',
        current: 'local',
        furthest: 'done',
      }),
      stored({ stage: 'walk', route: 'first-time', target: 'this', current: 'local', furthest: 'done' }),
      // A stage this store does not ship, and the entry question itself.
      stored({ format: 1, stage: 'browse' }),
      stored({ format: 1, stage: 'entry' }),
      // Unknown entry, unknown steps, missing fields.
      walking('stepper', 'install'),
      walking('first-time', 'billing', 'done'),
      stored({ format: 1, stage: 'walk', route: 'first-time', target: 'this', current: 'install' }),
      // A journey with no answer on it at all: a route is no longer enough.
      stored({ format: 1, stage: 'walk', route: 'first-time', current: 'install', furthest: 'install' }),
      // Answers that are not answers.
      stored({ format: 1, stage: 'walk', route: 'first-time', target: 'cloud', current: 'install' }),
      // The pairing entry answers no question, so a document holding one is not this document.
      stored({ format: 1, stage: 'walk', route: 'add-client', target: 'this', current: 'pair', furthest: 'pair' }),
      // A step from another journey's list: not this reader's place, a mismatch.
      stored({ format: 1, stage: 'walk', route: 'add-client', current: 'install', furthest: 'install' }),
      // The steps r10 O5 removed: a stored place inside any of them names a screen that is gone.
      walking('add-daemon', 'handoff', 'done'),
      walking('first-time', 'agents'),
      walking('first-time', 'local', 'done'),
      // A stored question that names something other than a daemon entry (the retired doer question included).
      stored({ format: 1, stage: 'doer', route: 'add-client', target: 'this' }),
      stored({ format: 1, stage: 'doer', route: 'first-time' }),
      stored({ format: 1, stage: 'target', route: 'add-client' }),
      // Self-inconsistent: further along than the furthest point ever reached.
      walking('first-time', 'local', 'daemon'),
    ];
    for (const raw of damaged) {
      expect(parseOnboardingProgress(raw, 'desktop')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    }
  });

  it('refuses an answer the reading device cannot hold', () => {
    // The very same document. A laptop resumes at the install command; a phone
    // cannot be the daemon at all, so the claim itself is damage rather than a
    // place — and it is refused before any question about steps is asked.
    const document = walking('first-time', 'install');
    expect(parseOnboardingProgress(document, 'desktop')).toMatchObject({ current: 'install' });
    expect(parseOnboardingProgress(document, 'mobile')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    expect(
      parseOnboardingProgress(stored({ format: 1, stage: 'doer', route: 'first-time', target: 'this' }), 'mobile'),
    ).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // And the recursion's own screen is a real place on BOTH kinds of device.
    for (const device of ['desktop', 'mobile'] as const) {
      expect(parseOnboardingProgress(walkingAway('first-time', 'elsewhere'), device)).toMatchObject({
        current: 'elsewhere',
        target: 'other',
      });
    }
  });

  it('resumes a stored question, unless this device would never have asked it', () => {
    expect(parseOnboardingProgress(stored({ format: 1, stage: 'target', route: 'add-daemon' }), 'desktop')).toEqual(
      targetQuestion('add-daemon'),
    );
    // A phone never sees the target question, so a document claiming it was there
    // is answered by what this device settles instead of by a screen it skips.
    expect(parseOnboardingProgress(stored({ format: 1, stage: 'target', route: 'add-daemon' }), 'mobile')).toEqual(
      walk({ route: 'add-daemon', target: 'other' }, 'mobile'),
    );
    // Nor does a computer starting from scratch: it is assumed, not asked.
    expect(parseOnboardingProgress(stored({ format: 1, stage: 'target', route: 'first-time' }), 'desktop')).toEqual(
      walk({ route: 'first-time', target: 'this' }, 'desktop'),
    );
  });

  it('knows no "who installs it" question: a document that names one is read as the start screen', () => {
    for (const device of ['desktop', 'mobile'] as const) {
      expect(
        parseOnboardingProgress(stored({ format: 1, stage: 'doer', route: 'first-time', target: 'other' }), device),
      ).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    }
  });
});

describe('enterOnboardingRoute', () => {
  it('opens the install commands at once, with the machine this device already settles', () => {
    expect(enterOnboardingRoute('first-time', 'desktop')).toEqual(
      walk({ route: 'first-time', target: 'this' }, 'desktop'),
    );
    expect(enterOnboardingRoute('first-time', 'mobile')).toEqual(
      walk({ route: 'first-time', target: 'other' }, 'mobile'),
    );
    expect(enterOnboardingRoute('add-daemon', 'mobile')).toEqual(
      walk({ route: 'add-daemon', target: 'other' }, 'mobile'),
    );
  });

  it('asks which computer first when a fleet is being added to from a computer', () => {
    expect(enterOnboardingRoute('add-daemon', 'desktop')).toEqual(targetQuestion('add-daemon'));
  });

  it('opens the pairing entry immediately, because it asks neither question', () => {
    expect(enterOnboardingRoute('add-client', 'mobile')).toEqual({
      format: 1,
      stage: 'walk',
      route: 'add-client',
      current: 'scan',
      furthest: 'scan',
    });
  });
});

describe('resumeOnboardingRoute', () => {
  it('lands exactly where the other device said, when that place exists here', () => {
    expect(resumeOnboardingRoute({ route: 'add-client', step: 'scan' }, 'mobile')).toEqual({
      format: 1,
      stage: 'walk',
      route: 'add-client',
      current: 'scan',
      furthest: 'scan',
    });
  });

  it('opens the recursion the way the sending device meant it', () => {
    // A phone handed the daemon half to a computer: that computer installs
    // on ITSELF, which is the one place installation is ever taught.
    expect(resumeOnboardingRoute({ route: 'first-time', target: 'this', step: 'install' }, 'desktop')).toEqual({
      format: 1,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      current: 'install',
      furthest: 'install',
    });
  });

  it('keeps its own answer when a link proposes what this device cannot do', () => {
    // A stale or hostile payload telling a phone it runs the daemon does not send
    // that phone back to the beginning; the phone keeps the answer the hardware
    // forces and lands on the screen that hands the job to a computer.
    expect(resumeOnboardingRoute({ route: 'first-time', target: 'this', step: 'install' }, 'mobile')).toEqual({
      format: 1,
      stage: 'walk',
      route: 'first-time',
      target: 'other',
      current: 'elsewhere',
      furthest: 'elsewhere',
    });
  });

  it('asks which computer rather than inventing one when the link does not say', () => {
    expect(resumeOnboardingRoute({ route: 'add-daemon', step: 'install' }, 'desktop')).toEqual(
      targetQuestion('add-daemon'),
    );
    expect(resumeOnboardingRoute({ route: 'first-time', target: 'this', step: 'install' }, 'desktop')).toEqual(
      walk({ route: 'first-time', target: 'this' }, 'desktop'),
    );
    // A phone settles the machine itself, so nothing is asked.
    expect(resumeOnboardingRoute({ route: 'add-daemon', step: 'install' }, 'mobile')).toEqual(
      walk({ route: 'add-daemon', target: 'other' }, 'mobile'),
    );
  });
});

describe('OnboardingProgressStore', () => {
  it('hydrates once, publishes moves, and remembers the furthest point', () => {
    const storage = new MemoryStorage(walking('first-time', 'daemon'));
    const store = onDevice('desktop', { storage });
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.snapshot().stage));

    expect(store.snapshot()).toMatchObject({ stage: 'walk', current: 'daemon', furthest: 'daemon' });
    // Identity-stable between commits, so React does not re-render on a read.
    expect(store.snapshot()).toBe(store.snapshot());

    store.goTo('local');
    expect(store.snapshot()).toMatchObject({ current: 'local', furthest: 'local' });
    store.goTo('install');
    // Stepping back does NOT erase where they got to.
    expect(store.snapshot()).toMatchObject({ current: 'install', furthest: 'local' });
    expect(seen).toEqual(['walk', 'walk']);
    expect(JSON.parse(storage.writes[storage.writes.length - 1] ?? '{}')).toEqual({
      format: 1,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      current: 'install',
      furthest: 'local',
    });

    unsubscribe();
    store.goTo('daemon');
    expect(seen).toEqual(['walk', 'walk']);
  });

  it('states the device it observed, and the path every screen derives from it', () => {
    const store = onDevice('mobile', { storage: undefined });
    expect(store.device).toBe('mobile');
    store.choose('first-time');
    const at = store.snapshot();
    if (at.stage !== 'walk') throw new Error('expected a walking document');
    expect(store.path(at)).toEqual({
      route: 'first-time',
      target: 'other',
      device: 'mobile',
    });
    // The pairing entry's path carries no answer, because none was ever asked.
    const client = onDevice('mobile', { storage: undefined });
    client.choose('add-client');
    const pairing = client.snapshot();
    if (pairing.stage !== 'walk') throw new Error('expected a walking document');
    expect(client.path(pairing)).toEqual({ route: 'add-client', device: 'mobile' });
  });

  it('walks a computer from scratch with NO question, and states the assumption', () => {
    const storage = new MemoryStorage();
    const store = onDevice('desktop', { storage });
    expect(store.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });

    // No target question: assuming "this one" is what makes the common path short.
    store.choose('first-time');
    expect(store.snapshot()).toMatchObject({ stage: 'walk', current: 'install', target: 'this' });

    // Back from the first page of the commands is the start screen: nothing else was asked.
    store.leaveRoute();
    expect(store.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
  });

  it('asks a reader adding to a fleet which computer, and lets them take it back', () => {
    const store = onDevice('desktop', { storage: undefined });
    store.choose('add-daemon');
    expect(store.snapshot()).toEqual(targetQuestion('add-daemon'));
    store.chooseTarget('other');
    expect(store.snapshot()).toMatchObject({
      stage: 'walk',
      route: 'add-daemon',
      target: 'other',
      current: 'elsewhere',
    });
    // Back from the first page of that journey reaches which-computer, because that WAS asked.
    store.leaveRoute();
    expect(store.snapshot()).toEqual(targetQuestion('add-daemon'));
    // And back from there reaches the entry.
    store.back();
    expect(store.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
  });

  it('sends a reader who was never asked which computer back to the entry instead', () => {
    const store = onDevice('mobile', { storage: undefined });
    store.choose('first-time');
    expect(store.snapshot()).toMatchObject({ stage: 'walk', target: 'other', current: 'elsewhere' });
    store.leaveRoute();
    expect(store.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // Nothing is being walked and no question is up: refused, not coerced.
    expect(store.back()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    expect(store.leaveRoute()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
  });

  it('never lets a phone claim the daemon, whoever asked it to', () => {
    const store = onDevice('mobile', { storage: undefined });
    store.choose('first-time');
    // Refused rather than stored: the hardware answer is not negotiable.
    const before = store.snapshot();
    expect(store.chooseTarget('this')).toBe(before);
    expect(store.snapshot()).toMatchObject({ target: 'other', current: 'elsewhere' });
  });

  it('takes the escape from an assumption, from the question and from the step', () => {
    const fromQuestion = onDevice('desktop', { storage: undefined });
    fromQuestion.choose('first-time');
    // "Actually, another machine", pressed on the screen that states the assumption.
    fromQuestion.chooseTarget('other');
    expect(fromQuestion.snapshot()).toMatchObject({ current: 'elsewhere', target: 'other' });

    // And from the install step, for the reader who did not read that screen: the commands they are looking at are for
    // the wrong machine, and saying so lands on the first page of the new machine's journey.
    const fromStep = onDevice('desktop', { storage: undefined });
    fromStep.choose('first-time');
    fromStep.chooseTarget('other');
    expect(fromStep.snapshot()).toMatchObject({ current: 'elsewhere', target: 'other' });
  });

  it('refuses to answer which computer when nothing has named an entry', () => {
    const store = onDevice('desktop', { storage: undefined });
    expect(store.chooseTarget('this')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // And the pairing entry has no target to answer either.
    store.choose('add-client');
    expect(store.chooseTarget('this')).toMatchObject({ route: 'add-client', current: 'scan' });
  });

  it('has no way to switch the journey to an agent (C59 O7)', () => {
    const store = onDevice('desktop', { storage: undefined }) as unknown as Record<string, unknown>;
    expect(store.switchDoer).toBeUndefined();
  });

  it('goes from starting the daemon straight to the same-machine pairing step', () => {
    // No carrier question in between: direct is tried first and the hosted relay
    // is the automatic fallback, so there is nothing for the reader to decide.
    const store = onDevice('desktop', { storage: undefined });
    store.choose('add-daemon');
    store.chooseTarget('this');
    store.goTo('daemon');
    expect(store.goTo('local')).toMatchObject({ current: 'local', furthest: 'local' });
    expect(store.snapshot()).not.toHaveProperty('connection');
  });

  it('refuses a step that is not on this journey, rather than inventing a place', () => {
    const store = onDevice('desktop', { storage: undefined });
    // A question is up: no journey, so there is no step to be on.
    expect(store.goTo('install')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });

    store.choose('add-client');
    // `install` belongs to a daemon standing up here; a client never has it.
    expect(store.goTo('install')).toMatchObject({ route: 'add-client', current: 'scan' });
    expect(store.goTo('scan')).toEqual({
      format: 1,
      stage: 'walk',
      route: 'add-client',
      current: 'scan',
      furthest: 'scan',
    });
    // The three steps r10 O5 removed are on no journey.
    expect(store.goTo('done' as never)).toMatchObject({ current: 'scan' });
  });

  it('survives a reload by rehydrating from the same key', () => {
    const storage = new MemoryStorage();
    const first = onDevice('desktop', { storage });
    first.choose('first-time');
    first.goTo('daemon');
    // A new tab, hours later, with only storage between them.
    expect(onDevice('desktop', { storage }).snapshot()).toMatchObject({ current: 'daemon', target: 'this' });
    expect(ONBOARDING_PROGRESS_KEY).toBe('fy:onboarding:progress');
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

  it('does not restart a journey the arrival is already inside', () => {
    // Back on the scan step of the pairing it is still walking: the arrival must
    // not throw them back to the start of the journey they are walking.
    const storage = new MemoryStorage(
      stored({ format: 1, stage: 'walk', route: 'add-client', current: 'scan', furthest: 'scan' }),
    );
    const store = onDevice('desktop', { storage, entry: { route: 'add-client', step: 'scan' } });
    expect(store.snapshot()).toEqual({
      format: 1,
      stage: 'walk',
      route: 'add-client',
      current: 'scan',
      furthest: 'scan',
    });
  });

  it('opens the journey a link of the app names, without the start screen', () => {
    // `/onboarding?journey=pair`: the person already said which one by clicking the link. A stored place of ANOTHER
    // journey is not theirs.
    const storage = new MemoryStorage(walking('first-time', 'daemon'));
    const store = onDevice('desktop', { storage, entry: { route: 'add-client', step: 'scan' } });
    expect(store.snapshot()).toMatchObject({ route: 'add-client', current: 'scan' });
    expect(storage.writes).toEqual([]);
    // Set up a new daemon from a computer asks which computer, as it always did.
    expect(
      onDevice('desktop', { storage: undefined, entry: { route: 'add-daemon', step: 'install' } }).snapshot(),
    ).toEqual(targetQuestion('add-daemon'));
  });

  it('forgets the place on disk when the daemonless half is over, and does not redraw the screen it leaves', () => {
    const storage = new MemoryStorage(walking('first-time', 'daemon'));
    const store = onDevice('desktop', { storage });
    let draws = 0;
    store.subscribe(() => (draws += 1));
    const before = store.snapshot();
    store.finish();
    // The next visit starts at the start screen…
    expect(onDevice('desktop', { storage }).snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // …and this one did not flicker to it on the way out.
    expect(store.snapshot()).toBe(before);
    expect(draws).toBe(0);
  });

  it('lets a hand-off outrank both storage and an arrival', () => {
    // Somebody stood at another device and pressed "continue on this one".
    // Nothing in storage is more recent than that deliberate act.
    const storage = new MemoryStorage(walkingAway('first-time', 'elsewhere'));
    const store = onDevice('mobile', {
      storage,
      entry: { route: 'add-client', step: 'scan' },
      handoff: { route: 'add-client', step: 'scan' },
    });
    expect(store.snapshot()).toEqual({
      format: 1,
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
    withoutStorage.choose('add-client');
    expect(withoutStorage.snapshot().stage).toBe('walk');

    const hostile = onDevice('desktop', { storage: new HostileStorage() });
    expect(hostile.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // A refused write is an ordinary browser condition, not a setup failure.
    expect(hostile.choose('first-time')).toMatchObject({ stage: 'walk', current: 'install' });
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
      // Desktop is the unknown-device answer, because hiding the daemon journey
      // from the only kind of machine that can host one is the worse mistake.
      expect(bare.device).toBe('desktop');
      // And the reset falls back to the same absent default without throwing.
      resetOnboardingProgress();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'localStorage');
    }
  });
  it('reads no storage when the browser refuses even to hand over the property', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      expect(browserOnboardingStorage()).toBeUndefined();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'localStorage');
    }
  });
});

describe('walk', () => {
  it('opens a journey on the first step that journey has', () => {
    expect(walk({ route: 'first-time', target: 'other' }, 'mobile')).toEqual({
      format: 1,
      stage: 'walk',
      route: 'first-time',
      target: 'other',
      current: 'elsewhere',
      furthest: 'elsewhere',
    });
  });
});

describe('resetOnboardingProgress', () => {
  it('sends the next visit back to the entry question', () => {
    // "Set up another machine": every new machine is a first-time setup for that
    // machine, so the finished journey of a different host must not be resumed.
    const storage = new MemoryStorage(walking('first-time', 'local'));
    resetOnboardingProgress(storage);
    expect(JSON.parse(storage.writes[0] ?? '{}')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    expect(onDevice('desktop', { storage }).snapshot()).toEqual({
      ...FRESH_ONBOARDING_PROGRESS,
    });
  });

  it('is a no-op when there is nowhere to write, and never throws', () => {
    resetOnboardingProgress(undefined);
    resetOnboardingProgress(new HostileStorage());
  });
});

describe('startOnboardingPairing', () => {
  it('sends the next visit to the pairing step, past the question, for a browser told to pair again', () => {
    // A pairing that was left, then the machine stopped accepting this browser.
    const storage = new MemoryStorage(
      stored({ format: 1, stage: 'walk', route: 'add-client', current: 'scan', furthest: 'scan' }),
    );
    startOnboardingPairing('mobile', storage);
    expect(onDevice('mobile', { storage }).snapshot()).toEqual({
      format: 1,
      stage: 'walk',
      route: 'add-client',
      current: 'scan',
      furthest: 'scan',
    });
  });

  it('is a no-op when there is nowhere to write, and never throws', () => {
    startOnboardingPairing('desktop', undefined);
    startOnboardingPairing('desktop', new HostileStorage());
  });
});
