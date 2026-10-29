/**
 * The dictation debug ring: off by default, bounded, in memory only, and never holding a credential.
 */

import { describe, it } from 'bun:test';
import { type CleanupTrace, redactTraceHeaders, TRACE_REDACTED } from '@ferretry/protocol';
import should from 'should';
import {
  DICTATION_DEBUG_KEY,
  DICTATION_DEBUG_LIMIT,
  DictationDebugLog,
  type DictationDebugStorage,
  parseDictationDebug,
} from '../../../src/lib/stt/dictation-debug.ts';

const KEY = 'gsk_sentinel_value_that_must_never_appear';

const traceOf = (text: string): CleanupTrace => ({
  via: 'device',
  provider: 'groq',
  model: 'm',
  host: 'api.groq.com',
  totalMs: 5,
  outcome: 'cleaned',
  finalText: text,
  attempts: [
    {
      withContext: false,
      request: {
        host: 'api.groq.com',
        path: '/p',
        headers: redactTraceHeaders({ authorization: `Bearer ${KEY}` }),
        params: {},
        messages: [{ role: 'user', content: text }],
      },
      timings: { totalMs: 5 },
    },
  ],
});

class MemoryStorage implements DictationDebugStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const throwing: DictationDebugStorage = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
};

describe('parseDictationDebug', () => {
  it('should read only the word on as on', () => {
    should(parseDictationDebug('on')).be.true();
    for (const raw of ['off', 'ON', '', 'true', null, undefined]) should(parseDictationDebug(raw)).be.false();
  });
});

