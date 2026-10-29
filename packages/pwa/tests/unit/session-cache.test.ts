import { describe, it } from 'bun:test';
import should from 'should';

import { daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';
import { daemonSessionKey, daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  logTail,
  parseCacheRecord,
  SESSION_CACHE_LIMITS,
  SessionCache,
  type SessionCacheBackend,
  type SessionCacheLimits,
  seedFleetFromCache,
} from '../../src/lib/session-cache.ts';
import { schemaValidSessionView as sessionView } from '../support/schema-valid-sessions.ts';

const alpha = daemonId('alpha');
const beta = daemonId('beta');
const alphaConnection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 't' });
const scopeOf = (daemon: typeof alpha, sessionId: string) => daemonSessionScope({ daemonId: daemon }, sessionId);

const sessionsKeyOf = (daemon: string): string => JSON.stringify(['sessions', daemon]);
const transcriptKeyOf = (daemon: typeof alpha, sessionId: string): string =>
  JSON.stringify(['transcript', daemonSessionKey(scopeOf(daemon, sessionId))]);

/** Lets every chained microtask the cache queued run: its backend is in-memory, so one task is enough. */
const drain = async (): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(onResolve => {
    resolve = onResolve;
  });
  return { promise, resolve };
};

class FakeBackend implements SessionCacheBackend {
  readonly records = new Map<string, unknown>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  failGet = false;
  failPut = false;
  failKeys = false;
  /** When set, a `get` waits for it, so a test can act while a read is in flight. */
  gate: Deferred<void> | null = null;
  gets = 0;

  async get(key: string): Promise<unknown> {
    this.gets += 1;
    if (this.gate !== null) await this.gate.promise;
    if (this.failGet) throw new Error('get failed');
    return this.records.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    if (this.failPut) throw new Error('put failed');
    this.puts.push(key);
    this.records.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.records.delete(key);
  }

  async keys(): Promise<readonly string[]> {
    if (this.failKeys) throw new Error('keys failed');
    return [...this.records.keys()];
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}

const clock = (start = 1_000_000) => {
  let now = start;
  return { now: () => now, set: (value: number) => (now = value), advance: (by: number) => (now += by) };
};

const limits = (overrides: Partial<SessionCacheLimits> = {}): SessionCacheLimits => ({
  ...SESSION_CACHE_LIMITS,
  ...overrides,
});

const subject = (backend: SessionCacheBackend | null, time = clock(), options: Partial<SessionCacheLimits> = {}) => ({
  time,
  cache: new SessionCache(backend, { now: time.now, limits: limits(options) }),
});

describe('SessionCache sessions', () => {
  it('serves a saved list from memory and, after a reload, from the same storage', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache, time } = subject(backend);
    const views = [sessionView('s-1'), sessionView('s-2')];

    // Act
    cache.saveSessions(alpha, views, cache.generation(alpha));
    await drain();
    const inMemory = await cache.sessions(alpha);
    const reloaded = await new SessionCache(backend, { now: time.now, limits: SESSION_CACHE_LIMITS }).sessions(alpha);

    // Assert
    should(inMemory?.sessions.map(view => view.config.id)).eql(['s-1', 's-2']);
    should(inMemory?.savedAt).equal(time.now());
    should(reloaded?.sessions.map(view => view.config.id)).eql(['s-1', 's-2']);
  });

  it('answers null for a machine it never saw, asking storage once', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache } = subject(backend);

    // Act
    const first = await cache.sessions(alpha);
    const second = await cache.sessions(alpha);

