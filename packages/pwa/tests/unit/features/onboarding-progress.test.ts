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

import type { DeviceKind } from '../../../src/features/onboarding/device-kind.ts';
import {
  browserOnboardingStorage,
  doerQuestion,
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
  targetQuestion,
  walk,
} from '../../../src/features/onboarding/onboarding-progress.ts';

const stored = (value: unknown): string => JSON.stringify(value);

/** A version-4 walking document for a daemon standing up on this machine, by hand. */
const walking = (route: string, current: string, furthest = current): string =>
  stored({ v: ONBOARDING_PROGRESS_VERSION, stage: 'walk', route, target: 'this', doer: 'self', current, furthest });

/** The same, for a daemon that lives on a machine the reader has to walk to. */
const walkingAway = (route: string, current: string, furthest = current): string =>
  stored({ v: ONBOARDING_PROGRESS_VERSION, stage: 'walk', route, target: 'other', doer: 'self', current, furthest });

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
      v: 4,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'self',
      current: 'daemon',
      furthest: 'local',
    });
  });

  it('keeps a connection answer that the journey really asks for', () => {
    expect(
      parseOnboardingProgress(
        stored({
          v: 4,
          stage: 'walk',
          route: 'first-time',
          target: 'this',
          doer: 'self',
          connection: 'own-relay',
          current: 'relay-source',
          furthest: 'relay-source',
        }),
        'desktop',
      ),
    ).toEqual({
      v: 4,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'self',
      connection: 'own-relay',
      current: 'relay-source',
      furthest: 'relay-source',
    });
  });

  it('starts at the entry question on anything it cannot fully trust', () => {
    const damaged = [
      null,
      undefined,
      '',
      'not json at all',
      stored(null),
      stored([{ v: 4, stage: 'walk', route: 'first-time', current: 'local', furthest: 'local' }]),
      stored('done'),
      // Version 1 was a single fixed arc; version 2's routes named what the reader
      // was holding; version 3 named what this DEVICE was about to become. None of
      // them says which computer runs the daemon or who installs it.
      stored({ v: 1, current: 'pair', furthest: 'done' }),
      stored({ v: 2, stage: 'walk', route: 'have-link', current: 'scan', furthest: 'done' }),
      stored({ v: 3, stage: 'walk', route: 'first-time', current: 'install', furthest: 'install' }),
      stored({ v: 5, stage: 'walk', route: 'first-time', current: 'local', furthest: 'done' }),
      // A stage this store does not ship, and the entry question itself.
      stored({ v: 4, stage: 'browse' }),
      stored({ v: 4, stage: 'entry' }),
      // Unknown entry, unknown steps, missing fields.
      walking('stepper', 'install'),
      walking('first-time', 'billing', 'done'),
      stored({ v: 4, stage: 'walk', route: 'first-time', target: 'this', doer: 'self', current: 'install' }),
      // A journey with no answers on it at all: a route is no longer enough.
      stored({ v: 4, stage: 'walk', route: 'first-time', current: 'install', furthest: 'install' }),
      stored({ v: 4, stage: 'walk', route: 'first-time', target: 'this', current: 'install', furthest: 'install' }),
      stored({ v: 4, stage: 'walk', route: 'first-time', doer: 'self', current: 'install', furthest: 'install' }),
      // Answers that are not answers.
      stored({ v: 4, stage: 'walk', route: 'first-time', target: 'cloud', doer: 'self', current: 'install' }),
      stored({ v: 4, stage: 'walk', route: 'first-time', target: 'this', doer: 'nobody', current: 'install' }),
      // The pairing entry answers neither question, so a document holding one is
      // not this document.
      stored({ v: 4, stage: 'walk', route: 'add-client', target: 'this', current: 'pair', furthest: 'pair' }),
      stored({ v: 4, stage: 'walk', route: 'add-client', doer: 'self', current: 'pair', furthest: 'pair' }),
      stored({
        v: 4,
        stage: 'walk',
        route: 'add-client',
        connection: 'direct',
        current: 'pair',
        furthest: 'pair',
      }),
      // A step from another journey's list: not this reader's place, a mismatch.
      stored({ v: 4, stage: 'walk', route: 'add-client', current: 'install', furthest: 'install' }),
      walking('add-daemon', 'handoff', 'done'),
      // A carrier answer on a journey that never reaches the carrier question.
      stored({
        v: 4,
        stage: 'walk',
        route: 'first-time',
        target: 'other',
        doer: 'self',
        connection: 'direct',
        current: 'elsewhere',
        furthest: 'elsewhere',
      }),
      stored({
        v: 4,
        stage: 'walk',
        route: 'first-time',
        target: 'this',
        doer: 'agent',
        connection: 'direct',
        current: 'brief',
        furthest: 'brief',
      }),
      stored({
        v: 4,
        stage: 'walk',
        route: 'first-time',
        target: 'this',
        doer: 'self',
        connection: 'tunnel',
        current: 'install',
        furthest: 'install',
      }),
      // A stored question that names something other than a daemon entry.
      stored({ v: 4, stage: 'doer', route: 'add-client', target: 'this' }),
      stored({ v: 4, stage: 'doer', route: 'first-time' }),
      stored({ v: 4, stage: 'target', route: 'add-client' }),
      // Self-inconsistent: further along than the furthest point ever reached.
      walking('first-time', 'done', 'daemon'),
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
      parseOnboardingProgress(stored({ v: 4, stage: 'doer', route: 'first-time', target: 'this' }), 'mobile'),
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
    expect(
      parseOnboardingProgress(stored({ v: 4, stage: 'doer', route: 'first-time', target: 'other' }), 'mobile'),
    ).toEqual(doerQuestion('first-time', 'other'));
    expect(parseOnboardingProgress(stored({ v: 4, stage: 'target', route: 'add-daemon' }), 'desktop')).toEqual(
      targetQuestion('add-daemon'),
    );
    // A phone never sees the target question, so a document claiming it was there
    // is answered by what this device settles instead of by a screen it skips.
    expect(parseOnboardingProgress(stored({ v: 4, stage: 'target', route: 'add-daemon' }), 'mobile')).toEqual(
      doerQuestion('add-daemon', 'other'),
    );
    // Nor does a computer starting from scratch: it is assumed, not asked.
    expect(parseOnboardingProgress(stored({ v: 4, stage: 'target', route: 'first-time' }), 'desktop')).toEqual(
      doerQuestion('first-time', 'this'),
    );
  });
});

