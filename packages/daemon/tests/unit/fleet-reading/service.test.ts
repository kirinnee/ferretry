/**
 * THE FLEET READING, KEPT CURRENT BY EVENTS (docs/design/housekeeping-worker.md §3).
 *
 * A fake hub, fake jobs and fake timers stand in for the file-event hub, the housekeeping worker and the
 * clock, so each case can change a file, hold a read in flight, or let a watch go quiet on cue. What must
 * hold: a passive change is ONE passive job and nothing else — never a store read, never a free read,
 * never a pass; a burst is one read in flight and one after; a store change moves its stamp on and re-reads
 * its facts; a watch that is not live, or a reading that is not current, is never trusted; and the timer is
 * armed for exactly the moment the next credential's active read falls due.
 */
import { beforeEach, describe, it } from 'bun:test';
import type { ClaudeStoreResolution, CodexStoreResolution, PassiveUsageRecord } from '@ferretry/fleet';
import should from 'should';
import type { FileSubscription } from '../../../src/lib/file-events/hub.ts';
import type { CredentialSessionRecord } from '../../../src/lib/fleet/credentials-service.ts';
import {
  FleetReading,
  type FleetReadingPorts,
  type FleetReadingSubject,
} from '../../../src/lib/fleet-reading/service.ts';
import { SESSION_ROSTER_MAX_AGE_MS, SessionRoster } from '../../../src/lib/fleet-reading/session-roster.ts';
import type { HousekeepingJob } from '../../../src/lib/housekeeping/protocol.ts';

const MINUTE = 60_000;
const NOW = 1_786_000_000_000;

const claude = (id: string): FleetReadingSubject => ({
  id,
  resolution: {
    harness: 'claude',
    store: 'ferretry',
    secureStorage: `/fleet/credentials/${id}`,
    credentialFile: `/fleet/credentials/${id}/.credentials.json`,
  } as ClaudeStoreResolution,
  usedBy: [`${id}-runtime`],
});
const codex = (id: string): FleetReadingSubject => ({
  id,
  resolution: {
    harness: 'codex',
    store: 'ferretry',
    canonicalFile: `/fleet/credentials/${id}/auth.json`,
  } as CodexStoreResolution,
  usedBy: ['codex-runtime'],
});
const reading = (at: number, usedPercent = 12): PassiveUsageRecord => ({
  version: 1,
  source: 'claude-statusline',
  at,
  fiveHour: { usedPercent },
});

