/**
 * The transcription log: on by default, bounded by count and age, searchable, never losing a
 * dictation to a refused write, and holding only text.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { ON_DEVICE_MODELS } from '../../../src/lib/stt/model-catalog.ts';
import {
  type NewTranscriptionEntry,
  parseTranscriptionLogEnabled,
  searchTranscriptionLog,
  TRANSCRIPTION_ENGINE_LABELS,
  TRANSCRIPTION_LOG_KEY,
  TRANSCRIPTION_LOG_MAX_AGE_MS,
  TRANSCRIPTION_LOG_MAX_ENTRIES,
  type TranscriptionEntry,
  TranscriptionLog,
  type TranscriptionLogRecords,
  type TranscriptionLogStorage,
} from '../../../src/lib/stt/transcription-log.ts';
import type { DictationTimeline } from '../../../src/lib/stt/dictation-timeline.ts';

const NOW = 1_800_000_000_000;

class MemoryStorage implements TranscriptionLogStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FakeRecords implements TranscriptionLogRecords {
  readonly rows = new Map<string, unknown>();
  failList = false;
  failWrite = false;
  calls: string[] = [];

  async list(): Promise<readonly unknown[]> {
    if (this.failList) throw new Error('refused');
    return [...this.rows.values()];
  }
  async put(entry: TranscriptionEntry): Promise<void> {
    if (this.failWrite) throw new Error('refused');
    this.calls.push(`put:${entry.id}`);
    this.rows.set(entry.id, entry);
  }
  async delete(id: string): Promise<void> {
    if (this.failWrite) throw new Error('refused');
    this.calls.push(`delete:${id}`);
    this.rows.delete(id);
  }
  async clear(): Promise<void> {
    if (this.failWrite) throw new Error('refused');
    this.calls.push('clear');
    this.rows.clear();
  }
}

const entry = (over: Partial<NewTranscriptionEntry> = {}): NewTranscriptionEntry => ({
  at: NOW,
  engine: 'parakeet',
  raw: 'helo wold',
  outcome: 'pending',
  ...over,
});

const settle = async (): Promise<void> => {
  for (let n = 0; n < 20; n += 1) await Promise.resolve();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
};

const counter = (): (() => string) => {
  let n = 0;
  return () => {
    n += 1;
    return `e${String(n)}`;
  };
};

const build = (records: TranscriptionLogRecords = new FakeRecords(), storage = new MemoryStorage()) =>
  new TranscriptionLog(records, { storage, now: () => NOW, newId: counter() });

describe('parseTranscriptionLogEnabled', () => {
  it('should read everything but the word off as on', () => {
    should(parseTranscriptionLogEnabled('off')).be.false();
    for (const raw of ['on', '', 'garbage', null, undefined]) should(parseTranscriptionLogEnabled(raw)).be.true();
  });
});

describe('TranscriptionLog', () => {
  it('should record by default and persist each dictation, newest first', async () => {
    // Arrange
    const records = new FakeRecords();
    const log = build(records);

    // Act
    const first = log.add(entry({ at: NOW - 2 }));
    const second = log.add(entry({ at: NOW - 1, raw: 'second' }));
    await settle();

    // Assert
    should(log.snapshot().enabled).be.true();
    should(log.snapshot().saved).be.true();
    should(log.snapshot().entries.map(item => item.id)).deepEqual([second, first]);
    should([...records.rows.keys()].sort()).deepEqual([first, second].sort());
    should(log.snapshot()).equal(log.snapshot());
  });

  it('should keep nothing while switched off, and remember the switch', () => {
    // Arrange
    const storage = new MemoryStorage();
    const log = build(new FakeRecords(), storage);
    log.setEnabled(false);

    // Act
    const id = log.add(entry());

    // Assert
    should(id).be.undefined();
    should(log.snapshot().entries).have.length(0);
    should(storage.values.get(TRANSCRIPTION_LOG_KEY)).equal('off');
    should(build(new FakeRecords(), storage).snapshot().enabled).be.false();
    log.setEnabled(true);
    should(storage.values.get(TRANSCRIPTION_LOG_KEY)).equal('on');
  });

  it('should not publish when the switch is already where it was told to go', () => {
    // Arrange
    const log = build();
    let calls = 0;
    log.subscribe(() => {
      calls += 1;
    });

    // Act
    log.setEnabled(true);

    // Assert
    should(calls).equal(0);
  });

  it('should keep what is already there when switched off, until Clear', async () => {
    // Arrange
    const log = build();
    log.add(entry());

    // Act
    log.setEnabled(false);
    await settle();

    // Assert
    should(log.snapshot().entries).have.length(1);
  });

  it('should hold at most the newest 200, deleting the rest from the device', async () => {
    // Arrange
    const records = new FakeRecords();
    const log = build(records);

    // Act
    for (let n = 0; n < TRANSCRIPTION_LOG_MAX_ENTRIES + 3; n += 1)
      log.add(entry({ at: NOW - 1_000 + n, raw: `r${String(n)}` }));
    await settle();

    // Assert
    should(TRANSCRIPTION_LOG_MAX_ENTRIES).equal(200);
    should(log.snapshot().entries).have.length(200);
    should(log.snapshot().entries[0]?.raw).equal('r202');
    should(log.snapshot().entries.at(-1)?.raw).equal('r3');
    should(records.rows.size).equal(200);
  });

  it('should drop an entry older than thirty days as one lands', async () => {
    // Arrange
    const records = new FakeRecords();
    const log = build(records);
    const old = log.add(entry({ at: NOW - TRANSCRIPTION_LOG_MAX_AGE_MS + 1 }));
    await settle();

    // Act
    const stale = new TranscriptionLog(records, {
      storage: new MemoryStorage(),
      now: () => NOW + 10,
      newId: () => 'fresh',
    });
    await stale.hydrate();
    stale.add(entry({ at: NOW + 10 }));
    await settle();

    // Assert
    should(TRANSCRIPTION_LOG_MAX_AGE_MS).equal(2_592_000_000);
    should(stale.snapshot().entries.map(item => item.id)).deepEqual(['fresh']);
    should(records.rows.has(old as string)).be.false();
  });

  it('should update an entry in place, persist it, and leave a missing one gone', async () => {
    // Arrange
    const records = new FakeRecords();
    const log = build(records);
    const id = log.add(entry()) as string;

    // Act
    log.update(id, { outcome: 'inserted', cleaned: 'Hello, world.', prompt: 'fix', debugId: 'debug-1' });
    log.update('nope', { outcome: 'discarded' });
    await settle();

    // Assert
    should(log.snapshot().entries[0]).containEql({
      outcome: 'inserted',
      cleaned: 'Hello, world.',
      prompt: 'fix',
      debugId: 'debug-1',
      raw: 'helo wold',
    });
    should(records.rows.get(id)).containEql({ outcome: 'inserted' });
    should(log.snapshot().entries).have.length(1);
  });

  it('should forget every entry on Clear and keep the switch', async () => {
    // Arrange
    const records = new FakeRecords();
    const log = build(records);
    log.add(entry());

    // Act
    log.clear();
    await settle();

    // Assert
    should(log.snapshot().entries).have.length(0);
    should(log.snapshot().enabled).be.true();
    should(records.rows.size).equal(0);
    should(records.calls.at(-1)).equal('clear');
  });

  it('should read what the device kept, ignore malformed rows, and share one read', async () => {
    // Arrange
    const records = new FakeRecords();
    const kept: TranscriptionEntry = { ...entry({ at: NOW - 5 }), id: 'old', outcome: 'inserted' };
    records.rows.set('old', kept);
    records.rows.set('bad', { id: 'bad', at: 'yesterday' });
    records.rows.set('extra', { ...kept, id: 'extra', audio: 'AAAA' });
    const log = build(records);
    const live = log.add(entry({ at: NOW - 1, raw: 'live' }));

    // Act
    const one = log.hydrate();
    const two = log.hydrate();
    await one;
    await settle();

    // Assert
    should(one).equal(two);
    should(log.snapshot().entries.map(item => item.id)).deepEqual([live, 'old']);
  });

  it('should delete rows from the device that are past the bounds when it reads them', async () => {
    // Arrange
    const records = new FakeRecords();
    const ancient: TranscriptionEntry = { ...entry({ at: NOW - TRANSCRIPTION_LOG_MAX_AGE_MS - 1 }), id: 'ancient' };
    records.rows.set('ancient', ancient);
    const log = build(records);

    // Act
    await log.hydrate();
    await settle();

    // Assert
    should(log.snapshot().entries).have.length(0);
    should(records.rows.has('ancient')).be.false();
  });

  it('should say it is not saved when the read is refused, and keep working in memory', async () => {
    // Arrange
    const records = new FakeRecords();
    records.failList = true;
    const log = build(records);

    // Act
    await log.hydrate();
    log.add(entry());

    // Assert
    should(log.snapshot().saved).be.false();
    should(log.snapshot().entries).have.length(1);
  });

  it('should say it is not saved when a write is refused, and keep the entry', async () => {
    // Arrange
    const records = new FakeRecords();
    records.failWrite = true;
    const log = build(records);

    // Act
    log.add(entry());
    await settle();

    // Assert
    should(log.snapshot().saved).be.false();
    should(log.snapshot().entries).have.length(1);
  });

  it('should work in memory, unsaved, when this browser has no IndexedDB', async () => {
    // Arrange
    const log = new TranscriptionLog(undefined, { storage: new MemoryStorage(), now: () => NOW, newId: counter() });

    // Act
    await log.hydrate();
    log.add(entry());
    log.update(log.snapshot().entries[0]?.id as string, { outcome: 'discarded' });
    log.clear();

    // Assert
    should(log.snapshot().saved).be.false();
    should(log.snapshot().entries).have.length(0);
  });

  it('should treat a denied storage as an ordinary condition', () => {
    // Arrange
    const denied: TranscriptionLogStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const log = new TranscriptionLog(new FakeRecords(), { storage: denied, now: () => NOW, newId: counter() });

    // Act + Assert
    should(log.snapshot().enabled).be.true();
    log.setEnabled(false);
    should(log.snapshot().enabled).be.false();
  });

  it('should work with no storage at all, and notify only those still subscribed', () => {
    // Arrange
    const log = new TranscriptionLog(undefined, { storage: undefined, now: () => NOW, newId: counter() });
    let calls = 0;
    const stop = log.subscribe(() => {
      calls += 1;
    });

    // Act
    log.setEnabled(false);
    stop();
    log.setEnabled(true);

    // Assert
    should(calls).equal(1);
  });

  it('should find the browser storage and a random id when none are injected', () => {
    // Arrange
    const log = new TranscriptionLog(undefined);

    // Act
    const id = log.add(entry());

    // Assert
    should(id).be.a.String();
    should(log.snapshot().entries[0]?.id).equal(id);
  });

  it('should hold only text: an entry has no field for audio', () => {
    // Arrange
    const log = build();

    // Act
    log.add(
      entry({ cleaned: 'Hello.', prompt: 'polish', sessionId: 's1', sessionLabel: 'Fix the bug', durationMs: 4200 }),
    );

    // Assert
    should(Object.keys(log.snapshot().entries[0] ?? {}).sort()).deepEqual(
      ['at', 'cleaned', 'durationMs', 'engine', 'id', 'outcome', 'prompt', 'raw', 'sessionId', 'sessionLabel'].sort(),
    );
  });
});

describe('TranscriptionLog timelines', () => {
  const timeline: DictationTimeline = {
    totalMs: 1_000,
    speech: { engine: 'parakeet', totalMs: 600 },
    cleanup: { provider: 'groq', via: 'device', outcome: 'cleaned', attempts: 1, totalMs: 300 },
  };

  it('should keep a dictation’s timeline, persist it, and add the insertion times when they are known', async () => {
    // Arrange
    const records = new FakeRecords();
    const log = build(records);
    const id = log.add(entry({ timeline })) as string;

    // Act
    log.update(id, { outcome: 'inserted', timeline: { ...timeline, insertMs: 12, reviewMs: 3_000 } });
    await settle();

    // Assert
    should(log.snapshot().entries[0]?.timeline).eql({ ...timeline, insertMs: 12, reviewMs: 3_000 });
    should((records.rows.get(id) as TranscriptionEntry).timeline?.insertMs).equal(12);
  });

  it('should read a timeline back from the device, and drop a row whose timeline has a stray field', async () => {
    // Arrange
    const records = new FakeRecords();
    records.rows.set('good', { id: 'good', at: NOW, engine: 'parakeet', raw: 'a', outcome: 'inserted', timeline });
    records.rows.set('bad', {
      id: 'bad',
      at: NOW,
      engine: 'parakeet',
      raw: 'b',
      outcome: 'inserted',
      timeline: { ...timeline, transcript: 'hello' },
    });
    const log = build(records);

    // Act
    await log.hydrate();

    // Assert
    should(log.snapshot().entries.map(item => item.id)).eql(['good']);
    should(log.snapshot().entries[0]?.timeline).eql(timeline);
  });
});

describe('searchTranscriptionLog', () => {
  const entries: TranscriptionEntry[] = [
    {
      id: '1',
      at: NOW,
      engine: 'parakeet',
      raw: 'send the report to bob',
      cleaned: 'Send the report to Bob.',
      prompt: 'fix',
      outcome: 'inserted',
      sessionLabel: 'Quarterly report',
      sessionId: 'sess-a',
    },
    { id: '2', at: NOW, engine: 'web-speech', raw: 'call alice', outcome: 'discarded' },
  ];

  it('should return everything for an empty query', () => {
    should(searchTranscriptionLog(entries, '   ')).equal(entries);
  });

  it('should require every word, across the words, the session, the engine, the prompt and the outcome', () => {
    should(searchTranscriptionLog(entries, 'BOB').map(item => item.id)).deepEqual(['1']);
    should(searchTranscriptionLog(entries, 'quarterly bob').map(item => item.id)).deepEqual(['1']);
    should(searchTranscriptionLog(entries, 'quarterly alice')).have.length(0);
    should(searchTranscriptionLog(entries, 'web speech').map(item => item.id)).deepEqual(['2']);
    should(searchTranscriptionLog(entries, 'sess-a fix').map(item => item.id)).deepEqual(['1']);
    should(searchTranscriptionLog(entries, 'discarded').map(item => item.id)).deepEqual(['2']);
  });
});

describe('TRANSCRIPTION_ENGINE_LABELS', () => {
  it('names browser voice and every catalog model', () => {
    should(TRANSCRIPTION_ENGINE_LABELS['web-speech']).equal('Web Speech');
    for (const model of ON_DEVICE_MODELS)
      should(TRANSCRIPTION_ENGINE_LABELS[model.id]).equal(`${model.shortName} in-browser`);
  });
});