    // Assert
    should(first).be.null();
    should(second).be.null();
    should(backend.gets).equal(1);
  });

  it('answers null when the cache has no storage at all', async () => {
    const { cache } = subject(null);
    cache.saveSessions(alpha, [sessionView('s-1')], 0);
    should((await cache.sessions(alpha))?.sessions.length).equal(1);
    should(await cache.sessions(beta)).be.null();
    should(cache.clearDaemon(alpha)).be.true();
    await cache.clearAll();
    should(await cache.sessions(alpha)).be.null();
  });

  it('refuses a stored list that is not made of valid session views', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache, time } = subject(backend);
    backend.records.set(sessionsKeyOf('alpha'), {
      kind: 'sessions',
      daemonId: 'alpha',
      savedAt: time.now(),
      sessions: [{ junk: true }],
    });

    // Act
    const actual = await cache.sessions(alpha);

    // Assert
    should(actual).be.null();
  });

  it.each([
    ['older than maxAgeMs', (now: number) => now - SESSION_CACHE_LIMITS.maxAgeMs - 1],
    ['saved in the future', (now: number) => now + 1],
    ['not a number', () => 'yesterday'],
    ['not finite', () => Number.NaN],
  ])('does not serve a stored list that is %s', async (_name, savedAt) => {
    // Arrange
    const backend = new FakeBackend();
    const { cache, time } = subject(backend);
    backend.records.set(sessionsKeyOf('alpha'), {
      kind: 'sessions',
      daemonId: 'alpha',
      savedAt: savedAt(time.now()),
      sessions: [sessionView('s-1')],
    });

    // Act
    const actual = await cache.sessions(alpha);

    // Assert
    should(actual).be.null();
  });

  it('serves a stored list exactly maxAgeMs old and stops serving the memory copy after it', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache, time } = subject(backend);
    cache.saveSessions(alpha, [sessionView('s-1')], 0);
    const savedAt = time.now();

    // Act
    time.set(savedAt + SESSION_CACHE_LIMITS.maxAgeMs);
    const atLimit = await cache.sessions(alpha);
    time.set(savedAt + SESSION_CACHE_LIMITS.maxAgeMs + 1);
    const pastLimit = await cache.sessions(alpha);

    // Assert
    should(atLimit).not.be.null();
    should(pastLimit).be.null();
  });

  it('does not serve a record that another machine saved under the key it asked for', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache, time } = subject(backend);
    backend.records.set(sessionsKeyOf('alpha'), {
      kind: 'sessions',
      daemonId: 'beta',
      savedAt: time.now(),
      sessions: [sessionView('s-1')],
    });

    // Act
    const actual = await cache.sessions(alpha);

    // Assert
    should(actual).be.null();
  });

  it('does not answer a session list from a transcript record stored under its key', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache, time } = subject(backend);
    backend.records.set(sessionsKeyOf('alpha'), {
      kind: 'transcript',
      daemonId: 'alpha',
      savedAt: time.now(),
      log: 'x',
      sends: [],
    });

    // Act
    const actual = await cache.sessions(alpha);

    // Assert
    should(actual).be.null();
  });

  it('absorbs a storage that throws on get, put or keys', async () => {
    // Arrange
    const backend = new FakeBackend();
    backend.failGet = true;
    backend.failPut = true;
    backend.failKeys = true;
    const { cache } = subject(backend);

    // Act
    const read = await cache.sessions(alpha);
    cache.saveSessions(alpha, [sessionView('s-1')], 0);
    cache.saveTranscript(scopeOf(alpha, 's-1'), { log: 'a\nb', sends: [] }, 0);
    await drain();
    const kept = await cache.sessions(alpha);
    const cleared = cache.clearDaemon(alpha);
    await drain();

    // Assert
    should(read).be.null();
    should(kept?.sessions.length).equal(1);
    should(cleared).be.true();
    should(backend.records.size).equal(0);
  });
});

describe('SessionCache generations', () => {
  it('drops a save carrying a generation older than a clear of that machine', () => {
    // Arrange
    const { cache } = subject(null);
    const stale = cache.generation(alpha);

    // Act
    cache.clearDaemon(alpha);
    cache.saveSessions(alpha, [sessionView('s-1')], stale);
    cache.saveTranscript(scopeOf(alpha, 's-1'), { log: 'x', sends: [] }, stale);

    // Assert
    should(cache.generation(alpha)).equal(stale + 1);
    should(cache.peekTranscript(scopeOf(alpha, 's-1'))).be.undefined();
  });

  it('leaves another machine generation alone when one is cleared', () => {
    const { cache } = subject(null);
    cache.clearDaemon(alpha);
    should(cache.generation(beta)).equal(0);
  });

  it('moves every machine generation when the whole cache is cleared', async () => {
    // Arrange
    const { cache } = subject(null);
    const alphaBefore = cache.generation(alpha);
    const betaBefore = cache.generation(beta);

    // Act
    await cache.clearAll();
    cache.saveSessions(beta, [sessionView('s-1')], betaBefore);

    // Assert
    should(cache.generation(alpha)).equal(alphaBefore + 1);
    should(cache.generation(beta)).equal(betaBefore + 1);
    should(await cache.sessions(beta)).be.null();
  });

  it('returns null for a read that a clear overtook, and shows nothing it found', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache, time } = subject(backend);
    backend.records.set(sessionsKeyOf('alpha'), {
      kind: 'sessions',
      daemonId: 'alpha',
      savedAt: time.now(),
      sessions: [sessionView('s-1')],
    });
    backend.gate = deferred<void>();

    // Act
    const reading = cache.sessions(alpha);
    await drain();
    cache.clearDaemon(alpha);
    backend.gate.resolve();
    const actual = await reading;

    // Assert
    should(actual).be.null();
  });

  it('lets a live save that landed while storage was read win over what storage held', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache, time } = subject(backend);
    backend.records.set(sessionsKeyOf('alpha'), {
      kind: 'sessions',
      daemonId: 'alpha',
      savedAt: time.now(),
      sessions: [sessionView('old')],
    });
    backend.gate = deferred<void>();

    // Act
    const reading = cache.sessions(alpha);
    await drain();
    cache.saveSessions(alpha, [sessionView('live')], cache.generation(alpha));
    backend.gate.resolve();
    const actual = await reading;

    // Assert
    should(actual?.sessions.map(view => view.config.id)).eql(['live']);
  });
});