/** The hub, the worker and the clock, each scripted. */
class World {
  now = NOW;
  subjects: readonly FleetReadingSubject[] = [claude('work'), codex('cx')];
  #sessions: readonly CredentialSessionRecord[] = [
    { agent: 'codex-runtime', transcript: { home: '/codex', file: '/codex/rollout-1.jsonl' } },
  ];
  /** What moves the roster's stamp: every change to the sessions, as a config write would. */
  sessionChanges = 0;
  /** How many times the roster was read. */
  rosterReads = 0;
  failRoster = false;
  get sessions(): readonly CredentialSessionRecord[] {
    return this.#sessions;
  }
  set sessions(sessions: readonly CredentialSessionRecord[]) {
    this.#sessions = sessions;
    this.sessionChanges += 1;
  }
  configFails = false;
  readonly jobs: HousekeepingJob[] = [];
  readonly passive = new Map<string, PassiveUsageRecord | null>();
  /** Jobs answered only when the test releases them. */
  hold: { promise: Promise<void>; resolve: () => void } | undefined;
  failPassive = false;
  readonly listeners = new Map<string, Set<() => void>>();
  readonly closed: string[] = [];
  readonly notLive = new Set<string>();
  readonly refreshed: string[] = [];
  refreshFails = false;
  readonly stamped: string[] = [];
  timer: { readonly callback: () => void; readonly ms: number } | undefined;
  timersArmed = 0;
  pollsFeed = false;

  ports(): FleetReadingPorts {
    return {
      credentials: async () => {
        if (this.configFails) throw new Error('unreadable');
        return this.subjects;
      },
      roster: new SessionRoster({
        stamp: () => String(this.sessionChanges),
        read: async () => {
          this.rosterReads += 1;
          if (this.failRoster) throw new Error('the index is closed');
          return this.sessions;
        },
        now: () => this.now,
        maxAgeMs: SESSION_ROSTER_MAX_AGE_MS,
      }),
      jobs: {
        run: async job => {
          this.jobs.push(job);
          if (this.hold !== undefined) await this.hold.promise;
          if (job.kind === 'usage.passive.claude') {
            if (this.failPassive) throw new Error('the worker stopped');
            return (this.passive.get(job.credential) ?? null) as never;
          }
          if (job.kind === 'usage.passive.codex') return (this.passive.get('cx') ?? null) as never;
          throw new Error(`no ${job.kind} job may be sent by the reading`);
        },
      },
      watch: (path, listener): FileSubscription => {
        const set = this.listeners.get(path) ?? new Set();
        set.add(listener);
        this.listeners.set(path, set);
        return {
          live: () => !this.notLive.has(path),
          close: () => {
            set.delete(listener);
            this.closed.push(path);
          },
        };
      },
      passiveFile: id => `/fleet/credentials/${id}/usage.json`,
      refreshLocal: async resolution => {
        this.refreshed.push(resolution.harness === 'claude' ? resolution.credentialFile : resolution.canonicalFile);
        if (this.hold !== undefined) await this.hold.promise;
        if (this.refreshFails) throw new Error('unreadable store');
      },
      stamp: async path => {
        this.stamped.push(path);
        return `stat:${path}`;
      },
      now: () => this.now,
      intervalMs: () => MINUTE,
      pollsFeed: () => this.pollsFeed,
      timers: {
        setTimeout: (callback, ms) => {
          this.timersArmed += 1;
          this.timer = { callback, ms };
          return this.timer;
        },
        clearTimeout: handle => {
          if (this.timer === handle) this.timer = undefined;
        },
      },
    };
  }

  change(path: string): void {
    for (const listener of [...(this.listeners.get(path) ?? [])]) listener();
  }

  holdJobs(): void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.hold = { promise, resolve };
  }

  release(): void {
    this.hold?.resolve();
    this.hold = undefined;
  }

  kinds(): string[] {
    return this.jobs.map(job => job.kind);
  }
}

/** Lets every pending job and listener settle. */
const settle = async (): Promise<void> => {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
};

let world: World;
beforeEach(() => {
  world = new World();
});

