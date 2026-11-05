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
 *
 * THE v4 → v5 MIGRATION is the other half. The merged pages are a renaming of places
 * the reader really was, so a half-finished v4 setup must land on the page that now
 * holds its step — on every route, on both devices — while a finished or damaged one
 * is the first question.
 */

import { describe, expect, it } from 'bun:test';

import type { DeviceKind } from '../../../src/features/onboarding/device-kind.ts';
import type { OnboardingStepId } from '../../../src/features/onboarding/onboarding-model.ts';
import {
  browserOnboardingStorage,
  doerQuestion,
  enterOnboardingRoute,
  FRESH_ONBOARDING_PROGRESS,
  migrateOnboardingProgressV4,
  ONBOARDING_PROGRESS_KEY,
  ONBOARDING_PROGRESS_KEY_V4,
  ONBOARDING_PROGRESS_VERSION,
  type OnboardingProgressStorage,
  OnboardingProgressStore,
  parseOnboardingProgress,
  resetOnboardingProgress,
  resumeOnboardingRoute,
  startOnboardingPairing,
  targetQuestion,
  walk,
} from '../../../src/features/onboarding/onboarding-progress.ts';

const stored = (value: unknown): string => JSON.stringify(value);

/** A version-5 walking document for a daemon standing up on this machine, by hand. */
const walking = (route: string, current: string, furthest = current): string =>
  stored({ v: ONBOARDING_PROGRESS_VERSION, stage: 'walk', route, target: 'this', doer: 'self', current, furthest });

/** The same, for a daemon that lives on a machine the reader has to walk to. */
const walkingAway = (route: string, current: string, furthest = current): string =>
  stored({ v: ONBOARDING_PROGRESS_VERSION, stage: 'walk', route, target: 'other', doer: 'self', current, furthest });

/** A version-4 walking document, which the migration reads and nothing else ever writes. */
const v4Walking = (fields: Record<string, unknown>, current: string, furthest = current): string =>
  stored({ v: 4, stage: 'walk', ...fields, current, furthest });

/** Every store in this suite states its device, because the device changes the answer. */
const onDevice = (
  device: DeviceKind,
  options: ConstructorParameters<typeof OnboardingProgressStore>[0] = {},
): OnboardingProgressStore => new OnboardingProgressStore({ device, ...options });

/** A step spelled the way a stale document spelled it, which the live type refuses. */
const staleStep = (step: string): OnboardingStepId => step as unknown as OnboardingStepId;

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

