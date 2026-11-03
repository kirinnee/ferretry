import { describe, it } from 'bun:test';
import should from 'should';
import { type AppendOnlyFiles, appendLogRecords } from '../../src/lib/append-only-log.ts';

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

  it('should replay a lagging cursor idempotently while retaining repeated records and unrelated uncommitted words', async () => {
    const files = new MemoryLog();
    const records = [{ text: 'same' }, { text: 'same' }];
    const first = await append(files, EMPTY, records);
    should(await append(files, EMPTY, records)).deepEqual(first);
    const next = await append(files, EMPTY, [{ text: 'another command' }]);
    should(next.count).equal(3);
    should(files.documents.get(NAME)?.split('\n').filter(Boolean)).have.length(3);
  });

  it('should finish a torn append from its durable journal before a different command appends', async () => {
    const files = new MemoryLog();
    files.failAppend = true;
    await should(append(files, EMPTY, [{ text: '雪 owner words' }])).be.rejectedWith('interrupted append');
    const after = await append(files, EMPTY, [{ text: 'other words' }]);
    should(after.count).equal(2);
    should(files.documents.get(NAME)).equal('{"text":"雪 owner words"}\n{"text":"other words"}\n');
    should(await append(files, EMPTY, [{ text: '雪 owner words' }, { text: 'other words' }])).deepEqual(after);
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