describe('FleetReading', () => {
  it('should watch each store, statusLine and attributed rollout, and read each passive reading once', async () => {
    // Arrange
    world.passive.set('work', reading(NOW - 1_000));
    const subject = new FleetReading(world.ports());

    // Act
    await subject.start(() => undefined);
    await settle();
    const work = await subject.passiveUsage({ id: 'work', resolution: claude('work').resolution });
    const cx = await subject.passiveUsage({ id: 'cx', resolution: codex('cx').resolution });

    // Assert — one read each to start, and the status service's asks cost nothing more.
    should([...world.listeners.keys()].sort()).deepEqual([
      '/codex/rollout-1.jsonl',
      '/fleet/credentials/cx/auth.json',
      '/fleet/credentials/work/.credentials.json',
      '/fleet/credentials/work/usage.json',
    ]);
    should(world.kinds()).deepEqual(['usage.passive.claude', 'usage.passive.codex']);
    should(work).deepEqual(reading(NOW - 1_000));
    should(cx).be.undefined();
  });

  it('should answer a statusLine change with ONE passive job and nothing else, and hold the read off', async () => {
    // Arrange
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);
    await settle();
    world.jobs.length = 0;
    world.now = NOW + 5_000;
    world.passive.set('work', reading(NOW + 5_000));

    // Act — `fy statusline` renamed a new `usage.json` into place.
    world.change('/fleet/credentials/work/usage.json');
    await settle();

    // Assert — no store read, no free read, no pass: and `work` is not due for a whole interval, while
    // `cx`, never observed and with no passive reading, is.
    should(world.kinds()).deepEqual(['usage.passive.claude']);
    should(world.refreshed).deepEqual([]);
    should(subject.due()).deepEqual(['cx']);
    world.now = NOW + 5_000 + MINUTE - 1;
    should(subject.due()).deepEqual(['cx']);
    world.now = NOW + 5_000 + MINUTE;
    should(subject.due()).deepEqual(['work', 'cx']);
  });

  it('should coalesce a burst of changes into one read in flight and one after it', async () => {
    // Arrange
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);
    await settle();
    world.jobs.length = 0;
    world.holdJobs();

    // Act
    for (let write = 0; write < 5; write += 1) world.change('/fleet/credentials/work/usage.json');
    await settle();
    const whileHeld = world.kinds().length;
    world.release();
    await settle();

    // Assert
    should(whileHeld).equal(1);
    should(world.kinds()).deepEqual(['usage.passive.claude', 'usage.passive.claude']);
  });

  it('should read directly while a watch is not live, before its first read is done, and after one failed', async () => {
    // Arrange
    world.passive.set('work', reading(NOW));
    world.holdJobs();
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);
    const resolution = claude('work').resolution;

    // Act
    const beforeFirst = subject.passiveUsage({ id: 'work', resolution });
    world.release();
    await beforeFirst;
    await settle();
    const live = world.kinds().length;
    await subject.passiveUsage({ id: 'work', resolution });
    const fromWatch = world.kinds().length;
    world.notLive.add('/fleet/credentials/work/usage.json');
    await subject.passiveUsage({ id: 'work', resolution });
    const polled = world.kinds().length;
    world.notLive.clear();
    world.failPassive = true;
    world.change('/fleet/credentials/work/usage.json');
    await settle();
    world.failPassive = false;
    await subject.passiveUsage({ id: 'work', resolution });

    // Assert — every untrusted moment cost exactly one direct read.
    should([live, fromWatch, polled]).deepEqual([3, 3, 4]);
    should(world.kinds().length).equal(6);
  });

  it('should read a credential it does not watch directly, as a pass always did', async () => {
    // Arrange
    world.subjects = [];
    world.passive.set('stranger', reading(NOW));
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);

    // Act
    const claudeAnswer = await subject.passiveUsage({ id: 'stranger', resolution: claude('stranger').resolution });
    const codexAnswer = await subject.passiveUsage({ id: 'unknown-cx', resolution: codex('unknown-cx').resolution });

    // Assert — an unknown Codex login has no attributed rollouts, so nothing to read.
    should(claudeAnswer).deepEqual(reading(NOW));
    should(codexAnswer).be.undefined();
    should(world.kinds()).deepEqual(['usage.passive.claude']);
  });

  it('should follow a Codex credential’s rollouts as sessions come and go', async () => {
    // Arrange
    world.passive.set('cx', { ...reading(NOW), source: 'codex-rollout' });
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);
    await settle();
    const resolution = codex('cx').resolution;

    // Act — a second session starts on the runtime; then every session is gone.
    world.sessions = [
      ...world.sessions,
      { agent: 'codex-runtime', transcript: { home: '/codex', file: '/codex/rollout-2.jsonl' } },
    ];
    await subject.passiveUsage({ id: 'cx', resolution });
    await settle();
    const watchedTwo = [...world.listeners].filter(([path, set]) => path.includes('rollout') && set.size > 0).length;
    world.sessions = [];
    const none = await subject.passiveUsage({ id: 'cx', resolution });

    // Assert
    should(watchedTwo).equal(2);
    should(world.closed).containDeep(['/codex/rollout-1.jsonl', '/codex/rollout-2.jsonl']);
    should(none).be.undefined();
  });

  it('should read the session roster ONCE per generation for seven Codex logins over 500 sessions, not once per login', async () => {
    // Arrange — seven Codex logins, each on its own runtime, and 500 sessions spread across them.
    const logins = Array.from({ length: 7 }, (_, index) => ({ ...codex(`cx${index}`), usedBy: [`runtime-${index}`] }));
    world.subjects = logins;
    world.sessions = Array.from({ length: 500 }, (_, index) => ({
      agent: `runtime-${index % 7}`,
      transcript: { home: '/codex', file: `/codex/rollout-${index}.jsonl` },
    }));
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);
    await settle();
    const bootReads = world.rosterReads;
    const watches = world.listeners.size;
    world.jobs.length = 0;

    // Act — three credentials lists in a row, each asking every login in turn.
    for (let list = 0; list < 3; list += 1)
      for (const login of logins) await subject.passiveUsage({ id: login.id, resolution: login.resolution });
    await settle();
    const quietReads = world.rosterReads;
    // A config changes: one more read for the next list, however many logins ask.
    world.sessions = [
      ...world.sessions,
      { agent: 'runtime-3', transcript: { home: '/codex', file: '/codex/rollout-new.jsonl' } },
    ];
    for (const login of logins) await subject.passiveUsage({ id: login.id, resolution: login.resolution });
    await settle();

    // Assert — the boot read is shared by all seven, the quiet lists read nothing and open nothing, and the
    // change is one read that re-derives only the login whose rollouts moved.
    should(bootReads).equal(1);
    should(quietReads).equal(1);
    should(world.listeners.size).equal(watches + 1);
    should(world.rosterReads).equal(2);
    should(world.listeners.has('/codex/rollout-new.jsonl')).be.true();
    should(world.jobs.length).be.above(0);
    should(
      world.jobs.every(job => job.kind === 'usage.passive.codex' && job.files.includes('/codex/rollout-new.jsonl')),
    ).be.true();
  });

  it('should read the roster again once it is too old, even though no config changed', async () => {
    // Arrange
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);
    await settle();
    const resolution = codex('cx').resolution;

    // Act
    world.now = NOW + SESSION_ROSTER_MAX_AGE_MS - 1;
    await subject.passiveUsage({ id: 'cx', resolution });
    const young = world.rosterReads;
    world.now = NOW + SESSION_ROSTER_MAX_AGE_MS;
    await subject.passiveUsage({ id: 'cx', resolution });

    // Assert — a change no stamp sees (an edit by hand) is read within the bound.
    should(young).equal(1);
    should(world.rosterReads).equal(2);
  });

  it('should attribute no rollouts while the roster cannot be read, and not keep the failure', async () => {
    // Arrange
    world.failRoster = true;
    world.passive.set('cx', { ...reading(NOW), source: 'codex-rollout' });
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);
    await settle();
    const resolution = codex('cx').resolution;

    // Act
    const failed = await subject.passiveUsage({ id: 'cx', resolution });
    const watchedWhileFailing = world.listeners.has('/codex/rollout-1.jsonl');
    world.failRoster = false;
    await subject.passiveUsage({ id: 'cx', resolution });
    await settle();
    const recovered = await subject.passiveUsage({ id: 'cx', resolution });

    // Assert — the next ask reads again with no change to prompt it, and the rollout is followed.
    should(failed).be.undefined();
    should(watchedWhileFailing).be.false();
    should(world.listeners.has('/codex/rollout-1.jsonl')).be.true();
    should(recovered).deepEqual({ ...reading(NOW), source: 'codex-rollout' });
  });

  it('should re-derive a login’s rollouts when its runtimes change, and forget a removed login', async () => {
    // Arrange
    world.sessions = [
      { agent: 'codex-runtime', transcript: { home: '/codex', file: '/codex/rollout-1.jsonl' } },
      { agent: 'other-runtime', transcript: { home: '/codex', file: '/codex/rollout-9.jsonl' } },
    ];
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);
    await settle();

    // Act — the configuration moves `cx` onto the other runtime, then drops it.
    world.subjects = [claude('work'), { ...codex('cx'), usedBy: ['other-runtime'] }];
    await subject.configLoaded();
    await settle();
    const moved = world.listeners.get('/codex/rollout-9.jsonl')?.size;
    world.subjects = [claude('work')];
    await subject.configLoaded();
    const gone = await subject.passiveUsage({ id: 'cx', resolution: codex('cx').resolution });

    // Assert — one roster read served all of it.
    should(moved).equal(1);
    should(world.closed).containDeep(['/codex/rollout-1.jsonl', '/codex/rollout-9.jsonl']);
    should(gone).be.undefined();
    should(world.rosterReads).equal(1);
  });

  it('should answer a watched store’s stamp from its change count, and re-read its facts on each change', async () => {
    // Arrange
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);
    const store = '/fleet/credentials/work/.credentials.json';

    // Act
    const before = await subject.stamp(store);
    world.change(store);
    await settle();
    const after = await subject.stamp(store);
    world.notLive.add(store);
    const polled = await subject.stamp(store);
    const unwatched = await subject.stamp('/elsewhere/.credentials.json');

    // Assert — no system call while the watch is live.
    should([before, after]).deepEqual(['watched:0', 'watched:1']);
    should(world.refreshed).deepEqual([store]);
    should([polled, unwatched]).deepEqual([`stat:${store}`, 'stat:/elsewhere/.credentials.json']);
    should(world.stamped).deepEqual([store, '/elsewhere/.credentials.json']);
  });

  it('should re-read a store once more when it changes again mid-read, and survive a read that fails', async () => {
    // Arrange
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);
    const store = '/fleet/credentials/cx/auth.json';
    world.holdJobs();

    // Act
    world.change(store);
    world.change(store);
    world.change(store);
    world.release();
    await settle();
    world.refreshFails = true;
    world.change(store);
    await settle();

    // Assert
    should(world.refreshed).deepEqual([store, store, store]);
    should(await subject.stamp(store)).equal('watched:4');
  });

  it('should arm the timer for the earliest due credential, at once for one never observed', async () => {
    // Arrange
    const due: number[] = [];
    world.passive.set('work', reading(NOW - 10_000));
    const subject = new FleetReading(world.ports());

    // Act
    await subject.start(() => due.push(world.now));
    const first = world.timer?.ms;
    await settle();
    world.timer?.callback();
    subject.observed(['work', 'cx']);
    const afterPass = world.timer?.ms;

    // Assert — after the pass every credential is next due one interval on, as a fixed timer had it.
    should(first).equal(0);
    should(due).deepEqual([NOW]);
    should(afterPass).equal(MINUTE);
  });

  it('should close the watches of a credential the configuration no longer names, and keep all on a bad load', async () => {
    // Arrange
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);
    await settle();

    // Act
    world.configFails = true;
    await subject.configLoaded();
    const keptOnFailure = [...world.closed];
    world.configFails = false;
    world.subjects = [claude('work')];
    await subject.configLoaded();

    // Assert
    should(keptOnFailure).deepEqual([]);
    should(world.closed.sort()).deepEqual(['/codex/rollout-1.jsonl', '/fleet/credentials/cx/auth.json']);
    should(subject.due()).deepEqual(['work']);
  });

  it('should drop a passive answer that lands after its watch was replaced', async () => {
    // Arrange
    world.holdJobs();
    world.passive.set('work', reading(NOW));
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);

    // Act — the configuration drops the credential while its first read is in flight.
    world.subjects = [];
    await subject.configLoaded();
    world.release();
    await settle();

    // Assert — only the boot pass is left to run.
    should(subject.due()).deepEqual([]);
    should(world.timer?.ms).equal(0);
  });

  it('should run the boot pass with no credential, and then nothing unless the feed is polled', async () => {
    // Arrange
    world.subjects = [];
    const subject = new FleetReading(world.ports());

    // Act
    await subject.start(() => undefined);
    const boot = world.timer?.ms;
    subject.observed([]);
    const quiet = world.timer;
    world.pollsFeed = true;
    subject.observed([]);
    const polled = world.timer?.ms;

    // Assert — an external collector keeps a pass every interval, as the fixed timer had it.
    should(boot).equal(0);
    should(quiet).be.undefined();
    should(polled).equal(MINUTE);
  });

  it('should close every watch and the timer, and stay closed', async () => {
    // Arrange
    const subject = new FleetReading(world.ports());
    await subject.start(() => undefined);
    await settle();

    // Act
    subject.close();
    const armed = world.timersArmed;
    await subject.configLoaded();
    subject.observed(['work']);

    // Assert
    should(world.timer).be.undefined();
    should(world.timersArmed).equal(armed);
    should([...world.listeners.values()].every(set => set.size === 0)).be.true();
  });
});
