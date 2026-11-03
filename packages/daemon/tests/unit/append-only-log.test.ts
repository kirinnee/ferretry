import { describe, it } from 'bun:test';
import should from 'should';
import { type AppendOnlyFiles, appendLogRecords, completeLinesCursor } from '../../src/lib/append-only-log.ts';

class MemoryLog implements AppendOnlyFiles {
  readonly documents = new Map<string, string>();
  private torn = new Uint8Array();
  readonly reads: number[] = [];
  failAppend = false;
  async read(_session: string, name: string) {
    return this.documents.get(name);
  }
  async readAfter(_session: string, name: string, bytes: number) {
    this.reads.push(bytes);
    return Buffer.concat([Buffer.from(this.documents.get(name) ?? ''), this.torn]).subarray(bytes);
  }
  async writeAtomic(_session: string, name: string, text: string) {
    this.documents.set(name, text);
  }
  async remove(_session: string, name: string) {
    this.documents.delete(name);
  }
  async truncate(_session: string, name: string, bytes: number) {
    this.documents.set(
      name,
      Buffer.from(this.documents.get(name) ?? '')
        .subarray(0, bytes)
        .toString('utf8'),
    );
  }
  async appendSynced(_session: string, name: string, bytes: Uint8Array) {
    if (this.failAppend) {
      this.failAppend = false;
      this.torn = bytes.slice(0, 10);
      throw new Error('interrupted append');
    }
    this.documents.set(name, (this.documents.get(name) ?? '') + Buffer.concat([this.torn, bytes]).toString('utf8'));
    this.torn = new Uint8Array();
  }
}
const EMPTY = { bytes: 0, count: 0 };
const NAME = 'history.jsonl';
const append = (files: MemoryLog, cursor = EMPTY, records: readonly unknown[] = []) =>
  appendLogRecords(files, 'session-1', NAME, cursor, records);

describe('an append-only log', () => {
  it('should append UTF-8 words once, read only the cursor tail, and keep committed bytes unchanged', async () => {
    const files = new MemoryLog();
    const first = await append(files, EMPTY, [{ text: '雪 🦦' }]);
    const original = files.documents.get(NAME) ?? '';
    should(first).deepEqual({ bytes: Buffer.byteLength(original), count: 1 });
    const second = await append(files, first, [{ text: 'next' }]);
    should(files.documents.get(NAME)).startWith(original);
    should(second.count).equal(2);
    should(files.reads.slice(-2)).deepEqual([first.bytes, first.bytes]);
    should(await append(files, second)).deepEqual(second);
    should(files.documents.has(`${NAME}.pending`)).be.false();
  });

  it('should replay a lagging cursor idempotently while retaining repeated records', async () => {
    const files = new MemoryLog();
    const records = [{ text: 'same' }, { text: 'same' }];
    const first = await append(files, EMPTY, records);
    should(await append(files, EMPTY, records)).deepEqual(first);
    should(files.documents.get(NAME)?.split('\n').filter(Boolean)).have.length(2);
  });

  it('should cut the uncommitted records of a different command instead of adopting them', async () => {
    const files = new MemoryLog();
    const committed = await append(files, EMPTY, [{ text: 'committed 雪' }]);
    await append(files, committed, [{ text: 'rolled back' }]);
    const next = await append(files, committed, [{ text: 'another command' }]);
    should(next.count).equal(2);
    should(files.documents.get(NAME)).equal('{"text":"committed 雪"}\n{"text":"another command"}\n');
    should(next.bytes).equal(Buffer.byteLength(files.documents.get(NAME) ?? ''));
  });

  it('should keep only the leading records of a retry and cut the rest of the tail', async () => {
    const files = new MemoryLog();
    const records = [{ text: 'one' }, { text: 'two' }];
    await append(files, EMPTY, [...records, { text: 'extra' }]);
    const retried = await append(files, EMPTY, records);
    should(files.documents.get(NAME)).equal('{"text":"one"}\n{"text":"two"}\n');
    should(retried).deepEqual({ bytes: Buffer.byteLength(files.documents.get(NAME) ?? ''), count: 2 });
    await append(files, EMPTY, [{ text: 'two' }, { text: 'one' }]);
    should(files.documents.get(NAME)).equal('{"text":"two"}\n{"text":"one"}\n');
  });

  it('should finish a torn append from its durable journal, then drop it when a different command appends', async () => {
    const files = new MemoryLog();
    files.failAppend = true;
    await should(append(files, EMPTY, [{ text: '雪 owner words' }])).be.rejectedWith('interrupted append');
    const after = await append(files, EMPTY, [{ text: 'other words' }]);
    should(after.count).equal(1);
    should(files.documents.get(NAME)).equal('{"text":"other words"}\n');
    should(files.documents.has(`${NAME}.pending`)).be.false();
  });

  it('should recover a fully appended journal without writing its records twice', async () => {
    const files = new MemoryLog();
    const text = '{"text":"雪 owner words"}\n';
    files.documents.set(NAME, text);
    files.documents.set(`${NAME}.pending`, JSON.stringify({ bytes: 0, text }));
    should(await append(files, EMPTY, [{ text: '雪 owner words' }])).deepEqual({
      bytes: Buffer.byteLength(text),
      count: 1,
    });
  });

  it('should cover exactly the complete lines of a log when no cursor was kept, leaving a torn last line out', () => {
    const text = Buffer.from('{"a":"雪"}\n{"b":1}\n{"c":');
    should(completeLinesCursor(text)).deepEqual({ bytes: Buffer.byteLength('{"a":"雪"}\n{"b":1}\n'), count: 2 });
    should(completeLinesCursor(Buffer.from('{"torn":'))).deepEqual({ bytes: 0, count: 0 });
    should(completeLinesCursor(new Uint8Array())).deepEqual({ bytes: 0, count: 0 });
  });

  it('should fail closed on a corrupt journal or tail without discarding any bytes', async () => {
    for (const [tail, journal] of [
      ['different\n', JSON.stringify({ bytes: 0, text: '{"text":"owner"}\n' })],
      ['incomplete', undefined],
      ['invalid json\n', undefined],
      ['', '{bad json'],
      ['', JSON.stringify({ bytes: -1, text: 'bad' })],
    ] as const) {
      const files = new MemoryLog();
      files.documents.set(NAME, tail);
      if (journal !== undefined) files.documents.set(`${NAME}.pending`, journal);
      await should(append(files, EMPTY, [{ text: 'new words' }])).be.rejected();
      should(files.documents.get(NAME)).equal(tail);
    }
  });
});
