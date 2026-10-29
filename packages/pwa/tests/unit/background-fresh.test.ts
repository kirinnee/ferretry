import { describe, it } from 'bun:test';
import should from 'should';
import { FyHttpError } from '@ferretry/protocol/client';
import type { SessionView } from '@ferretry/protocol';

import {
  BACKGROUND_FRESH_LIMITS,
  type BackgroundFreshEnvironment,
  type BackgroundFreshSettings,
  BackgroundChatFreshener,
  backgroundFreshSessions,
  browserBackgroundFreshEnvironment,
  transcriptIsCurrent,
} from '../../src/lib/background-fresh.ts';
import { daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { DaemonFleetSlice, FleetSnapshot } from '../../src/lib/fleet-store.ts';
import { SESSION_CACHE_LIMITS, SessionCache, type SessionCacheBackend } from '../../src/lib/session-cache.ts';
import { schemaValidSessionView } from '../support/schema-valid-sessions.ts';

const alpha = daemonId('alpha');
const alphaConnection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 't' });
const scopeOf = (sessionId: string) => daemonSessionScope({ daemonId: alpha }, sessionId);

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn += 1) await new Promise<void>(resolve => setTimeout(resolve, 0));
};

const view = (id: string, mode: 'auto' | 'interactive', journalSequence?: number): SessionView => {
  const base = schemaValidSessionView(id);
  return { ...base, config: { ...base.config, mode }, ...(journalSequence === undefined ? {} : { journalSequence }) };
};

class MemoryBackend implements SessionCacheBackend {
  readonly records = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.records.get(key);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.records.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }
  async keys(): Promise<readonly string[]> {
    return [...this.records.keys()];
  }
  async clear(): Promise<void> {
    this.records.clear();
  }
}

class FakeFleet {
  #sessions: readonly SessionView[] = [];
  readonly #listeners = new Set<() => void>();
  #snapshot: FleetSnapshot = { daemons: new Map() };
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): FleetSnapshot => this.#snapshot;
  set(sessions: readonly SessionView[]): void {
    this.#sessions = sessions;
    const byId = new Map(sessions.map(session => [session.config.id, session]));
    const slice = { sessions, byId, status: 'ready', error: null } as unknown as DaemonFleetSlice;
    this.#snapshot = { daemons: new Map([[alpha, slice]]) };
    for (const listener of [...this.#listeners]) listener();
  }
  bump(id: string): void {
    this.set(
      this.#sessions.map(session =>
        session.config.id === id ? { ...session, journalSequence: (session.journalSequence ?? 0) + 1 } : session,
      ),
    );
  }
}

