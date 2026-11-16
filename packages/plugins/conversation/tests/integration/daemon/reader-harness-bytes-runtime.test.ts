import { describe, it } from 'bun:test';
import should from 'should';
import {
  BYTES_WINDOW,
  HarnessBytesRuntime,
  MAX_REGISTERED,
  type TranscriptBytesHandle,
} from '../../../daemon/reader/adapters/harness-bytes-runtime.ts';
import { BytesRecordScanner } from '../../../daemon/reader/adapters/record-scan.ts';

/** An in-memory harness handle: a file that can be replaced (its reads then reject, as a harness's do). */
class FakeHandle implements TranscriptBytesHandle {
  readonly format = 'claude' as const;
  replaced = false;
  closed = false;
  reads: { offset: number; length: number }[] = [];
  mtimeMs = 1;
  constructor(
    readonly file: string,
    public bytes: Uint8Array,
  ) {}
  get size(): number {
    return this.bytes.byteLength;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (this.closed) throw new Error('closed');
    if (this.replaced) throw Object.assign(new Error('replaced'), { name: 'HarnessTranscriptReplaced' });
    this.reads.push({ offset, length });
    // A handle clamps a window, as the kernel's root handle does.
    return this.bytes.slice(offset, offset + Math.min(length, BYTES_WINDOW));
  }
  async stat(): Promise<{ size: number; mtimeMs: number } | undefined> {
    return this.replaced || this.closed ? undefined : { size: this.bytes.byteLength, mtimeMs: this.mtimeMs };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('HarnessBytesRuntime', () => {
  it('should read a range larger than one window by looping windows of at most 4 MiB', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const bytes = new Uint8Array(BYTES_WINDOW * 2 + 10).fill(7);
    const handle = new FakeHandle('t', bytes);
    const token = await runtime.adopt(handle);

    // Act
    const actual = await runtime.readRange(token, 5, bytes.byteLength - 5);

    // Assert
    should(actual.byteLength).equal(bytes.byteLength - 5);
    should(handle.reads.map(each => each.length)).deepEqual([BYTES_WINDOW, BYTES_WINDOW, 5]);
    should(handle.reads.every(each => each.length <= BYTES_WINDOW)).be.true();
  });

  it('should answer a short read where the file ends, and an empty one past it', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const token = await runtime.adopt(new FakeHandle('t', text('abcdef')));

    // Act
    const short = await runtime.readRange(token, 4, 100);
    const past = await runtime.readRange(token, 600, 10);

    // Assert
    should(Buffer.from(short).toString()).equal('ef');
    should(past.byteLength).equal(0);
  });

  it('should describe a file by its token, size and modification time, and a gone file as absent', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const handle = new FakeHandle('tok', text('one\ntwo\n'));
    const token = await runtime.adopt(handle);

    // Act
    const info = await runtime.info(token);
    const fingerprint = await runtime.fingerprint(token);
    handle.replaced = true;
    const after = await runtime.info(token);

    // Assert
    should(info).deepEqual({ identity: 'tok', size: 8, modifiedMs: 1, isFile: true });
    should(fingerprint).deepEqual({ size: 8, mtimeMs: 1 });
    should(after).be.undefined();
    should(await runtime.info('unknown')).be.undefined();
  });