/** Two generations side by side, with a record of every key read and written. */
class KeyedStorage implements OnboardingProgressStorage {
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly #values = new Map<string, string>();
  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [key, value] of Object.entries(initial)) this.#values.set(key, value);
  }
  getItem(key: string): string | null {
    this.reads.push(key);
    return this.#values.get(key) ?? null;
  }
  setItem(key: string, next: string): void {
    this.writes.push(key);
    this.#values.set(key, next);
  }
  peek(key: string): string | null {
    return this.#values.get(key) ?? null;
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
    expect(parseOnboardingProgress(walking('first-time', 'install', 'local'), 'desktop')).toEqual({
      v: 5,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'self',
      current: 'install',
      furthest: 'local',
    });
  });

  it('reads the version-5 key and version', () => {
    expect(ONBOARDING_PROGRESS_KEY).toBe('fy-onboarding-v5');
    expect(ONBOARDING_PROGRESS_KEY_V4).toBe('fy-onboarding-v4');
    expect(ONBOARDING_PROGRESS_VERSION).toBe(5);
    expect(FRESH_ONBOARDING_PROGRESS).toEqual({ v: 5, stage: 'entry' });
  });

  it('keeps the place of a reader who answered the carrier chooser before it was removed', () => {
    // A stored journey from before the chooser went away still carries its
    // answer. It is ignored, not refused: a reader parked on `local` keeps
    // their place instead of being sent back to the first question.
    expect(
      parseOnboardingProgress(
        stored({
          v: 5,
          stage: 'walk',
          route: 'first-time',
          target: 'this',
          doer: 'self',
          connection: 'default-relay',
          current: 'local',
          furthest: 'local',
        }),
        'desktop',
      ),
    ).toEqual({
      v: 5,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'self',
      current: 'local',
      furthest: 'local',
    });
  });

  it('starts again for a reader parked on a self-hosting step that no longer exists', () => {
    for (const step of ['connect', 'relay-source']) {
      expect(
        parseOnboardingProgress(
          stored({
            v: 5,
            stage: 'walk',
            route: 'first-time',
            target: 'this',
            doer: 'self',
            connection: 'own-relay',
            current: step,
            furthest: step,
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
      stored([{ v: 5, stage: 'walk', route: 'first-time', current: 'local', furthest: 'local' }]),
      stored('done'),
      // Version 1 was a single fixed arc; version 2's routes named what the reader
      // was holding; version 3 named what this DEVICE was about to become; version 4
      // had more pages. None of them is a version-5 document — a version-4 one has its
      // own reader, which the store consults, and this parser never does.
      stored({ v: 1, current: 'pair', furthest: 'done' }),
      stored({ v: 2, stage: 'walk', route: 'have-link', current: 'scan', furthest: 'done' }),
      stored({ v: 3, stage: 'walk', route: 'first-time', current: 'install', furthest: 'install' }),
      v4Walking({ route: 'first-time', target: 'this', doer: 'self' }, 'local'),
      stored({ v: 6, stage: 'walk', route: 'first-time', current: 'local', furthest: 'local' }),
      // A stage this store does not ship, and the entry question itself.
      stored({ v: 5, stage: 'browse' }),
      stored({ v: 5, stage: 'entry' }),
      // Unknown entry, unknown steps, missing fields.
      walking('stepper', 'install'),
      walking('first-time', 'billing', 'local'),
      stored({ v: 5, stage: 'walk', route: 'first-time', target: 'this', doer: 'self', current: 'install' }),
      // A journey with no answers on it at all: a route is no longer enough.
      stored({ v: 5, stage: 'walk', route: 'first-time', current: 'install', furthest: 'install' }),
      stored({ v: 5, stage: 'walk', route: 'first-time', target: 'this', current: 'install', furthest: 'install' }),
      stored({ v: 5, stage: 'walk', route: 'first-time', doer: 'self', current: 'install', furthest: 'install' }),
      // Answers that are not answers.
      stored({ v: 5, stage: 'walk', route: 'first-time', target: 'cloud', doer: 'self', current: 'install' }),
      stored({ v: 5, stage: 'walk', route: 'first-time', target: 'this', doer: 'nobody', current: 'install' }),
      // The pairing entry answers neither question, so a document holding one is
      // not this document.
      stored({ v: 5, stage: 'walk', route: 'add-client', target: 'this', current: 'pair', furthest: 'pair' }),
      stored({ v: 5, stage: 'walk', route: 'add-client', doer: 'self', current: 'pair', furthest: 'pair' }),
      // A step from another journey's list: not this reader's place, a mismatch.
      stored({ v: 5, stage: 'walk', route: 'add-client', current: 'install', furthest: 'install' }),
      walking('add-daemon', 'handoff'),
      walking('first-time', 'brief'),
      walkingAway('first-time', 'install'),
      // Steps the merged journeys no longer have, in a document claiming to be new.
      walking('first-time', 'agents'),
      walking('first-time', 'daemon'),
      walking('first-time', 'done'),
      stored({ v: 5, stage: 'walk', route: 'add-client', current: 'scan', furthest: 'scan' }),
      stored({ v: 5, stage: 'walk', route: 'add-client', current: 'done', furthest: 'done' }),
      stored({
        v: 5,
        stage: 'walk',
        route: 'first-time',
        target: 'this',
        doer: 'agent',
        current: 'agent-pair',
        furthest: 'agent-pair',
      }),
      // A stored question that names something other than a daemon entry.
      stored({ v: 5, stage: 'doer', route: 'add-client', target: 'this' }),
      stored({ v: 5, stage: 'doer', route: 'first-time' }),
      stored({ v: 5, stage: 'target', route: 'add-client' }),
      // Self-inconsistent: further along than the furthest point ever reached.
      walking('first-time', 'local', 'install'),
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
      parseOnboardingProgress(stored({ v: 5, stage: 'doer', route: 'first-time', target: 'this' }), 'mobile'),
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
      parseOnboardingProgress(stored({ v: 5, stage: 'doer', route: 'first-time', target: 'other' }), 'mobile'),
    ).toEqual(doerQuestion('first-time', 'other'));
    expect(parseOnboardingProgress(stored({ v: 5, stage: 'target', route: 'add-daemon' }), 'desktop')).toEqual(
      targetQuestion('add-daemon'),
    );
    // A phone never sees the target question, so a document claiming it was there
    // is answered by what this device settles instead of by a screen it skips.
    expect(parseOnboardingProgress(stored({ v: 5, stage: 'target', route: 'add-daemon' }), 'mobile')).toEqual(
      doerQuestion('add-daemon', 'other'),
    );
    // Nor does a computer starting from scratch: it is assumed, not asked.
    expect(parseOnboardingProgress(stored({ v: 5, stage: 'target', route: 'first-time' }), 'desktop')).toEqual(
      doerQuestion('first-time', 'this'),
    );
  });
});

describe('migrateOnboardingProgressV4', () => {
  type Landing = readonly [current: string, lands: OnboardingStepId | undefined];

  interface Journey {
    readonly name: string;
    readonly fields: Record<string, unknown>;
    readonly devices: readonly DeviceKind[];
    readonly cases: readonly Landing[];
  }

  const local = (route: 'first-time' | 'add-daemon', extra: readonly Landing[]): Journey => ({
    name: `${route}, this computer, by hand`,
    fields: { route, target: 'this', doer: 'self' },
    devices: ['desktop'],
    cases: [
      ['install', 'install'],
      ['agents', 'install'],
      ['daemon', 'install'],
      ['local', 'local'],
      ...extra,
      ['done', undefined],
      // Pages that were never on this journey's v4 list.
      ['brief', undefined],
      ['agent-pair', undefined],
      ['elsewhere', undefined],
      ['scan', undefined],
      ['pair', undefined],
    ],
  });

  const agent = (route: 'first-time' | 'add-daemon', target: 'this' | 'other', device: DeviceKind): Journey => ({
    name: `${route}, ${target}, by an agent, on ${device}`,
    fields: { route, target, doer: 'agent' },
    devices: [device],
    cases: [
      ['brief', 'brief'],
      ['agent-pair', 'brief'],
      ['done', undefined],
      ['install', undefined],
      ['scan', undefined],
      ['pair', undefined],
    ],
  });

  const elsewhere = (route: 'first-time' | 'add-daemon'): Journey => ({
    name: `${route}, another computer, by hand`,
    fields: { route, target: 'other', doer: 'self' },
    devices: ['desktop', 'mobile'],
    cases: [
      ['elsewhere', 'elsewhere'],
      ['scan', 'elsewhere'],
      ['done', undefined],
      ['install', undefined],
      ['brief', undefined],
      ['pair', undefined],
    ],
  });

  const journeys: readonly Journey[] = [
    local('first-time', [['handoff', 'handoff']]),
    local('add-daemon', [['handoff', undefined]]),
    agent('first-time', 'this', 'desktop'),
    agent('first-time', 'other', 'desktop'),
    agent('first-time', 'other', 'mobile'),
    agent('add-daemon', 'this', 'desktop'),
    agent('add-daemon', 'other', 'desktop'),
    agent('add-daemon', 'other', 'mobile'),
    elsewhere('first-time'),
    elsewhere('add-daemon'),
    {
      name: 'add-client',
      fields: { route: 'add-client' },
      devices: ['desktop', 'mobile'],
      cases: [
        ['pair', 'pair'],
        ['scan', 'pair'],
        ['done', undefined],
        ['install', undefined],
        ['brief', undefined],
        ['elsewhere', undefined],
      ],
    },
  ];

  it('lands every old step of every half-finished journey on the merged page that holds it', () => {
    for (const journey of journeys) {
      for (const device of journey.devices) {
        for (const [current, lands] of journey.cases) {
          const migrated = migrateOnboardingProgressV4(v4Walking(journey.fields, current), device);
          const expected =
            lands === undefined
              ? { ...FRESH_ONBOARDING_PROGRESS }
              : { v: 5, stage: 'walk', ...journey.fields, current: lands, furthest: lands };
          expect<unknown>([journey.name, device, current, migrated]).toEqual([journey.name, device, current, expected]);
        }
      }
    }
  });

  it('covers every step id a version-4 document could hold', () => {
    const everyOldStep = [
      'install',
      'agents',
      'daemon',
      'local',
      'elsewhere',
      'handoff',
      'scan',
      'pair',
      'done',
      'brief',
      'agent-pair',
    ];
    const reached = new Set(journeys.flatMap(journey => journey.cases.map(([current]) => current)));
    for (const step of everyOldStep) expect(reached.has(step)).toBe(true);
  });

  it('re-homes both places of a document that had walked further than it stands', () => {
    const first = { route: 'first-time', target: 'this', doer: 'self' } as const;
    const base = { v: 5, stage: 'walk', ...first } as const;
    expect(migrateOnboardingProgressV4(v4Walking(first, 'install', 'daemon'), 'desktop')).toEqual({
      ...base,
      current: 'install',
      furthest: 'install',
    });
    expect(migrateOnboardingProgressV4(v4Walking(first, 'agents', 'local'), 'desktop')).toEqual({
      ...base,
      current: 'install',
      furthest: 'local',
    });
    expect(migrateOnboardingProgressV4(v4Walking(first, 'daemon', 'handoff'), 'desktop')).toEqual({
      ...base,
      current: 'install',
      furthest: 'handoff',
    });
    expect(migrateOnboardingProgressV4(v4Walking(first, 'local', 'handoff'), 'desktop')).toEqual({
      ...base,
      current: 'local',
      furthest: 'handoff',
    });
    expect(migrateOnboardingProgressV4(v4Walking(first, 'handoff', 'handoff'), 'desktop')).toEqual({
      ...base,
      current: 'handoff',
      furthest: 'handoff',
    });

    const agentJourney = { route: 'first-time', target: 'this', doer: 'agent' } as const;
    expect(migrateOnboardingProgressV4(v4Walking(agentJourney, 'brief', 'agent-pair'), 'desktop')).toEqual({
      v: 5,
      stage: 'walk',
      ...agentJourney,
      current: 'brief',
      furthest: 'brief',
    });
    const away = { route: 'add-daemon', target: 'other', doer: 'self' } as const;
    expect(migrateOnboardingProgressV4(v4Walking(away, 'elsewhere', 'scan'), 'mobile')).toEqual({
      v: 5,
      stage: 'walk',
      ...away,
      current: 'elsewhere',
      furthest: 'elsewhere',
    });
    expect(migrateOnboardingProgressV4(v4Walking({ route: 'add-client' }, 'pair', 'scan'), 'mobile')).toEqual({
      v: 5,
      stage: 'walk',
      route: 'add-client',
      current: 'pair',
      furthest: 'pair',
    });
  });

  it('never leaves current past furthest, whatever pair of old steps it was given', () => {
    const first = { route: 'first-time', target: 'this', doer: 'self' } as const;
    const steps = ['install', 'agents', 'daemon', 'local', 'handoff'];
    for (const current of steps) {
      for (const furthest of steps) {
        const migrated = migrateOnboardingProgressV4(v4Walking(first, current, furthest), 'desktop');
        if (steps.indexOf(current) > steps.indexOf(furthest)) {
          expect(migrated).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
          continue;
        }
        // Whatever it lands on has to be a document the live parser accepts as it stands.
        expect(parseOnboardingProgress(JSON.stringify(migrated), 'desktop')).toEqual(migrated);
        expect(migrated.stage).toBe('walk');
      }
    }
  });

  it('treats a finished journey as the first question, even when it was only the furthest point', () => {
    const first = { route: 'first-time', target: 'this', doer: 'self' } as const;
    expect(migrateOnboardingProgressV4(v4Walking(first, 'done'), 'desktop')).toEqual({
      ...FRESH_ONBOARDING_PROGRESS,
    });
    expect(migrateOnboardingProgressV4(v4Walking(first, 'local', 'done'), 'desktop')).toEqual({
      ...FRESH_ONBOARDING_PROGRESS,
    });
    expect(migrateOnboardingProgressV4(v4Walking({ route: 'add-client' }, 'pair', 'done'), 'mobile')).toEqual({
      ...FRESH_ONBOARDING_PROGRESS,
    });
  });

  it('keeps refusing the inconsistent documents version 4 already refused', () => {
    const first = { route: 'first-time', target: 'this', doer: 'self' } as const;
    const damaged = [
      // Further along than the furthest point ever reached.
      v4Walking(first, 'local', 'install'),
      v4Walking(first, 'done', 'daemon'),
      v4Walking({ route: 'add-client' }, 'scan', 'pair'),
      // Unknown steps, wrong types, missing fields.
      v4Walking(first, 'billing'),
      v4Walking(first, 'connect'),
      v4Walking(first, 'relay-source'),
      v4Walking(first, 'local', 'billing'),
      stored({ v: 4, stage: 'walk', ...first, current: 3, furthest: 3 }),
      stored({ v: 4, stage: 'walk', ...first, current: 'local' }),
      stored({ v: 4, stage: 'walk', ...first, furthest: 'local' }),
      // Answers that are not answers, or answers the pairing entry never gave.
      v4Walking({ route: 'first-time', doer: 'self' }, 'install'),
      v4Walking({ route: 'first-time', target: 'this' }, 'install'),
      v4Walking({ route: 'first-time', target: 'cloud', doer: 'self' }, 'install'),
      v4Walking({ route: 'first-time', target: 'this', doer: 'nobody' }, 'install'),
      v4Walking({ route: 'add-client', target: 'this' }, 'pair'),
      v4Walking({ route: 'add-client', doer: 'self' }, 'pair'),
      v4Walking({ route: 'stepper', target: 'this', doer: 'self' }, 'install'),
      // Not a version-4 document at all.
      stored({ v: 5, stage: 'walk', ...first, current: 'local', furthest: 'local' }),
      stored({ v: 3, stage: 'walk', ...first, current: 'install', furthest: 'install' }),
      stored({ v: 4, stage: 'browse' }),
      stored({ v: 4, stage: 'entry' }),
    ];
    for (const raw of damaged) {
      expect(migrateOnboardingProgressV4(raw, 'desktop')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    }
  });

  it('never throws on damaged JSON, and reads it as the first question', () => {
    const damaged = [
      null,
      undefined,
      '',
      '{',
      '{"v":4,"stage":"walk"',
      'not json at all',
      'null',
      'true',
      '4',
      '"done"',
      '[]',
      '[{"v":4}]',
      '{}',
      '{"v":4}',
      '{"v":"4","stage":"walk"}',
    ];
    for (const raw of damaged) {
      for (const device of ['desktop', 'mobile'] as const) {
        expect(migrateOnboardingProgressV4(raw, device)).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
      }
    }
  });

  it('refuses a version-4 place this device cannot hold', () => {
    // A phone cannot be the daemon, so a laptop's local journey is damage there, not a place.
    const first = { route: 'first-time', target: 'this', doer: 'self' } as const;
    for (const step of ['install', 'daemon', 'local', 'handoff']) {
      expect(migrateOnboardingProgressV4(v4Walking(first, step), 'mobile')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    }
    expect(
      migrateOnboardingProgressV4(v4Walking({ route: 'first-time', target: 'this', doer: 'agent' }, 'brief'), 'mobile'),
    ).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
  });

  it('carries a stored question across unchanged, unless this device would never have asked it', () => {
    expect(
      migrateOnboardingProgressV4(stored({ v: 4, stage: 'doer', route: 'first-time', target: 'this' }), 'desktop'),
    ).toEqual(doerQuestion('first-time', 'this'));
    expect(
      migrateOnboardingProgressV4(stored({ v: 4, stage: 'doer', route: 'add-daemon', target: 'other' }), 'desktop'),
    ).toEqual(doerQuestion('add-daemon', 'other'));
    expect(migrateOnboardingProgressV4(stored({ v: 4, stage: 'target', route: 'add-daemon' }), 'desktop')).toEqual(
      targetQuestion('add-daemon'),
    );
    expect(migrateOnboardingProgressV4(stored({ v: 4, stage: 'target', route: 'add-daemon' }), 'mobile')).toEqual(
      doerQuestion('add-daemon', 'other'),
    );
    // Refused: a phone cannot hold "this", and the pairing entry has no questions.
    expect(
      migrateOnboardingProgressV4(stored({ v: 4, stage: 'doer', route: 'first-time', target: 'this' }), 'mobile'),
    ).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    expect(
      migrateOnboardingProgressV4(stored({ v: 4, stage: 'doer', route: 'add-client', target: 'this' }), 'desktop'),
    ).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    expect(migrateOnboardingProgressV4(stored({ v: 4, stage: 'target', route: 'add-client' }), 'desktop')).toEqual({
      ...FRESH_ONBOARDING_PROGRESS,
    });
  });

  it('keeps the place of a version-4 reader who answered the removed carrier chooser', () => {
    expect(
      migrateOnboardingProgressV4(
        stored({
          v: 4,
          stage: 'walk',
          route: 'first-time',
          target: 'this',
          doer: 'self',
          connection: 'default-relay',
          current: 'daemon',
          furthest: 'local',
        }),
        'desktop',
      ),
    ).toEqual({
      v: 5,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'self',
      current: 'install',
      furthest: 'local',
    });
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
      v: 5,
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
      v: 5,
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
      v: 5,
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
      v: 5,
      stage: 'walk',
      route: 'first-time',
      target: 'other',
      doer: 'self',
      current: 'elsewhere',
      furthest: 'elsewhere',
    });
  });

  it('opens on the first page of the journey when the proposed page is not on it', () => {
    expect(
      resumeOnboardingRoute({ route: 'first-time', target: 'this', doer: 'agent', step: 'install' }, 'desktop'),
    ).toMatchObject({ doer: 'agent', current: 'brief', furthest: 'brief' });
    expect(resumeOnboardingRoute({ route: 'add-client', step: 'handoff' }, 'desktop')).toMatchObject({
      route: 'add-client',
      current: 'pair',
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
});

describe('OnboardingProgressStore', () => {
  it('hydrates once, publishes moves, and remembers the furthest point', () => {
    const storage = new MemoryStorage(walking('first-time', 'install'));
    const store = onDevice('desktop', { storage });
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.snapshot().stage));

    expect(store.snapshot()).toMatchObject({ stage: 'walk', current: 'install', furthest: 'install' });
    // Identity-stable between commits, so React does not re-render on a read.
    expect(store.snapshot()).toBe(store.snapshot());

    store.goTo('local');
    expect(store.snapshot()).toMatchObject({ current: 'local', furthest: 'local' });
    store.goTo('install');
    // Stepping back does NOT erase where they got to.
    expect(store.snapshot()).toMatchObject({ current: 'install', furthest: 'local' });
    expect(seen).toEqual(['walk', 'walk']);
    expect(JSON.parse(storage.writes[storage.writes.length - 1] ?? '{}')).toEqual({
      v: 5,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'self',
      current: 'install',
      furthest: 'local',
    });

    unsubscribe();
    store.goTo('handoff');
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
    store.goTo('local');
    // "Rather have an agent do it?", pressed halfway through the commands.
    expect(store.switchDoer('agent')).toEqual({
      v: 5,
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
    // about that device changes it: one page, and no other page to go to.
    for (const device of ['desktop', 'mobile'] as const) {
      const store = onDevice(device, { storage: undefined });
      store.choose('first-time');
      store.chooseDoer('agent');
      expect(store.snapshot()).toMatchObject({ doer: 'agent', current: 'brief', furthest: 'brief' });
      expect(store.goTo('install')).toMatchObject({ current: 'brief', furthest: 'brief' });
      expect(store.goTo(staleStep('agent-pair'))).toMatchObject({ current: 'brief', furthest: 'brief' });
    }
  });

  it('goes from the install page straight to the same-machine page', () => {
    // No carrier question in between: direct is tried first and the hosted relay
    // is the automatic fallback, so there is nothing for the reader to decide.
    const store = onDevice('desktop', { storage: undefined });
    store.choose('add-daemon');
    store.chooseTarget('this');
    store.chooseDoer('self');
    expect(store.snapshot()).toMatchObject({ current: 'install' });
    expect(store.goTo('local')).toMatchObject({ current: 'local', furthest: 'local' });
    expect(store.snapshot()).not.toHaveProperty('connection');
    // An add-daemon journey is not a first-time one, so it has no hand-off page.
    expect(store.goTo('handoff')).toMatchObject({ current: 'local', furthest: 'local' });
  });

  it('refuses a step that is not on this journey, rather than inventing a place', () => {
    const store = onDevice('desktop', { storage: undefined });
    // A question is up: no journey, so there is no step to be on.
    expect(store.goTo('install')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });

    store.choose('add-client');
    // `install` belongs to a daemon standing up here; a client never has it.
    expect(store.goTo('install')).toMatchObject({ route: 'add-client', current: 'pair' });
    // And the pages that were merged away are not places at all.
    for (const old of ['scan', 'done', 'agents', 'daemon', 'agent-pair']) {
      expect(store.goTo(staleStep(old))).toEqual({
        v: 5,
        stage: 'walk',
        route: 'add-client',
        current: 'pair',
        furthest: 'pair',
      });
    }
  });

  it('survives a reload by rehydrating from the same key', () => {
    const storage = new MemoryStorage();
    const first = onDevice('desktop', { storage });
    first.choose('first-time');
    first.chooseDoer('self');
    first.goTo('local');
    // A new tab, hours later, with only storage between them.
    expect(onDevice('desktop', { storage }).snapshot()).toMatchObject({ current: 'local', target: 'this' });
    expect(ONBOARDING_PROGRESS_KEY).toBe('fy-onboarding-v5');
  });

  it('lets an arrival answer the question without rewriting their history', () => {
    const storage = new MemoryStorage(walking('first-time', 'install'));
    const store = onDevice('desktop', { storage, entry: { route: 'add-client', step: 'pair' } });

    // A tab opened from a pairing link IS a client being added, whatever storage
    // remembers…
    expect(store.snapshot()).toMatchObject({ route: 'add-client', current: 'pair' });
    // …and merely opening the link wrote nothing.
    expect(storage.writes).toEqual([]);
  });

  it('does not restart a journey the arrival is already inside', () => {
    // Back on the pairing page of the pairing it is still walking: the arrival must
    // not throw them back to the start of the journey they are walking.
    const storage = new MemoryStorage(
      stored({ v: 5, stage: 'walk', route: 'add-client', current: 'pair', furthest: 'pair' }),
    );
    const store = onDevice('desktop', { storage, entry: { route: 'add-client', step: 'pair' } });
    expect(store.snapshot()).toEqual({
      v: 5,
      stage: 'walk',
      route: 'add-client',
      current: 'pair',
      furthest: 'pair',
    });
  });

  it('lets a hand-off outrank both storage and an arrival', () => {
    // Somebody stood at another device and pressed "continue on this one".
    // Nothing in storage is more recent than that deliberate act.
    const storage = new MemoryStorage(walkingAway('first-time', 'elsewhere'));
    const store = onDevice('mobile', {
      storage,
      entry: { route: 'first-time', target: 'other', doer: 'self', step: 'elsewhere' },
      handoff: { route: 'add-client', step: 'pair' },
    });
    expect(store.snapshot()).toEqual({
      v: 5,
      stage: 'walk',
      route: 'add-client',
      current: 'pair',
      furthest: 'pair',
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

describe('OnboardingProgressStore across the v4 → v5 move', () => {
  const v4Doc = v4Walking({ route: 'first-time', target: 'this', doer: 'self' }, 'daemon', 'local');

  it('resumes a half-finished version-4 setup on the page that replaced its step', () => {
    const storage = new KeyedStorage({ [ONBOARDING_PROGRESS_KEY_V4]: v4Doc });
    expect(onDevice('desktop', { storage }).snapshot()).toEqual({
      v: 5,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'self',
      current: 'install',
      furthest: 'local',
    });
  });

  it('reads version 4 only once nothing is stored for version 5, and never writes it', () => {
    const storage = new KeyedStorage({ [ONBOARDING_PROGRESS_KEY_V4]: v4Doc });
    const store = onDevice('desktop', { storage });
    store.snapshot();
    store.snapshot();
    // Hydrated once: version 5 asked first, version 4 only because it was empty.
    expect(storage.reads).toEqual([ONBOARDING_PROGRESS_KEY, ONBOARDING_PROGRESS_KEY_V4]);
    // Merely migrating wrote nothing: the arrival is a read, not a commit.
    expect(storage.writes).toEqual([]);
    expect(storage.peek(ONBOARDING_PROGRESS_KEY)).toBeNull();

    // The first move writes version 5, and only version 5.
    store.goTo('local');
    expect(storage.writes).toEqual([ONBOARDING_PROGRESS_KEY]);
    expect(storage.peek(ONBOARDING_PROGRESS_KEY_V4)).toBe(v4Doc);
    expect(JSON.parse(storage.peek(ONBOARDING_PROGRESS_KEY) ?? '{}')).toEqual({
      v: 5,
      stage: 'walk',
      route: 'first-time',
      target: 'this',
      doer: 'self',
      current: 'local',
      furthest: 'local',
    });

    // From then on version 4 is never consulted, so it cannot drag them backwards.
    const reads = storage.reads.length;
    expect(onDevice('desktop', { storage }).snapshot()).toMatchObject({ current: 'local', furthest: 'local' });
    expect(storage.reads.slice(reads)).toEqual([ONBOARDING_PROGRESS_KEY]);
  });

  it('lets a version-5 document win over a version-4 one', () => {
    const storage = new KeyedStorage({
      [ONBOARDING_PROGRESS_KEY]: walking('first-time', 'local'),
      [ONBOARDING_PROGRESS_KEY_V4]: v4Walking({ route: 'first-time', target: 'this', doer: 'self' }, 'install'),
    });
    expect(onDevice('desktop', { storage }).snapshot()).toMatchObject({ current: 'local', furthest: 'local' });
    expect(storage.reads).toEqual([ONBOARDING_PROGRESS_KEY]);
  });

  it('does not fall back to version 4 when the version-5 document is merely damaged', () => {
    // Something is stored for version 5, so this browser has moved on: damage is
    // the first question, not an invitation to resurrect an older place.
    for (const damaged of [
      'not json at all',
      stored({ v: 5, stage: 'browse' }),
      stored(walking('first-time', 'done')),
    ]) {
      const storage = new KeyedStorage({
        [ONBOARDING_PROGRESS_KEY]: damaged,
        [ONBOARDING_PROGRESS_KEY_V4]: v4Doc,
      });
      expect(onDevice('desktop', { storage }).snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
      expect(storage.reads).toEqual([ONBOARDING_PROGRESS_KEY]);
    }
  });

  it('starts fresh from a finished or damaged version-4 document, without throwing', () => {
    const first = { route: 'first-time', target: 'this', doer: 'self' } as const;
    for (const old of [
      v4Walking(first, 'done'),
      v4Walking({ route: 'add-client' }, 'done'),
      v4Walking(first, 'local', 'install'),
      '{"v":4,"stage":"walk"',
      'not json at all',
      '',
    ]) {
      const storage = new KeyedStorage({ [ONBOARDING_PROGRESS_KEY_V4]: old });
      expect(onDevice('desktop', { storage }).snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    }
  });

  it('starts fresh when there is neither generation', () => {
    const storage = new KeyedStorage();
    expect(onDevice('desktop', { storage }).snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    expect(storage.reads).toEqual([ONBOARDING_PROGRESS_KEY, ONBOARDING_PROGRESS_KEY_V4]);
    expect(storage.writes).toEqual([]);
  });

  it('migrates for the device doing the reading, not the one that wrote it', () => {
    // The same laptop document, opened on a phone: an impossibility, not a place.
    const storage = new KeyedStorage({ [ONBOARDING_PROGRESS_KEY_V4]: v4Doc });
    expect(onDevice('mobile', { storage }).snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // A phone's own version-4 journey lands where it did.
    const phone = new KeyedStorage({
      [ONBOARDING_PROGRESS_KEY_V4]: v4Walking({ route: 'first-time', target: 'other', doer: 'self' }, 'scan'),
    });
    expect(onDevice('mobile', { storage: phone }).snapshot()).toMatchObject({
      route: 'first-time',
      target: 'other',
      current: 'elsewhere',
    });
  });

  it('lets a hand-off and an arrival outrank a migrated place, as they outrank any stored one', () => {
    const storage = new KeyedStorage({ [ONBOARDING_PROGRESS_KEY_V4]: v4Doc });
    expect(onDevice('desktop', { storage, entry: { route: 'add-client', step: 'pair' } }).snapshot()).toMatchObject({
      route: 'add-client',
      current: 'pair',
    });
    expect(onDevice('desktop', { storage, handoff: { route: 'add-client', step: 'pair' } }).snapshot()).toMatchObject({
      route: 'add-client',
      current: 'pair',
    });
    expect(storage.writes).toEqual([]);
  });
});

describe('walk', () => {
  it('opens a journey on the first step that journey has', () => {
    expect(walk({ route: 'first-time', target: 'other', doer: 'self' }, 'mobile')).toEqual({
      v: 5,
      stage: 'walk',
      route: 'first-time',
      target: 'other',
      doer: 'self',
      current: 'elsewhere',
      furthest: 'elsewhere',
    });
  });

  it('opens each kind of journey on its own page', () => {
    expect(walk({ route: 'add-client' }, 'mobile')).toMatchObject({ current: 'pair', furthest: 'pair' });
    expect(walk({ route: 'first-time', target: 'this', doer: 'agent' }, 'desktop')).toMatchObject({
      current: 'brief',
      furthest: 'brief',
    });
    expect(walk({ route: 'add-daemon', target: 'this', doer: 'self' }, 'desktop')).toMatchObject({
      current: 'install',
      furthest: 'install',
    });
  });
});

describe('resetOnboardingProgress', () => {
  it('sends the next visit back to the entry question', () => {
    // "Set up another machine": every new machine is a first-time setup for that
    // machine, so the finished journey of a different host must not be resumed.
    const storage = new MemoryStorage(walking('first-time', 'handoff'));
    resetOnboardingProgress(storage);
    expect(JSON.parse(storage.writes[0] ?? '{}')).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    expect(onDevice('desktop', { storage }).snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
  });

  it('is not undone by a version-4 document left behind', () => {
    const storage = new KeyedStorage({
      [ONBOARDING_PROGRESS_KEY_V4]: v4Walking({ route: 'first-time', target: 'this', doer: 'self' }, 'local'),
    });
    resetOnboardingProgress(storage);
    expect(onDevice('desktop', { storage }).snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
  });

  it('is a no-op when there is nowhere to write, and never throws', () => {
    resetOnboardingProgress(undefined);
    resetOnboardingProgress(new HostileStorage());
  });
});

describe('startOnboardingPairing', () => {
  it('sends the next visit to the pairing page, past the question, for a browser told to pair again', () => {
    // A finished setup, then the machine stopped accepting this browser.
    const storage = new MemoryStorage(walking('first-time', 'handoff'));
    startOnboardingPairing('mobile', storage);
    expect(onDevice('mobile', { storage }).snapshot()).toEqual({
      v: 5,
      stage: 'walk',
      route: 'add-client',
      current: 'pair',
      furthest: 'pair',
    });
  });

  it('wins over a version-4 document left behind', () => {
    const storage = new KeyedStorage({
      [ONBOARDING_PROGRESS_KEY_V4]: v4Walking({ route: 'first-time', target: 'this', doer: 'self' }, 'local'),
    });
    startOnboardingPairing('desktop', storage);
    expect(onDevice('desktop', { storage }).snapshot()).toMatchObject({ route: 'add-client', current: 'pair' });
  });

  it('is a no-op when there is nowhere to write, and never throws', () => {
    startOnboardingPairing('desktop', undefined);
    startOnboardingPairing('desktop', new HostileStorage());
  });
});