class Clock {
  now = 1_000_000;
  #timers: { id: number; at: number; callback: () => void }[] = [];
  #next = 0;
  readonly setTimeout = (callback: () => void, milliseconds: number): unknown => {
    this.#next += 1;
    this.#timers.push({ id: this.#next, at: this.now + milliseconds, callback });
    return this.#next;
  };
  readonly clearTimeout = (handle: unknown): void => {
    this.#timers = this.#timers.filter(timer => timer.id !== handle);
  };
  async advance(milliseconds: number): Promise<void> {
    const target = this.now + milliseconds;
    for (;;) {
      const due = this.#timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.#timers = this.#timers.filter(timer => timer.id !== due.id);
      this.now = Math.max(this.now, due.at);
      due.callback();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

interface Rig {
  readonly fleet: FakeFleet;
  readonly clock: Clock;
  readonly cache: SessionCache;
  readonly backend: MemoryBackend;
  readonly freshener: BackgroundChatFreshener;
  readonly reads: string[];
  readonly page: { visible: boolean; constrained: boolean; cellular: boolean };
  readonly settings: { value: BackgroundFreshSettings };
  wake(): void;
  notifySettings(): void;
  readLog: { impl: (sessionId: string) => Promise<string> };
}

const rig = (): Rig => {
  const fleet = new FakeFleet();
  const clock = new Clock();
  const backend = new MemoryBackend();
  let tick = 0;
  const cache = new SessionCache(backend, { now: () => (tick += 1) });
  const reads: string[] = [];
  const page = { visible: true, constrained: false, cellular: false };
  const wakeListeners = new Set<() => void>();
  const settingListeners = new Set<() => void>();
  const settings = { value: { enabled: true, notOnCellular: false } as BackgroundFreshSettings };
  const readLog = { impl: async (sessionId: string): Promise<string> => `log of ${sessionId}` };
  const environment: BackgroundFreshEnvironment = {
    visible: () => page.visible,
    constrained: () => page.constrained,
    cellular: () => page.cellular,
    onWake: listener => {
      wakeListeners.add(listener);
      return () => wakeListeners.delete(listener);
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: () => clock.now,
  };
  const freshener = new BackgroundChatFreshener({
    fleet,
    cache,
    connections: () => [alphaConnection],
    readLog: async (_daemon, sessionId) => {
      reads.push(sessionId);
      return await readLog.impl(sessionId);
    },
    settings: {
      get: () => settings.value,
      subscribe: listener => {
        settingListeners.add(listener);
        return () => settingListeners.delete(listener);
      },
    },
    environment,
  });
  return {
    fleet,
    clock,
    cache,
    backend,
    freshener,
    reads,
    page,
    settings,
    wake: () => {
      for (const listener of [...wakeListeners]) listener();
    },
    notifySettings: () => {
      for (const listener of [...settingListeners]) listener();
    },
    readLog,
  };
};

/** Opens a chat the way the app does: a foreground save, which also ranks it among the most recently opened. */
const openChat = (subject: Rig, sessionId: string): void => {
  subject.cache.saveTranscript(scopeOf(sessionId), { log: `opened ${sessionId}` }, subject.cache.generation(alpha));
};

const SETTLE = BACKGROUND_FRESH_LIMITS.debounceMs + 1;

describe('backgroundFreshSessions', () => {
  it('is the interactive sessions plus the recently opened ones, and nothing else', () => {
    const sessions = [
      view('i1', 'interactive'),
      view('a-open', 'auto'),
      view('a-other', 'auto'),
      view('i-open', 'interactive'),
    ];
    const opened = new Set(['a-open', 'i-open']);

    const actual = backgroundFreshSessions(sessions, id => opened.has(id)).map(session => session.config.id);

    should(actual).eql(['i1', 'a-open', 'i-open']);
  });
});

describe('transcriptIsCurrent', () => {
  it('holds only when the cache saw the session at exactly its journal position', () => {
    should(transcriptIsCurrent({ cursor: 5 }, view('s', 'auto', 5))).be.true();
    should(transcriptIsCurrent({ cursor: 4 }, view('s', 'auto', 5))).be.false();
    should(transcriptIsCurrent({ cursor: undefined }, view('s', 'auto', 5))).be.false();
    should(transcriptIsCurrent({ cursor: 5 }, view('s', 'auto'))).be.false();
    should(transcriptIsCurrent(undefined, view('s', 'auto', 5))).be.false();
    should(transcriptIsCurrent({ cursor: 5 }, undefined)).be.false();
  });
});

describe('BackgroundChatFreshener', () => {
  it('reads exactly the interactive sessions and the 40 most recently opened, and nothing else', async () => {
    const subject = rig();
    const opened = Array.from({ length: SESSION_CACHE_LIMITS.transcripts + 2 }, (_, index) => `opened-${index}`);
    for (const id of opened) openChat(subject, id);
    const sessions = [
      ...opened.map(id => view(id, 'auto', 1)),
      view('talk-1', 'interactive', 1),
      view('talk-2', 'interactive', 1),
      view('never-opened', 'auto', 1),
    ];
    subject.fleet.set(sessions);
    subject.freshener.start();
    await flush();

    for (let step = 0; step < 60; step += 1) await subject.clock.advance(SETTLE);

    const expected = [...opened.slice(2), 'talk-1', 'talk-2'].sort();
    should([...new Set(subject.reads)].sort()).eql(expected);
    should(subject.reads).have.length(expected.length);
    should(subject.reads).not.containEql('never-opened');
    should(subject.reads).not.containEql('opened-0');
    should(subject.reads).not.containEql('opened-1');
  });

  it('keeps the background class to the interactive sessions, dropping what is no longer interactive', async () => {
    const subject = rig();
    subject.fleet.set([view('talk', 'interactive', 1)]);
    subject.freshener.start();
    await flush();
    await subject.clock.advance(SETTLE);
    should(subject.cache.peekTranscript(scopeOf('talk'))).not.be.undefined();

    subject.fleet.set([view('talk', 'auto', 2)]);
    await flush();

    should(subject.cache.peekTranscript(scopeOf('talk'))).be.undefined();
    should([...subject.backend.records.keys()]).have.length(0);
  });

  it('saves what it read into memory and storage, tagged with the cursor it was read at, without counting as opened', async () => {
    const subject = rig();
    subject.fleet.set([view('talk', 'interactive', 7)]);
    subject.freshener.start();
    await flush();

    await subject.clock.advance(SETTLE);

    should(subject.cache.peekTranscript(scopeOf('talk'))).containEql({ log: 'log of talk', cursor: 7 });
    should([...subject.backend.records.keys()]).have.length(1);
    should(subject.cache.isRecentlyOpened(scopeOf('talk'))).be.false();
  });

  it('does not read a session whose cache is already at its journal position', async () => {
    const subject = rig();
    subject.cache.saveBackgroundTranscript(scopeOf('talk'), { log: 'cached' }, 9, subject.cache.generation(alpha));
    subject.fleet.set([view('talk', 'interactive', 9)]);
    subject.freshener.start();
    await flush();

    await subject.clock.advance(SETTLE);

    should(subject.reads).eql([]);
  });

  it('reads only on a change of cursor, never on a list update that left it alone', async () => {
    const subject = rig();
    subject.fleet.set([view('talk', 'interactive', 1)]);
    subject.freshener.start();
    await flush();
    await subject.clock.advance(SETTLE);
    should(subject.reads).have.length(1);

    subject.fleet.set([view('talk', 'interactive', 1)]);
    subject.fleet.set([view('talk', 'interactive', 1)]);
    await subject.clock.advance(60_000);
    should(subject.reads).have.length(1);

    subject.fleet.bump('talk');
    await subject.clock.advance(60_000);
    should(subject.reads).have.length(2);
    should(subject.cache.peekTranscript(scopeOf('talk'))).containEql({ cursor: 2 });
  });

  it('coalesces a burst of changes to one session into one read', async () => {
    const subject = rig();
    subject.fleet.set([view('talk', 'interactive', 1)]);
    subject.freshener.start();
    await flush();
    await subject.clock.advance(SETTLE);
    subject.reads.length = 0;

    for (let change = 0; change < 8; change += 1) {
      subject.fleet.bump('talk');
      await subject.clock.advance(300);
    }
    await subject.clock.advance(60_000);

    should(subject.reads).have.length(1);
    should(subject.cache.peekTranscript(scopeOf('talk'))).containEql({ cursor: 9 });
  });

  it('reads a continuously changing session at most once per minimum gap', async () => {
    const subject = rig();
    subject.fleet.set([view('talk', 'interactive', 1)]);
    subject.freshener.start();
    await flush();
    subject.reads.length = 0;

    for (let second = 0; second < 120; second += 1) {
      subject.fleet.bump('talk');
      await subject.clock.advance(1_000);
    }

    should(subject.reads.length).be.belowOrEqual(Math.ceil(120_000 / BACKGROUND_FRESH_LIMITS.minGapMs) + 1);
    should(subject.reads.length).be.aboveOrEqual(4);
  });

  it('never has more reads in flight than the concurrency cap', async () => {
    const subject = rig();
    let inFlight = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    subject.readLog.impl = async id => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>(resolve => gates.push(resolve));
      inFlight -= 1;
      return `log of ${id}`;
    };
    subject.fleet.set(Array.from({ length: 6 }, (_, index) => view(`talk-${index}`, 'interactive', 1)));
    subject.freshener.start();
    await flush();

    await subject.clock.advance(SETTLE);
    should(peak).equal(BACKGROUND_FRESH_LIMITS.concurrency);
    for (let round = 0; round < 10; round += 1) {
      for (const release of gates.splice(0)) release();
      await flush();
    }

    should(subject.reads).have.length(6);
    should(peak).equal(BACKGROUND_FRESH_LIMITS.concurrency);
  });

  it('reads nothing while the tab is hidden, then catches up on the change when it is shown', async () => {
    const subject = rig();
    subject.page.visible = false;
    subject.fleet.set([view('talk', 'interactive', 1)]);
    subject.freshener.start();
    await flush();

    subject.fleet.bump('talk');
    await subject.clock.advance(120_000);
    should(subject.reads).eql([]);

    subject.page.visible = true;
    subject.wake();
    await subject.clock.advance(SETTLE);
    should(subject.reads).eql(['talk']);
    should(subject.cache.peekTranscript(scopeOf('talk'))).containEql({ cursor: 2 });
  });

  it('drops a read that was waiting when the tab was hidden', async () => {
    const subject = rig();
    subject.fleet.set([view('talk', 'interactive', 1)]);
    subject.freshener.start();
    await flush();

    subject.page.visible = false;
    subject.wake();
    await subject.clock.advance(60_000);

    should(subject.reads).eql([]);
  });

  it.each([['the browser asks to save data or the link is slow', (page: Rig['page']) => (page.constrained = true)]])(
    'pauses when %s, and resumes when it clears',
    async (_name, constrain) => {
      const subject = rig();
      constrain(subject.page);
      subject.fleet.set([view('talk', 'interactive', 1)]);
      subject.freshener.start();
      await flush();
      await subject.clock.advance(60_000);
      should(subject.reads).eql([]);

      subject.page.constrained = false;
      subject.wake();
      await subject.clock.advance(SETTLE);

      should(subject.reads).eql(['talk']);
    },
  );

  it('pauses on a cellular link only when "not on cellular" is chosen', async () => {
    const subject = rig();
    subject.page.cellular = true;
    subject.fleet.set([view('talk', 'interactive', 1)]);
    subject.freshener.start();
    await flush();
    await subject.clock.advance(SETTLE);
    should(subject.reads).eql(['talk']);

    subject.settings.value = { enabled: true, notOnCellular: true };
    subject.notifySettings();
    subject.fleet.bump('talk');
    await subject.clock.advance(120_000);
    should(subject.reads).eql(['talk']);

    subject.page.cellular = false;
    subject.wake();
    await subject.clock.advance(SETTLE + BACKGROUND_FRESH_LIMITS.minGapMs);
    should(subject.reads).eql(['talk', 'talk']);
  });

  it('reads nothing at all while the setting is off', async () => {
    const subject = rig();
    subject.settings.value = { enabled: false, notOnCellular: false };
    subject.fleet.set([view('talk', 'interactive', 1)]);
    subject.freshener.start();
    await flush();

    subject.fleet.bump('talk');
    await subject.clock.advance(120_000);

    should(subject.reads).eql([]);
  });

  it('does not read the chat on screen, and resumes once it is closed', async () => {
    const subject = rig();
    subject.fleet.set([view('talk', 'interactive', 1)]);
    subject.freshener.start();
    await flush();
    subject.freshener.setOpen(scopeOf('talk'));

    subject.fleet.bump('talk');
    await subject.clock.advance(120_000);
    should(subject.reads).eql([]);

    subject.freshener.setOpen(null);
    await subject.clock.advance(SETTLE);
    should(subject.reads).eql(['talk']);
  });

  it('does not ask again after a refusal, but retries after an ordinary failure', async () => {
    const subject = rig();
    subject.fleet.set([view('denied', 'interactive', 1), view('flaky', 'interactive', 1)]);
    let flaky = 0;
    subject.readLog.impl = async id => {
      if (id === 'denied') throw new FyHttpError('forbidden', 403, 'forbidden');
      flaky += 1;
      if (flaky === 1) throw new Error('outage');
      return `log of ${id}`;
    };
    subject.freshener.start();
    await flush();
    await subject.clock.advance(SETTLE);

    subject.fleet.bump('denied');
    subject.fleet.bump('flaky');
    await subject.clock.advance(60_000);

    should(subject.reads.filter(id => id === 'denied')).have.length(1);
    should(subject.reads.filter(id => id === 'flaky')).have.length(2);
    should(subject.cache.peekTranscript(scopeOf('flaky'))).containEql({ log: 'log of flaky' });
    should(subject.cache.peekTranscript(scopeOf('denied'))).be.undefined();
  });

  it('writes nothing for a machine that was unpaired while the read was in flight', async () => {
    const subject = rig();
    let release: () => void = () => undefined;
    subject.readLog.impl = async id => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
      return `log of ${id}`;
    };
    subject.fleet.set([view('talk', 'interactive', 1)]);
    subject.freshener.start();
    await flush();
    await subject.clock.advance(SETTLE);
    should(subject.freshener.isCatchingUp(scopeOf('talk'))).be.true();

    subject.cache.clearDaemon(alpha);
    release();
    await flush();

    should(subject.cache.peekTranscript(scopeOf('talk'))).be.undefined();
    should([...subject.backend.records.keys()]).have.length(0);
    should(subject.freshener.isCatchingUp(scopeOf('talk'))).be.false();
  });

  it('writes nothing once stopped, even for a read already in flight', async () => {
    const subject = rig();
    let release: () => void = () => undefined;
    subject.readLog.impl = async id => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
      return `log of ${id}`;
    };
    subject.fleet.set([view('talk', 'interactive', 1)]);
    const stop = subject.freshener.start();
    await flush();
    await subject.clock.advance(SETTLE);

    stop();
    release();
    await flush();

    should(subject.cache.peekTranscript(scopeOf('talk'))).be.undefined();
  });

  it('says a session is catching up only while its read is in flight', async () => {
    const subject = rig();
    let release: () => void = () => undefined;
    subject.readLog.impl = async id => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
      return `log of ${id}`;
    };
    const heard: number[] = [];
    subject.freshener.subscribe(() => heard.push(subject.freshener.getSnapshot().size));
    subject.fleet.set([view('talk', 'interactive', 1)]);
    subject.freshener.start();
    await flush();
    should(subject.freshener.isCatchingUp(scopeOf('talk'))).be.false();

    await subject.clock.advance(SETTLE);
    should(subject.freshener.isCatchingUp(scopeOf('talk'))).be.true();
    release();
    await flush();

    should(subject.freshener.isCatchingUp(scopeOf('talk'))).be.false();
    should(heard).eql([1, 0]);
  });

  it('shows a switched-to chat as current straight away when the background kept it fresh', async () => {
    const subject = rig();
    subject.fleet.set([view('talk', 'interactive', 3)]);
    subject.freshener.start();
    await flush();
    await subject.clock.advance(SETTLE);

    const current = subject.cache.peekTranscript(scopeOf('talk'));
    should(transcriptIsCurrent(current, view('talk', 'interactive', 3))).be.true();
    should(transcriptIsCurrent(current, view('talk', 'interactive', 4))).be.false();
    should(current?.log).equal('log of talk');
  });

  it('counts the requests per minute for 20 busy ferrets, within the cap the limits allow', async () => {
    const subject = rig();
    const ferrets = Array.from({ length: 20 }, (_, index) => `busy-${index}`);
    for (const id of ferrets) openChat(subject, id);
    subject.fleet.set(ferrets.map(id => view(id, 'auto', 1)));
    subject.freshener.start();
    await flush();
    await subject.clock.advance(SETTLE);
    subject.reads.length = 0;

    // Every ferret journals a change every second for a full minute: the worst case a busy fleet can offer.
    for (let second = 0; second < 60; second += 1) {
      for (const id of ferrets) subject.fleet.bump(id);
      await subject.clock.advance(1_000);
    }

    const perMinute = subject.reads.length;
    const ceiling = ferrets.length * Math.ceil(60_000 / BACKGROUND_FRESH_LIMITS.minGapMs);
    should(perMinute).be.belowOrEqual(ceiling);
    should(perMinute).equal(60);
    should(perMinute).be.aboveOrEqual(ferrets.length);
  });
});