describe('DictationDebugLog', () => {
  it('should keep nothing while it is off, which is where it starts', () => {
    // Arrange
    const log = new DictationDebugLog(new MemoryStorage());

    // Act
    const id = log.record(traceOf('hello'), 1);

    // Assert
    should(id).be.undefined();
    should(log.snapshot().enabled).be.false();
    should(log.snapshot().records).have.length(0);
  });

  it('should keep a record while on, newest first, and hold a stable snapshot between changes', () => {
    // Arrange
    const log = new DictationDebugLog(new MemoryStorage());
    log.setEnabled(true);
    const before = log.snapshot();

    // Act
    const first = log.record(traceOf('one'), 1);
    const second = log.record(traceOf('two'), 2);

    // Assert
    should(first).not.equal(second);
    should(log.snapshot()).equal(log.snapshot());
    should(log.snapshot()).not.equal(before);
    should(log.snapshot().records.map(record => record.id)).deepEqual([second, first]);
    should(log.snapshot().records[0]?.at).equal(2);
  });

  it('should keep a call’s timeline beside its trace, and let the insertion times be added later', () => {
    // Arrange
    const log = new DictationDebugLog(new MemoryStorage());
    log.setEnabled(true);
    const timeline = { totalMs: 900, speech: { engine: 'parakeet' as const, totalMs: 500 } };
    const id = log.record(traceOf('one'), 1, timeline) as string;
    const other = log.record(traceOf('two'), 2) as string;

    // Act
    log.annotate(id, { ...timeline, insertMs: 8, reviewMs: 2_000 });

    // Assert
    should(log.snapshot().records.find(record => record.id === id)?.timeline).eql({
      ...timeline,
      insertMs: 8,
      reviewMs: 2_000,
    });
    should(log.snapshot().records.find(record => record.id === other)).not.have.property('timeline');
  });

  it('should leave the ring alone when told about a call it no longer holds', () => {
    // Arrange
    const log = new DictationDebugLog(new MemoryStorage());
    log.setEnabled(true);
    log.record(traceOf('one'), 1);
    const before = log.snapshot();

    // Act
    log.annotate('debug-gone', { totalMs: 1, speech: { engine: 'parakeet', totalMs: 1 } });

    // Assert
    should(log.snapshot()).equal(before);
  });

  it('should hold at most the last ten calls, dropping the oldest', () => {
    // Arrange
    const log = new DictationDebugLog(new MemoryStorage());
    log.setEnabled(true);

    // Act
    const ids = Array.from({ length: DICTATION_DEBUG_LIMIT + 5 }, (_, n) => log.record(traceOf(`t${String(n)}`), n));

    // Assert
    const kept = log.snapshot().records;
    should(DICTATION_DEBUG_LIMIT).equal(10);
    should(kept).have.length(10);
    should(kept.map(record => record.id)).deepEqual(ids.slice(5).reverse());
  });

  it('should never hold the credential in a record', () => {
    // Arrange
    const log = new DictationDebugLog(new MemoryStorage());
    log.setEnabled(true);

    // Act
    log.record(traceOf('hello'), 1);

    // Assert
    should(JSON.stringify(log.snapshot().records)).not.containEql(KEY);
    should(log.snapshot().records[0]?.trace.attempts[0]?.request.headers.authorization).equal(TRACE_REDACTED);
  });

  it('should drop every record when switched off, and persist the switch', () => {
    // Arrange
    const storage = new MemoryStorage();
    const log = new DictationDebugLog(storage);
    log.setEnabled(true);
    log.record(traceOf('hello'), 1);

    // Act
    log.setEnabled(false);

    // Assert
    should(log.snapshot().records).have.length(0);
    should(storage.values.get(DICTATION_DEBUG_KEY)).equal('off');
    log.setEnabled(true);
    should(storage.values.get(DICTATION_DEBUG_KEY)).equal('on');
    should(new DictationDebugLog(storage).snapshot().enabled).be.true();
  });

  it('should not publish when the switch is already where it was told to go', () => {
    // Arrange
    const log = new DictationDebugLog(new MemoryStorage());
    let calls = 0;
    log.subscribe(() => {
      calls += 1;
    });

    // Act
    log.setEnabled(false);

    // Assert
    should(calls).equal(0);
  });

  it('should forget records but keep the switch on clear, and skip a clear with nothing to forget', () => {
    // Arrange
    const log = new DictationDebugLog(new MemoryStorage());
    log.setEnabled(true);
    log.record(traceOf('hello'), 1);
    let calls = 0;
    log.subscribe(() => {
      calls += 1;
    });

    // Act
    log.clear();
    log.clear();

    // Assert
    should(log.snapshot()).containEql({ enabled: true });
    should(log.snapshot().records).have.length(0);
    should(calls).equal(1);
  });

  it('should stop telling a listener that unsubscribed', () => {
    // Arrange
    const log = new DictationDebugLog(new MemoryStorage());
    let calls = 0;
    const stop = log.subscribe(() => {
      calls += 1;
    });

    // Act
    stop();
    log.setEnabled(true);

    // Assert
    should(calls).equal(0);
  });

  it('should treat a denied storage as an ordinary condition: off to start, and the choice still applies', () => {
    // Arrange
    const log = new DictationDebugLog(throwing);

    // Act
    should(log.snapshot().enabled).be.false();
    log.setEnabled(true);

    // Assert
    should(log.snapshot().enabled).be.true();
    should(log.record(traceOf('hello'), 1)).be.a.String();
  });

  it('should work with no storage at all', () => {
    // Arrange
    const log = new DictationDebugLog(undefined);

    // Act + Assert
    should(log.snapshot().enabled).be.false();
    log.setEnabled(true);
    should(log.snapshot().enabled).be.true();
  });

  it('should read a browser whose storage lacks the read and write methods as having no storage', () => {
    // Arrange + Act + Assert
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {} });
    try {
      const log = new DictationDebugLog();
      should(log.snapshot().enabled).be.false();
      log.setEnabled(true);
      should(log.snapshot().enabled).be.true();
      should(Object.keys(globalThis.localStorage)).deepEqual([]);
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  });

  it('should read a browser whose storage getter throws as having no storage', () => {
    // Arrange + Act + Assert
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('storage access refused');
      },
    });
    try {
      const log = new DictationDebugLog();
      should(log.snapshot().enabled).be.false();
      log.setEnabled(true);
      should(log.snapshot().enabled).be.true();
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