describe('SessionCache transcripts', () => {
  it('keeps the tail of a log and the newest send rows, and reads them back after a reload', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache, time } = subject(backend, clock(), { transcriptChars: 12, sends: 2 });
    const scope = scopeOf(alpha, 's-1');

    // Act
    cache.saveTranscript(scope, { log: 'one\ntwo\nthree\nfour', sends: [1, 2, 3] }, cache.generation(alpha));
    await drain();
    const peeked = cache.peekTranscript(scope);
    const reloaded = await new SessionCache(backend, { now: time.now, limits: limits() }).transcript(scope);

    // Assert
    should(peeked?.log).equal('three\nfour');
    should(peeked?.sends).eql([2, 3]);
    should(reloaded?.log).equal('three\nfour');
    should(reloaded?.sends).eql([2, 3]);
  });

  it('answers a transcript read from memory without asking storage', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache } = subject(backend);
    const scope = scopeOf(alpha, 's-1');
    cache.saveTranscript(scope, { log: 'a', sends: [] }, 0);
    await drain();
    backend.gets = 0;

    // Act
    const actual = await cache.transcript(scope);

    // Assert
    should(actual?.log).equal('a');
    should(backend.gets).equal(0);
  });

  it('answers null for a transcript no storage holds, and for a sessions record under its key', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache, time } = subject(backend);
    backend.records.set(transcriptKeyOf(alpha, 's-2'), {
      kind: 'sessions',
      daemonId: 'alpha',
      savedAt: time.now(),
      sessions: [],
    });

    // Act
    const missing = await cache.transcript(scopeOf(alpha, 's-1'));
    const wrongKind = await cache.transcript(scopeOf(alpha, 's-2'));

    // Assert
    should(missing).be.null();
    should(wrongKind).be.null();
  });

  it('peeks only at memory: nothing from storage, nothing that is not a transcript, nothing expired', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache, time } = subject(backend);
    const scope = scopeOf(alpha, 's-1');
    backend.records.set(transcriptKeyOf(alpha, 's-1'), {
      kind: 'transcript',
      daemonId: 'alpha',
      savedAt: time.now(),
      log: 'stored',
      sends: [],
    });

    // Act
    const beforeRead = cache.peekTranscript(scope);
    await cache.transcript(scope);
    const afterRead = cache.peekTranscript(scope);
    time.advance(SESSION_CACHE_LIMITS.maxAgeMs + 1);
    const expired = cache.peekTranscript(scope);
    cache.saveSessions(alpha, [sessionView('s-1')], 0);

    // Assert
    should(beforeRead).be.undefined();
    should(afterRead?.log).equal('stored');
    should(expired).be.undefined();
  });

  it('does not peek a sessions record through a transcript scope', () => {
    // Arrange
    const { cache } = subject(null);
    cache.saveSessions(alpha, [sessionView('s-1')], 0);

    // Act
    const actual = cache.peekTranscript(scopeOf(alpha, 's-1'));

    // Assert
    should(actual).be.undefined();
  });

  it('writes nothing for a save that changes nothing, and merges a partial read into the last one', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache } = subject(backend);
    const scope = scopeOf(alpha, 's-1');
    const generation = cache.generation(alpha);

    // Act
    cache.saveTranscript(scope, { log: 'a\nb', sends: [{ id: 1 }] }, generation);
    await drain();
    const writes = backend.puts.length;
    cache.saveTranscript(scope, { log: 'a\nb', sends: [{ id: 1 }] }, generation);
    cache.saveTranscript(scope, {}, generation);
    await drain();
    const unchanged = backend.puts.length;
    cache.saveTranscript(scope, { sends: [{ id: 2 }] }, generation);
    cache.saveTranscript(scope, { log: 'a\nb\nc' }, generation);
    await drain();

    // Assert
    should(writes).equal(1);
    should(unchanged).equal(1);
    should(cache.peekTranscript(scope)?.log).equal('a\nb\nc');
    should(cache.peekTranscript(scope)?.sends).eql([{ id: 2 }]);
  });

  it('saves an empty record for a first read that carries neither a log nor sends', async () => {
    // Arrange
    const { cache } = subject(new FakeBackend());
    const scope = scopeOf(alpha, 's-1');

    // Act
    cache.saveTranscript(scope, {}, cache.generation(alpha));

    // Assert
    should(cache.peekTranscript(scope)?.log).equal('');
    should(cache.peekTranscript(scope)?.sends).eql([]);
  });

  it('writes anew over a session record that is not a transcript', () => {
    // Arrange
    const { cache } = subject(null);
    const scope = scopeOf(alpha, 's-1');

    // Act
    cache.saveTranscript(scope, { log: 'x' }, 0);

    // Assert
    should(cache.peekTranscript(scope)?.log).equal('x');
  });

  it('evicts the least recently saved transcripts past the limit, in memory and in storage', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache, time } = subject(backend, clock(), { transcripts: 2 });
    const generation = cache.generation(alpha);

    // Act
    for (const id of ['s-1', 's-2', 's-3']) {
      time.advance(10);
      cache.saveTranscript(scopeOf(alpha, id), { log: `log ${id}` }, generation);
    }
    await drain();

    // Assert
    should(cache.peekTranscript(scopeOf(alpha, 's-1'))).be.undefined();
    should(cache.peekTranscript(scopeOf(alpha, 's-2'))?.log).equal('log s-2');
    should(cache.peekTranscript(scopeOf(alpha, 's-3'))?.log).equal('log s-3');
    should(backend.deletes).eql([transcriptKeyOf(alpha, 's-1')]);
    should([...backend.records.keys()].sort()).eql(
      [transcriptKeyOf(alpha, 's-2'), transcriptKeyOf(alpha, 's-3')].sort(),
    );
  });

  it('counts transcripts already in storage toward the limit and clears junk it finds there', async () => {
    // Arrange
    const backend = new FakeBackend();
    const time = clock();
    const old = (id: string, savedAt: number) => ({
      kind: 'transcript',
      daemonId: 'alpha',
      savedAt,
      log: id,
      sends: [],
    });
    backend.records.set(transcriptKeyOf(alpha, 'old-1'), old('old-1', time.now() - 20));
    backend.records.set(transcriptKeyOf(alpha, 'old-2'), old('old-2', time.now() - 10));
    backend.records.set(sessionsKeyOf('alpha'), {
      kind: 'sessions',
      daemonId: 'alpha',
      savedAt: time.now(),
      sessions: [],
    });
    backend.records.set('junk', 'not a record');
    const { cache } = subject(backend, time, { transcripts: 2 });

    // Act
    cache.saveTranscript(scopeOf(alpha, 'new'), { log: 'new' }, 0);
    await drain();

    // Assert
    should(backend.deletes).containEql('junk');
    should(backend.deletes).containEql(transcriptKeyOf(alpha, 'old-1'));
    should(backend.records.has(transcriptKeyOf(alpha, 'old-2'))).be.true();
    should(backend.records.has(transcriptKeyOf(alpha, 'new'))).be.true();
    should(backend.records.has(sessionsKeyOf('alpha'))).be.true();
  });
});