  it('should spell a replaced or forgotten file as ENOENT, which the source reads as missing', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const handle = new FakeHandle('tok', text('abc\n'));
    const token = await runtime.adopt(handle);
    handle.replaced = true;

    // Act
    const replaced = await runtime.readRange(token, 0, 4).catch((error: unknown) => error);
    const forgotten = await runtime.readFrom('never-adopted', 0, 4).catch((error: unknown) => error);

    // Assert
    should(replaced).have.property('code', 'ENOENT');
    should(forgotten).have.property('code', 'ENOENT');
  });

  it('should let any other read failure through as itself', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const handle = new FakeHandle('tok', text('abc\n'));
    handle.read = async () => {
      throw new Error('disk on fire');
    };
    const token = await runtime.adopt(handle);

    // Act
    const actual = await runtime.readRange(token, 0, 4).catch((error: unknown) => error);

    // Assert
    should((actual as Error).message).equal('disk on fire');
  });

  it('should count newlines, find the trailing line and say when it stopped at its limit', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const token = await runtime.adopt(new FakeHandle('t', text('a\nbb\nccc')));

    // Act
    const lines = await runtime.countNewlines(token, 8);
    const trailing = await runtime.readTrailingLine(token, 8, 100);
    const bounded = await runtime.readTrailingLine(token, 8, 2);
    const none = await runtime.readTrailingLine(token, 0, 100);

    // Assert
    should(lines).equal(2);
    should(Buffer.from(trailing.bytes).toString()).equal('ccc');
    should(trailing.truncated).be.false();
    should(bounded.truncated).be.true();
    should(none).deepEqual({ bytes: new Uint8Array(), truncated: false });
  });

  it('should say a capped read was capped only when bytes remain past the cap', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const token = await runtime.adopt(new FakeHandle('t', text('abcdef')));

    // Act
    const exact = await runtime.readFrom(token, 0, 6);
    const short = await runtime.readFrom(token, 0, 5);
    const none = await runtime.readFrom(token, 0, 0);

    // Assert
    should(exact.truncated).be.false();
    should(Buffer.from(short.bytes).toString()).equal('abcde');
    should(short.truncated).be.true();
    should(none.truncated).be.true();
  });

  it('should keep ONE handle per owner, closing a duplicate of the file it holds', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const first = new FakeHandle('same', text('x'));
    const again = new FakeHandle('same', text('x'));

    // Act
    await runtime.adopt(first, 'ferret');
    await runtime.adopt(again, 'ferret');

    // Assert
    should(runtime.handle('same')).equal(first);
    should(first.closed).be.false();
    should(again.closed).be.true();
  });

  it('should close the held handle when the owner’s file is replaced by another', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const old = new FakeHandle('gen-1', text('x'));
    const next = new FakeHandle('gen-2', text('y'));
    await runtime.adopt(old, 'ferret');

    // Act
    await runtime.adopt(next, 'ferret');

    // Assert
    should(old.closed).be.true();
    should(next.closed).be.false();
    should(runtime.handle('gen-1')).be.undefined();
    should(runtime.handle('gen-2')).equal(next);
  });

  it('should replace a held handle that closed itself, instead of reading through a dead one', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const held = new FakeHandle('same', text('x'));
    await runtime.adopt(held, 'ferret');
    held.closed = true;
    const fresh = new FakeHandle('same', text('x'));

    // Act
    await runtime.adopt(fresh, 'ferret');

    // Assert
    should(runtime.handle('same')).equal(fresh);
    should(fresh.closed).be.false();
  });

  it('should close the oldest owner’s handle once more than its bound are held', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const handles = Array.from(
      { length: MAX_REGISTERED + 1 },
      (_, index) => new FakeHandle(`t${String(index)}`, text('x')),
    );
    for (const handle of handles) await runtime.adopt(handle);

    // Assert
    should(handles[0]?.closed).be.true();
    should(handles.slice(1).every(handle => !handle.closed)).be.true();
    should(runtime.handle('t0')).be.undefined();
    should(runtime.handle(`t${String(MAX_REGISTERED)}`)).not.be.undefined();
  });

  it('should close every handle it holds, once, when asked', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const handles = [new FakeHandle('a', text('x')), new FakeHandle('b', text('y'))];
    for (const handle of handles) await runtime.adopt(handle);

    // Act
    await runtime.closeAll();
    await runtime.closeAll();

    // Assert
    should(handles.every(handle => handle.closed)).be.true();
    should(runtime.handle('a')).be.undefined();
  });
});

describe('BytesRecordScanner', () => {
  const scan = async (
    body: string,
    needle: string | undefined,
    chunk?: number,
    maxRecord?: number,
  ): Promise<string[]> => {
    const runtime = new HarnessBytesRuntime();
    const token = await runtime.adopt(new FakeHandle('t', text(body)));
    const out: string[] = [];
    for await (const range of new BytesRecordScanner(runtime, chunk, maxRecord).records(token, needle)) {
      out.push(body.slice(range.start, range.end));
    }
    return out;
  };

  it('should yield every record newest first when given no needle', async () => {
    // Arrange / Act
    const actual = await scan('one\ntwo\nthree\n', undefined);

    // Assert
    should(actual).deepEqual(['three\n', 'two\n', 'one\n']);
  });

  it('should yield only the records whose raw bytes hold the needle, case folded', async () => {
    // Arrange / Act
    const actual = await scan('alpha\nBeta NEEDLE\ngamma\nneedle again\ndelta\n', 'needle');

    // Assert
    should(actual).deepEqual(['needle again\n', 'Beta NEEDLE\n']);
  });

  it('should find records across chunk boundaries and a record longer than a chunk', async () => {
    // Arrange
    const long = `${'y'.repeat(50)}\n`;
    const body = `first\n${long}last\n`;

    // Act
    const actual = await scan(body, undefined, 8);

    // Assert
    should(actual).deepEqual(['last\n', long, 'first\n']);
  });

  it('should step over a record longer than its bound (v4: a fragment may surface) and go on to the older ones', async () => {
    // Arrange
    const huge = `${'z'.repeat(64)}\n`;
    const body = `old\n${huge}new\n`;

    // Act
    const actual = await scan(body, undefined, 8, 32);

    // Assert
    should(actual[0]).equal('new\n');
    should(actual.at(-1)).equal('old\n');
    should(actual).not.containEql(huge);
  });

  it('should yield nothing for a file that is not there', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const out: unknown[] = [];

    // Act
    for await (const range of new BytesRecordScanner(runtime).records('absent', undefined)) out.push(range);

    // Assert
    should(out).have.length(0);
  });
});