describe('browserBackgroundFreshEnvironment', () => {
  const listeners = () => {
    const added: string[] = [];
    const removed: string[] = [];
    return {
      added,
      removed,
      target: {
        addEventListener: (type: string) => added.push(type),
        removeEventListener: (type: string) => removed.push(type),
      },
    };
  };

  it('reads visibility, save-data, a slow link and a cellular link from the page', () => {
    const doc = listeners();
    const connection = { ...listeners().target, saveData: false, effectiveType: '4g', type: 'wifi' };
    const globals = {
      document: { ...doc.target, visibilityState: 'visible' as DocumentVisibilityState },
      navigator: { connection },
    };
    const environment = browserBackgroundFreshEnvironment(globals as never);
    should(environment.visible()).be.true();
    should(environment.constrained()).be.false();
    should(environment.cellular()).be.false();

    const constrained = browserBackgroundFreshEnvironment({
      document: { ...doc.target, visibilityState: 'hidden' as DocumentVisibilityState },
      navigator: { connection: { ...connection, saveData: true, type: 'cellular' } },
    } as never);
    should(constrained.visible()).be.false();
    should(constrained.constrained()).be.true();
    should(constrained.cellular()).be.true();

    for (const effectiveType of ['2g', 'slow-2g'])
      should(
        browserBackgroundFreshEnvironment({
          navigator: { connection: { ...connection, effectiveType } },
        } as never).constrained(),
      ).be.true();
  });

  it('copes with a browser that offers no connection API', () => {
    const environment = browserBackgroundFreshEnvironment({} as never);
    should(environment.visible()).be.true();
    should(environment.constrained()).be.false();
    should(environment.cellular()).be.false();
    environment.onWake(() => undefined)();
  });

  it('listens for visibility and link changes, and stops', () => {
    const doc = listeners();
    const link = listeners();
    const environment = browserBackgroundFreshEnvironment({
      document: { ...doc.target, visibilityState: 'visible' },
      navigator: { connection: link.target },
    } as never);

    const stop = environment.onWake(() => undefined);
    stop();

    should(doc.added).eql(['visibilitychange']);
    should(doc.removed).eql(['visibilitychange']);
    should(link.added).eql(['change']);
    should(link.removed).eql(['change']);
  });
});