describe('SessionCache clearing', () => {
  it('forgets only one machine, in storage and in memory, and says whether it had anything', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache } = subject(backend);
    cache.saveSessions(alpha, [sessionView('a-1')], 0);
    cache.saveTranscript(scopeOf(alpha, 'a-1'), { log: 'a' }, 0);
    cache.saveSessions(beta, [sessionView('b-1')], 0);
    cache.saveTranscript(scopeOf(beta, 'b-1'), { log: 'b' }, 0);
    await drain();
    backend.records.set('junk', 'not a record');

    // Act
    const hadAlpha = cache.clearDaemon(alpha);
    await drain();
    const hadAgain = cache.clearDaemon(alpha);
    await drain();

    // Assert
    should(hadAlpha).be.true();
    should(hadAgain).be.false();
    should(cache.peekTranscript(scopeOf(alpha, 'a-1'))).be.undefined();
    should(cache.peekTranscript(scopeOf(beta, 'b-1'))?.log).equal('b');
    should(await cache.sessions(beta)).not.be.null();
    should([...backend.records.keys()].sort()).eql([sessionsKeyOf('beta'), transcriptKeyOf(beta, 'b-1')].sort());
    should(backend.records.has('junk')).be.false();
  });

  it('empties every machine and storage, and reads nothing back afterwards', async () => {
    // Arrange
    const backend = new FakeBackend();
    const { cache } = subject(backend);
    cache.saveSessions(alpha, [sessionView('a-1')], 0);
    cache.saveTranscript(scopeOf(beta, 'b-1'), { log: 'b' }, 0);
    await drain();

    // Act
    await cache.clearAll();
    cache.saveTranscript(scopeOf(beta, 'b-2'), { log: 'c' }, cache.generation(beta));
    await drain();

    // Assert
    should(await cache.sessions(alpha)).be.null();
    should(cache.peekTranscript(scopeOf(beta, 'b-1'))).be.undefined();
    should([...backend.records.keys()]).eql([transcriptKeyOf(beta, 'b-2')]);
  });
});