describe('enterOnboardingRoute', () => {
  it('asks who installs it, with the machine this device already settles', () => {
    expect(enterOnboardingRoute('first-time', 'desktop')).toEqual(doerQuestion('first-time', 'this'));
    expect(enterOnboardingRoute('first-time', 'mobile')).toEqual(doerQuestion('first-time', 'other'));
    expect(enterOnboardingRoute('add-daemon', 'mobile')).toEqual(doerQuestion('add-daemon', 'other'));
  });

  it('asks which computer first when a fleet is being added to from a computer', () => {
    expect(enterOnboardingRoute('add-daemon', 'desktop')).toEqual(targetQuestion('add-daemon'));
  });

  it('opens the pairing entry immediately, because it asks neither question', () => {
    expect(enterOnboardingRoute('add-client', 'mobile')).toEqual({
      v: 4,
      stage: 'walk',
      route: 'add-client',
      current: 'pair',
      furthest: 'pair',
    });
  });
});

describe('resumeOnboardingRoute', () => {
  it('lands exactly where the other device said, when that place exists here', () => {
    expect(resumeOnboardingRoute({ route: 'add-client', step: 'pair' }, 'mobile')).toEqual({
      v: 4,
      stage: 'walk',
      route: 'add-client',
      current: 'pair',
      furthest: 'pair',
    });
  });

  it('opens the recursion the way the sending device meant it', () => {
    // A phone handed the daemon half to a computer: that computer installs BY HAND
    // on ITSELF, which is the one place installation is ever taught.
    expect(
      resumeOnboardingRoute({ route: 'first-time', target: 'this', doer: 'self', step: 'install' }, 'desktop'),
    ).toEqual({
      v: 4,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'self',
      current: 'install',
      furthest: 'install',
    });
  });

  it('keeps its own answer when a link proposes what this device cannot do', () => {
    // A stale or hostile payload telling a phone it runs the daemon does not send
    // that phone back to the beginning; the phone keeps the answer the hardware
    // forces and lands on the screen that hands the job to a computer.
    expect(
      resumeOnboardingRoute({ route: 'first-time', target: 'this', doer: 'self', step: 'install' }, 'mobile'),
    ).toEqual({
      v: 4,
      stage: 'walk',
      route: 'first-time',
      target: 'other',
      doer: 'self',
      current: 'elsewhere',
      furthest: 'elsewhere',
    });
  });

  it('asks rather than invents when the link does not say enough', () => {
    expect(resumeOnboardingRoute({ route: 'add-daemon', step: 'install' }, 'desktop')).toEqual(
      targetQuestion('add-daemon'),
    );
    expect(resumeOnboardingRoute({ route: 'first-time', target: 'this', step: 'install' }, 'desktop')).toEqual(
      doerQuestion('first-time', 'this'),
    );
    expect(resumeOnboardingRoute({ route: 'add-daemon', step: 'install' }, 'mobile')).toEqual(
      doerQuestion('add-daemon', 'other'),
    );
  });

  it('carries a connection answer through the hand-off when one was made', () => {
    expect(
      resumeOnboardingRoute(
        { route: 'first-time', target: 'this', doer: 'self', step: 'relay-source', connection: 'own-relay' },
        'desktop',
      ),
    ).toEqual({
      v: 4,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'self',
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
      v: 4,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'self',
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
    store.chooseDoer('self');
    const at = store.snapshot();
    if (at.stage !== 'walk') throw new Error('expected a walking document');
    expect(store.path(at)).toEqual({
      route: 'first-time',
      target: 'other',
      doer: 'self',
      device: 'mobile',
    });
    // The pairing entry's path carries neither answer, because it was never asked.
    const client = onDevice('mobile', { storage: undefined });
    client.choose('add-client');
    const pairing = client.snapshot();
    if (pairing.stage !== 'walk') throw new Error('expected a walking document');
    expect(client.path(pairing)).toEqual({ route: 'add-client', device: 'mobile' });
  });

  it('walks a computer from scratch through ONE question, and states the assumption', () => {
    const storage = new MemoryStorage();
    const store = onDevice('desktop', { storage });
    expect(store.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });

    // No target question: assuming "this one" is what makes the common path short.
    store.choose('first-time');
    expect(store.snapshot()).toEqual(doerQuestion('first-time', 'this'));
    store.chooseDoer('self');
    expect(store.snapshot()).toMatchObject({ stage: 'walk', current: 'install', target: 'this', doer: 'self' });

    // Picking the wrong answer has to be survivable: back out, and land on the
    // question that opened this journey rather than one the reader never saw.
    store.leaveRoute();
    expect(store.snapshot()).toEqual(doerQuestion('first-time', 'this'));
    store.chooseDoer('agent');
    expect(store.snapshot()).toMatchObject({ current: 'brief', doer: 'agent' });
  });

  it('asks a reader adding to a fleet which computer, and lets them take it back', () => {
    const store = onDevice('desktop', { storage: undefined });
    store.choose('add-daemon');
    expect(store.snapshot()).toEqual(targetQuestion('add-daemon'));
    store.chooseTarget('other');
    expect(store.snapshot()).toEqual(doerQuestion('add-daemon', 'other'));
    // Back from who-installs-it reaches which-computer, because that WAS asked.
    store.back();
    expect(store.snapshot()).toEqual(targetQuestion('add-daemon'));
    // And back from there reaches the entry.
    store.back();
    expect(store.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
  });

  it('sends a reader who was never asked which computer back to the entry instead', () => {
    const store = onDevice('mobile', { storage: undefined });
    store.choose('first-time');
    expect(store.snapshot()).toEqual(doerQuestion('first-time', 'other'));
    store.back();
    expect(store.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // Nothing is being walked and no question is up: refused, not coerced.
    expect(store.back()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    expect(store.leaveRoute()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    expect(store.chooseDoer('self')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
  });

  it('never lets a phone claim the daemon, whoever asked it to', () => {
    const store = onDevice('mobile', { storage: undefined });
    store.choose('first-time');
    // Refused rather than stored: the hardware answer is not negotiable.
    expect(store.chooseTarget('this')).toEqual(doerQuestion('first-time', 'other'));
    expect(store.snapshot()).toEqual(doerQuestion('first-time', 'other'));
  });

  it('takes the escape from an assumption, from the question and from the step', () => {
    const fromQuestion = onDevice('desktop', { storage: undefined });
    fromQuestion.choose('first-time');
    // "Actually, another machine", pressed on the screen that states the assumption.
    expect(fromQuestion.chooseTarget('other')).toEqual(doerQuestion('first-time', 'other'));
    fromQuestion.chooseDoer('self');
    expect(fromQuestion.snapshot()).toMatchObject({ current: 'elsewhere', target: 'other' });

    // And from the install step, for the reader who did not read that screen: the
    // commands they are looking at are for the wrong machine, and saying so lands
    // on who-installs-it for the new one rather than inventing an answer.
    const fromStep = onDevice('desktop', { storage: undefined });
    fromStep.choose('first-time');
    fromStep.chooseDoer('self');
    expect(fromStep.chooseTarget('other')).toEqual(doerQuestion('first-time', 'other'));
  });

  it('refuses to answer which computer when nothing has named an entry', () => {
    const store = onDevice('desktop', { storage: undefined });
    expect(store.chooseTarget('this')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // And the pairing entry has no target to answer either.
    store.choose('add-client');
    expect(store.chooseTarget('this')).toMatchObject({ route: 'add-client', current: 'pair' });
  });

  it('changes who installs it from inside the journey, keeping the machine', () => {
    const store = onDevice('desktop', { storage: undefined });
    store.choose('first-time');
    store.chooseDoer('self');
    store.goTo('connect');
    store.chooseConnection('own-relay');
    // "Rather have an agent do it?", pressed halfway through the commands. The
    // carrier answer does not survive, because an agent is never asked it — and a
    // stored answer nothing collects is a document the next load would refuse.
    expect(store.switchDoer('agent')).toEqual({
      v: 4,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'agent',
      current: 'brief',
      furthest: 'brief',
    });
    // Refused from anywhere that is not a daemon journey being walked.
    const client = onDevice('desktop', { storage: undefined });
    expect(client.switchDoer('agent')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    client.choose('add-client');
    expect(client.switchDoer('agent')).toMatchObject({ route: 'add-client', current: 'pair' });
  });

  it('walks the agent answer identically on a phone and on a computer', () => {
    // Nothing on that journey happens on the device holding the page, so nothing
    // about that device changes it.
    for (const device of ['desktop', 'mobile'] as const) {
      const store = onDevice(device, { storage: undefined });
      store.choose('first-time');
      store.chooseDoer('agent');
      store.goTo('agent-pair');
      expect(store.snapshot()).toMatchObject({ doer: 'agent', current: 'agent-pair' });
    }
  });

  it('persists the carrier answer with the expanded self-hosted route', () => {
    const storage = new MemoryStorage();
    const store = onDevice('desktop', { storage });
    store.choose('first-time');
    store.chooseDoer('self');
    store.goTo('connect');

    expect(store.chooseConnection('own-relay')).toEqual({
      v: 4,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'self',
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
    store.chooseTarget('this');
    store.chooseDoer('self');
    store.goTo('connect');
    expect(store.chooseConnection('direct')).toMatchObject({ current: 'local', connection: 'direct' });
  });

  it('refuses a carrier answer from anywhere but the carrier question', () => {
    const store = onDevice('desktop', { storage: undefined });
    // A question is up: there is no journey to answer for.
    expect(store.chooseConnection('direct')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    store.choose('first-time');
    store.chooseDoer('self');
    // On the install step, this is a caller bug rather than a reader's choice.
    expect(store.chooseConnection('direct')).toMatchObject({ current: 'install' });
    // And the pairing entry never has the step at all.
    const client = onDevice('desktop', { storage: undefined });
    client.choose('add-client');
    expect(client.chooseConnection('direct')).toMatchObject({ route: 'add-client', current: 'pair' });
  });

  it('refuses a step that is not on this journey, rather than inventing a place', () => {
    const store = onDevice('desktop', { storage: undefined });
    // A question is up: no journey, so there is no step to be on.
    expect(store.goTo('install')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });

    store.choose('add-client');
    // `install` belongs to a daemon standing up here; a client never has it.
    expect(store.goTo('install')).toMatchObject({ route: 'add-client', current: 'pair' });
    expect(store.goTo('done')).toEqual({
      v: 4,
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
    first.chooseDoer('self');
    first.goTo('daemon');
    // A new tab, hours later, with only storage between them.
    expect(onDevice('desktop', { storage }).snapshot()).toMatchObject({ current: 'daemon', target: 'this' });
    expect(ONBOARDING_PROGRESS_KEY).toBe('fy-onboarding-v4');
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
    // Second visit from the same link, already past the scan: the arrival must
    // not throw them back to the start of the journey they are walking.
    const storage = new MemoryStorage(
      stored({ v: 4, stage: 'walk', route: 'add-client', current: 'done', furthest: 'done' }),
    );
    const store = onDevice('desktop', { storage, entry: { route: 'add-client', step: 'scan' }, paired: true });
    expect(store.snapshot()).toEqual({
      v: 4,
      stage: 'walk',
      route: 'add-client',
      current: 'done',
      furthest: 'done',
    });
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
      v: 4,
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
    expect(hostile.choose('first-time')).toEqual(doerQuestion('first-time', 'this'));
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
});

describe('walk', () => {
  it('opens a journey on the first step that journey has', () => {
    expect(walk({ route: 'first-time', target: 'other', doer: 'self' }, 'mobile')).toEqual({
      v: 4,
      stage: 'walk',
      route: 'first-time',
      target: 'other',
      doer: 'self',
      current: 'elsewhere',
      furthest: 'elsewhere',
    });
  });
});

describe('resetOnboardingProgress', () => {
  it('sends the next visit back to the entry question', () => {
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
    expect(onDevice('desktop', { storage, paired: true }).snapshot()).toMatchObject({
      current: 'done',
      furthest: 'done',
    });
  });

  it('leaves every unfinished document alone, paired or not', () => {
    const midway = {
      v: 4,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'self',
      current: 'daemon',
      furthest: 'local',
    } as const;
    expect(reconcileOnboardingProgress(midway, false)).toBe(midway);
    expect(reconcileOnboardingProgress(midway, true)).toBe(midway);
    // Having once reached the end is also unbelievable without a pairing.
    expect(
      reconcileOnboardingProgress(
        {
          v: 4,
          stage: 'walk',
          route: 'first-time',
          target: 'this',
          doer: 'self',
          current: 'install',
          furthest: 'done',
        },
        false,
      ),
    ).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // A question has nothing to reconcile and is passed straight back.
    expect(reconcileOnboardingProgress(FRESH_ONBOARDING_PROGRESS, false)).toBe(FRESH_ONBOARDING_PROGRESS);
  });
});
