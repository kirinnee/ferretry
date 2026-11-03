import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AppendOnlyFiles,
  appendLogRecords,
  commitLogAppend,
  completeLinesCursor,
  uncommittedLogFrom,
} from '../../src/lib/append-only-log.ts';

class MemoryLog implements AppendOnlyFiles {
  readonly documents = new Map<string, Uint8Array>();
  readonly reads: number[] = [];
  readonly truncations: number[] = [];
  failAppend = false;
  async read(_session: string, name: string) {
    const bytes = this.documents.get(name);
    return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');
  }
  async readAfter(_session: string, name: string, bytes: number) {
    this.reads.push(bytes);
    return (this.documents.get(name) ?? new Uint8Array()).subarray(bytes);
  }
  async writeAtomic(_session: string, name: string, text: string) {
    this.documents.set(name, Buffer.from(text));
  }
  async remove(_session: string, name: string) {
    this.documents.delete(name);
  }
  async truncate(_session: string, name: string, bytes: number) {
    this.truncations.push(bytes);
    this.documents.set(name, (this.documents.get(name) ?? new Uint8Array()).subarray(0, bytes));
  }
  async appendSynced(_session: string, name: string, bytes: Uint8Array) {
    // A torn append: a crash lands only the first bytes of the write.
    const landed = this.failAppend ? bytes.subarray(0, 10) : bytes;
    this.documents.set(name, Buffer.concat([this.documents.get(name) ?? new Uint8Array(), landed]));
    if (this.failAppend) {
      this.failAppend = false;
      throw new Error('interrupted append');
    }
  }
  text(name = NAME) {
    return Buffer.from(this.documents.get(name) ?? new Uint8Array()).toString('utf8');
  }
}
const EMPTY = { bytes: 0, count: 0 };
const NAME = 'history.jsonl';
const MARK = `${NAME}.pending`;
const append = (files: MemoryLog, cursor = EMPTY, records: readonly unknown[] = []) =>
  appendLogRecords(files, 'session-1', NAME, cursor, records);
const uncommitted = (files: MemoryLog) => uncommittedLogFrom(files, 'session-1', NAME);
const commit = (files: MemoryLog) => commitLogAppend(files, 'session-1', NAME);

describe('an append-only log', () => {
  it('should append UTF-8 words once, read only the cursor tail, and keep committed bytes unchanged', async () => {
    const files = new MemoryLog();
    const first = await append(files, EMPTY, [{ text: '雪 🦦' }]);
    await commit(files);
    const original = files.text();
    should(first).deepEqual({ bytes: Buffer.byteLength(original), count: 1 });
    const second = await append(files, first, [{ text: 'next' }]);
    should(files.text()).startWith(original);
    should(second.count).equal(2);
    should(files.reads).deepEqual([0, first.bytes]);
    should(files.truncations).deepEqual([]);
  });

  it('should leave a mark where an append began until its commit lands, and none after', async () => {
    const files = new MemoryLog();
    should(await uncommitted(files)).be.undefined();
    const first = await append(files, EMPTY, [{ text: 'one' }]);
    await commit(files);
    await append(files, first, [{ text: 'two' }]);
    should(await uncommitted(files)).equal(first.bytes);
    await commit(files);
    should(await uncommitted(files)).be.undefined();
    should(files.documents.has(MARK)).be.false();
    await commit(files);
  });

  it('should write nothing, mark nothing and keep the cursor when there are no records', async () => {
    const files = new MemoryLog();
    const cursor = { bytes: 3, count: 1 };
    should(await append(files, cursor, [])).equal(cursor);
    should(files.documents.size).equal(0);
    should(files.reads).deepEqual([]);
  });

  it('should write a retried append exactly once, however many times it is retried', async () => {
    const files = new MemoryLog();
    const records = [{ text: 'same' }, { text: 'same' }];
    const first = await append(files, EMPTY, records);
    should(await append(files, EMPTY, records)).deepEqual(first);
    should(await append(files, EMPTY, records)).deepEqual(first);
    should(files.text()).equal('{"text":"same"}\n{"text":"same"}\n');
    should(await uncommitted(files)).equal(0);
  });

  it('should cut the uncommitted records of a different command instead of adopting them', async () => {
    const files = new MemoryLog();
    const committed = await append(files, EMPTY, [{ text: 'committed 雪' }]);
    await commit(files);
    await append(files, committed, [{ text: 'rolled back' }]);
    const next = await append(files, committed, [{ text: 'another command' }]);
    should(next.count).equal(2);
    should(files.text()).equal('{"text":"committed 雪"}\n{"text":"another command"}\n');
    should(next.bytes).equal(Buffer.byteLength(files.text()));
    should(await uncommitted(files)).equal(committed.bytes);
  });

  it('should cut a torn append and a tail that is not even UTF-8, keeping every committed byte', async () => {
    const files = new MemoryLog();
    const committed = await append(files, EMPTY, [{ text: 'committed 雪' }]);
    await commit(files);
    files.failAppend = true;
    await should(append(files, committed, [{ text: '雪 owner words' }])).be.rejectedWith('interrupted append');
    should(files.text().length).be.above(committed.bytes);
    should(await uncommitted(files)).equal(committed.bytes);
    const after = await append(files, committed, [{ text: 'other words' }]);
    should(files.text()).equal('{"text":"committed 雪"}\n{"text":"other words"}\n');
    files.documents.set(NAME, Buffer.concat([Buffer.from(files.text()), Buffer.from([0xe9, 0x9b])]));
    const third = await append(files, after, [{ text: 'third' }]);
    should(files.text()).equal('{"text":"committed 雪"}\n{"text":"other words"}\n{"text":"third"}\n');
    should(third).deepEqual({ bytes: Buffer.byteLength(files.text()), count: 3 });
  });

  it('should read the mark of an earlier shape by where it began, and refuse a corrupt one', async () => {
    const files = new MemoryLog();
    await files.writeAtomic('session-1', MARK, JSON.stringify({ bytes: 7, text: '{"a":1}\n' }));
    should(await uncommitted(files)).equal(7);
    for (const corrupt of ['{bad json', JSON.stringify({ bytes: -1 }), JSON.stringify({ text: 'no start' })]) {
      await files.writeAtomic('session-1', MARK, corrupt);
      await should(uncommitted(files)).be.rejected();
    }
  });

  it('should cover exactly the complete lines of a log when no cursor was kept, leaving a torn last line out', () => {
    const text = Buffer.from('{"a":"雪"}\n{"b":1}\n{"c":');
    should(completeLinesCursor(text)).deepEqual({ bytes: Buffer.byteLength('{"a":"雪"}\n{"b":1}\n'), count: 2 });
    should(completeLinesCursor(Buffer.from('{"torn":'))).deepEqual({ bytes: 0, count: 0 });
    should(completeLinesCursor(new Uint8Array())).deepEqual({ bytes: 0, count: 0 });
  });
});