describe('logTail', () => {
  it.each([
    ['fits whole', 'one\ntwo', 100, 'one\ntwo'],
    ['fits exactly', 'one\ntwo', 7, 'one\ntwo'],
    ['cut mid-line is cut forward to the next line', 'one\ntwo\nthree', 8, 'three'],
    ['cut landing on a newline drops it', 'one\ntwo\nthree', 6, 'three'],
    ['no newline in the kept part', 'abcdefghij', 4, ''],
  ])('%s', (_name, log, limit, expected) => {
    // Arrange / Act
    const actual = logTail(log, limit);

    // Assert
    should(actual).equal(expected);
  });
});

describe('parseCacheRecord', () => {
  const NOW = 1_000;
  it.each([
    ['null', null],
    ['a string', 'x'],
    ['no daemon id', { kind: 'transcript', savedAt: NOW, log: '', sends: [] }],
    ['a transcript with a non-string log', { kind: 'transcript', daemonId: 'a', savedAt: NOW, log: 1, sends: [] }],
    ['a transcript with non-array sends', { kind: 'transcript', daemonId: 'a', savedAt: NOW, log: '', sends: {} }],
    ['an unknown kind', { kind: 'other', daemonId: 'a', savedAt: NOW }],
  ])('rejects %s', (_name, value) => {
    should(parseCacheRecord(value, NOW, 100)).be.null();
  });

  it('accepts a well formed transcript', () => {
    const value = { kind: 'transcript', daemonId: 'a', savedAt: NOW, log: 'x', sends: [1] };
    should(parseCacheRecord(value, NOW, 100)).eql({ ...value, openedAt: NOW });
  });
});

describe('seedFleetFromCache', () => {
  it.each([
    ['a cached list the fleet takes', true, true],
    ['a cached list the fleet refuses', false, false],
  ])('answers for %s', async (_name, accepts, expected) => {
    // Arrange
    const { cache, time } = subject(null);
    cache.saveSessions(alpha, [sessionView('s-1')], 0);
    const seeds: { id: string; ids: string[]; savedAt: number }[] = [];
    const fleet = {
      seed: (daemon: { daemonId: string }, sessions: readonly { config: { id: string } }[], savedAt: number) => {
        seeds.push({ id: daemon.daemonId, ids: sessions.map(view => view.config.id), savedAt });
        return accepts;
      },
    };

    // Act
    const actual = await seedFleetFromCache(fleet as never, cache, alphaConnection);

    // Assert
    should(actual).equal(expected);
    should(seeds).eql([{ id: 'alpha', ids: ['s-1'], savedAt: time.now() }]);
  });

  it('does not seed a machine with nothing cached', async () => {
    // Arrange
    const { cache } = subject(null);
    let seeded = false;
    const fleet = {
      seed: () => {
        seeded = true;
        return true;
      },
    };

    // Act
    const actual = await seedFleetFromCache(fleet, cache, alphaConnection);

    // Assert
    should(actual).be.false();
    should(seeded).be.false();
  });
});