describe('HarnessBytesRuntime shutdown and release', () => {
  it('should close a handle whose adoption was suspended on the held handle’s stat when closeAll ran', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const first = new FakeHandle('same', text('a'));
    await runtime.adopt(first, 'lead');
    let settle!: (value: undefined) => void;
    first.stat = () =>
      new Promise(resolve => {
        settle = resolve;
      });
    const next = new FakeHandle('same', text('a'));

    // Act
    const adopting = runtime.adopt(next, 'lead');
    await runtime.closeAll();
    settle(undefined);
    await adopting;

    // Assert
    should(next.closed).be.true();
    should(runtime.handle('same')).be.undefined();
  });

  it('should close, and never register, a handle adopted after closeAll', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    await runtime.closeAll();
    const late = new FakeHandle('late', text('a'));

    // Act
    const token = await runtime.adopt(late, 'lead');

    // Assert
    should(late.closed).be.true();
    should(runtime.handle(token)).be.undefined();
    await should(runtime.info(token)).resolvedWith(undefined);
  });

  it('should close the handle held for one owner on releaseOwner and leave the others', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const mine = new FakeHandle('mine', text('a'));
    const other = new FakeHandle('other', text('b'));
    await runtime.adopt(mine, 'f1');
    await runtime.adopt(other, 'f2');

    // Act
    runtime.releaseOwner('f1');
    runtime.releaseOwner('nobody');

    // Assert
    should(mine.closed).be.true();
    should(runtime.handle('mine')).be.undefined();
    should(other.closed).be.false();
    should(runtime.handle('other')).equal(other);
  });

  it('should adopt a fresh handle for an owner after its release', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    await runtime.adopt(new FakeHandle('mine', text('a')), 'f1');
    runtime.releaseOwner('f1');
    const again = new FakeHandle('mine', text('a'));

    // Act
    const token = await runtime.adopt(again, 'f1');

    // Assert
    should(again.closed).be.false();
    should(runtime.handle(token)).equal(again);
  });

  it('should close a handle opened before its owner was released, and register nothing', async () => {
    // Arrange: the opener was in flight when the release came
    const runtime = new HarnessBytesRuntime();
    const generation = runtime.generation('f1');
    const late = new FakeHandle('late', text('a'));
    runtime.releaseOwner('f1');

    // Act
    const token = await runtime.adopt(late, 'f1', generation);

    // Assert
    should(late.closed).be.true();
    should(runtime.handle(token)).be.undefined();
  });

  it('should close a handle whose adoption was suspended on the held handle’s stat when its owner was released', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const first = new FakeHandle('same', text('a'));
    await runtime.adopt(first, 'f1');
    let settle!: (value: { size: number; mtimeMs: number }) => void;
    first.stat = () =>
      new Promise(resolve => {
        settle = resolve;
      });
    const next = new FakeHandle('same', text('a'));
    const generation = runtime.generation('f1');

    // Act
    const adopting = runtime.adopt(next, 'f1', generation);
    runtime.releaseOwner('f1');
    settle({ size: 1, mtimeMs: 1 });
    await adopting;

    // Assert
    should(next.closed).be.true();
    should(runtime.handle('same')).be.undefined();
  });

  it('should adopt a handle opened after the release, and leave other owners’ generations alone', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    runtime.releaseOwner('f1');
    const generation = runtime.generation('f1');
    const fresh = new FakeHandle('fresh', text('a'));

    // Act
    const token = await runtime.adopt(fresh, 'f1', generation);

    // Assert
    should(fresh.closed).be.false();
    should(runtime.handle(token)).equal(fresh);
    should(runtime.generation('f2')).equal(0);
    should(runtime.generation('f1')).equal(1);
  });

  it('should keep adopting normally when no release came and a generation is passed', async () => {
    // Arrange
    const runtime = new HarnessBytesRuntime();
    const handle = new FakeHandle('same', text('a'));

    // Act
    const token = await runtime.adopt(handle, 'f1', runtime.generation('f1'));

    // Assert
    should(handle.closed).be.false();
    should(runtime.handle(token)).equal(handle);
  });
});
