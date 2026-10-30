import { afterEach, describe, it } from 'bun:test';
import { appendFile, link, mkdir, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  type BoundedTranscriptRead,
  DEFAULT_MAX_WINDOW_BYTES,
  NodeTranscriptFileRuntime,
  NodeTranscriptSource,
  type TranscriptFileInfo,
  type TranscriptFileRuntime,
  type TranscriptReadLimits,
  type TranscriptWatchHandle,
} from '../../../src/adapters/transcript/file-source.ts';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../src/lib/transcript/codex.ts';
import type {
  TranscriptBatch,
  TranscriptParser,
  TranscriptWindow,
  TranscriptWindowStart,
} from '../../../src/lib/transcript/types.ts';

/**
 * The window: an append-only read of a transcript that grows without limit.
 *
 * The property under test is COST. A 300 MB file is made sparse, so it costs no disk and no time to
 * write, and every byte the source reads goes through a counting runtime — what the window read is
 * then a number the test can bound, rather than a timing that would flake.
 */

const MiB = 1024 * 1024;
const T0 = Date.parse('2026-10-20T12:00:00.000Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-transcript-window-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function user(text: string, ms: number, padding = 0): string {
  return `${JSON.stringify({
    type: 'user',
    uuid: `u-${text}`,
    message: { role: 'user', content: `${text}${' '.repeat(padding)}` },
    // Where Claude writes it: at the END of the record.
    timestamp: at(ms),
  })}\n`;
}

function codexUser(text: string, ms: number): string {
  return `${JSON.stringify({
    // Where Codex writes it: at the START of the record.
    timestamp: at(ms),
    type: 'response_item',
    payload: { type: 'message', id: `c-${text}`, role: 'user', content: [{ type: 'input_text', text }] },
  })}\n`;
}

/** Records written `ms` in the past, `count` of them, each about `size` bytes. */
function history(count: number, size: number, ms: number): string {
  return Array.from({ length: count }, (_, index) => user(`old-${String(index)}`, ms, size)).join('');
}

/** The real runtime, counting every byte it hands the source, with faults that can be switched on. */
class CountingRuntime implements TranscriptFileRuntime {
  private readonly real = new NodeTranscriptFileRuntime();
  bytes = 0;
  failInfo = false;
  failRange = false;

  async info(file: string): Promise<TranscriptFileInfo | undefined> {
    if (this.failInfo) throw new Error('synthetic metadata fault');
    return await this.real.info(file);
  }

  async countNewlines(file: string, byteLength: number): Promise<number> {
    this.bytes += byteLength;
    return await this.real.countNewlines(file, byteLength);
  }

  async readTrailingLine(file: string, byteLength: number, byteLimit: number): Promise<BoundedTranscriptRead> {
    const read = await this.real.readTrailingLine(file, byteLength, byteLimit);
    this.bytes += read.bytes.byteLength;
    return read;
  }

  async readRange(file: string, byteOffset: number, byteLength: number): Promise<Uint8Array> {
    if (this.failRange) throw new Error('synthetic read fault');
    const bytes = await this.real.readRange(file, byteOffset, byteLength);
    this.bytes += bytes.byteLength;
    return bytes;
  }

  async readFrom(file: string, byteOffset: number, byteLimit: number): Promise<BoundedTranscriptRead> {
    const read = await this.real.readFrom(file, byteOffset, byteLimit);
    this.bytes += read.bytes.byteLength;
    return read;
  }

  watch(directory: string, onChange: () => void, onError: (error: Error) => void): TranscriptWatchHandle {
    return this.real.watch(directory, onChange, onError);
  }
}

function source(
  runtime: TranscriptFileRuntime,
  limits: TranscriptReadLimits = {},
  parser: TranscriptParser = new ClaudeTranscriptParser(),
): NodeTranscriptSource {
  return new NodeTranscriptSource(parser, runtime, { now: () => at(10 * 60_000) }, limits);
}

/** Every step until the window reaches the end of the file. */
async function drain(window: TranscriptWindow): Promise<TranscriptBatch[]> {
  const batches: TranscriptBatch[] = [];
  for (;;) {
    const { batch, more } = await window.next();
    if (batch !== undefined) batches.push(batch);
    if (!more) return batches;
  }
}

const texts = (batches: readonly TranscriptBatch[]): string[] =>
  batches.flatMap(batch => batch.observedInputs.map(input => input.text.trim()));

const since = (ms: number): TranscriptWindowStart => ({ at: 'since', instant: at(ms) });

describe('a window over a 300 MB transcript', () => {
  it('reads what was written since the instant, not the file, and then only what is appended', async () => {
    // Arrange: 300 MB of history the window must never read, then an hour-old stretch, then the send.
    const file = join(await temporaryDirectory(), 'adopted.jsonl');
    await writeFile(file, '');
    await truncate(file, 300 * MiB);
    await appendFile(file, `\n${history(400, 5_000, -60 * 60_000)}${user('hi', 1_000)}`);
    const runtime = new CountingRuntime();
    const window = source(runtime).window(file, { sessionId: 's', start: since(0) });

    // Act
    const first = await drain(window);
    const placed = runtime.bytes;
    await appendFile(file, user('and the docs', 2_000));
    const appended = await drain(window);
    const idle = await window.next();

    // Assert: the scan and the read cost a couple of chunks, never the 300 MB before them.
    should(texts(first).at(-1)).equal('hi');
    should(placed).be.below(4 * MiB);
    should(texts(appended)).eql(['and the docs']);
    should(runtime.bytes - placed).be.below(16 * 1024);
    should(idle).eql({ more: false });
    // Mid-file, a line number would name some other line, so none is served.
    should(first[0]?.cursor.nextLine).be.undefined();
    should(first[0]?.events.every(event => event.line === undefined)).be.true();
  });

  it('starts at its byte limit when the instant is further back than that, and says so', async () => {
    const file = join(await temporaryDirectory(), 'busy.jsonl');
    await writeFile(file, history(600, 2_000, 0));
    const runtime = new CountingRuntime();
    const window = source(runtime, { maxWindowBytes: MiB }).window(file, { sessionId: 's', start: since(-60_000) });

    const batches = await drain(window);

    should(batches[0]?.issues[0]).match({
      code: 'window-capped',
      message: 'transcript window reached its byte limit before the requested instant',
      byteOffset: 0,
    });
    should(runtime.bytes).be.below(3 * MiB);
    // Placed on a record boundary: every record it read is whole.
    should(
      batches
        .flatMap(batch => batch.issues)
        .filter(issue => issue.code !== 'window-capped' && issue.code !== 'source-truncated'),
    ).eql([]);
    should(DEFAULT_MAX_WINDOW_BYTES).equal(256 * MiB);
  });

  it('carries its limit notice on its own when there is nothing to read past it', async () => {
    const file = join(await temporaryDirectory(), 'unterminated.jsonl');
    await writeFile(file, `${user('old', -60_000)}${'x'.repeat(2 * MiB)}`);

    const step = await source(new CountingRuntime(), { maxWindowBytes: MiB })
      .window(file, { sessionId: 's', start: since(0) })
      .next();

    should(step.batch?.issues.map(issue => issue.code)).eql(['window-capped']);
    should(step.batch?.cursor.byteOffset).equal(user('old', -60_000).length + 2 * MiB);
  });

  it('carries its limit notice on its own when the file is replaced under its first read', async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, 'replaced.jsonl');
    await writeFile(file, `${user('old', -60_000)}${'x'.repeat(2 * MiB)}\n${user('new', 1_000)}`);
    await writeFile(`${file}.next`, user('other', 1_000));
    // The read lands, then the file is swapped before the window checks it is still the one it read:
    // that read is discarded and no batch comes of it, so the notice placement owes rides alone.
    const runtime = new (class extends CountingRuntime {
      override async readFrom(path: string, byteOffset: number, byteLimit: number): Promise<BoundedTranscriptRead> {
        const read = await super.readFrom(path, byteOffset, byteLimit);
        await rename(`${file}.next`, file);
        return read;
      }
    })();

    const step = await source(runtime, { maxWindowBytes: MiB })
      .window(file, { sessionId: 's', start: since(0) })
      .next();

    should(step.batch?.issues.map(issue => issue.code)).eql(['window-capped']);
    should(step.batch?.events).eql([]);
  });

  it('scans back past a chunk that holds no timestamp or no record boundary', async () => {
    const file = join(await temporaryDirectory(), 'tools.jsonl');
    // A huge old tool result (no boundary inside a chunk), then a stretch with no timestamp at all.
    const blob = `${JSON.stringify({ type: 'progress', data: 'y'.repeat(3 * MiB) })}\n`;
    await writeFile(file, `${user('older', -120_000)}${user('before', -60_000, 3 * MiB)}${blob}${user('hi', 1_000)}`);

    const batches = await drain(source(new CountingRuntime()).window(file, { sessionId: 's', start: since(0) }));

    should(texts(batches)).eql(['hi']);
  });

  it('starts at the beginning when nothing in the file is older than the instant', async () => {
    const file = join(await temporaryDirectory(), 'young.jsonl');
    await writeFile(file, `${user('a', 1_000)}${user('b', 2_000)}`);

    const batches = await drain(source(new CountingRuntime()).window(file, { sessionId: 's', start: since(0) }));

    should(texts(batches)).eql(['a', 'b']);
    should(batches[0]?.cursor.nextLine).equal(3);
    should(batches[0]?.events[0]?.line).equal(1);
  });

  it('finds the instant in a Codex rollout, whose records stamp it first', async () => {
    const file = join(await temporaryDirectory(), 'rollout.jsonl');
    const old = Array.from({ length: 300 }, (_, index) =>
      codexUser(`old-${String(index)}-${'z'.repeat(5_000)}`, -60_000),
    );
    await writeFile(file, `${old.join('')}${codexUser('hi', 1_000)}`);
    const runtime = new CountingRuntime();

    const batches = await drain(
      source(runtime, {}, new CodexTranscriptParser()).window(file, { sessionId: 's', start: since(0) }),
    );

    should(texts(batches).at(-1)).equal('hi');
    should(texts(batches).length).be.below(300);
  });
});

describe('a window from the end', () => {
  it('starts on the first record boundary inside the last bytes, keeping a record that starts on it', async () => {
    const file = join(await temporaryDirectory(), 'tail.jsonl');
    const last = user('last', 2_000);
    await writeFile(file, `${user('first', 0)}${user('middle', 1_000)}${last}`);

    const exact = await drain(
      source(new CountingRuntime()).window(file, { sessionId: 's', start: { at: 'tail', bytes: last.length } }),
    );
    const inside = await drain(
      source(new CountingRuntime()).window(file, { sessionId: 's', start: { at: 'tail', bytes: last.length + 10 } }),
    );
    const whole = await drain(
      source(new CountingRuntime()).window(file, { sessionId: 's', start: { at: 'tail', bytes: MiB } }),
    );

    should(texts(exact)).eql(['last']);
    should(texts(inside)).eql(['last']);
    should(texts(whole)).eql(['first', 'middle', 'last']);
    should(whole[0]?.cursor.nextLine).equal(4);
  });

  it('places nothing past the end when the tail holds no boundary, and says it began mid-file', async () => {
    const file = join(await temporaryDirectory(), 'one.jsonl');
    const content = `${user('a', 0)}${'x'.repeat(100)}`;
    await writeFile(file, content);

    const step = await source(new CountingRuntime())
      .window(file, { sessionId: 's', start: { at: 'tail', bytes: 10 } })
      .next();

    // An empty batch rather than none: its cursor, which numbers no line, is how a tail learns the
    // window began after byte zero and that a wider one would find the records before it.
    should(step.more).be.false();
    should(step.batch?.events).eql([]);
    should(step.batch?.cursor).eql({
      identity: step.batch?.cursor.identity,
      byteOffset: Buffer.byteLength(content),
      pendingBytes: 0,
    });
  });
});

describe('a window that cannot be placed yet', () => {
  it('says why, and places itself from the instant once the file can be read — never from byte zero', async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, 'later.jsonl');
    const runtime = new CountingRuntime();
    const window = source(runtime).window(file, { sessionId: 's', start: since(0) });

    const missing = await window.next();
    await mkdir(file);
    const notAFile = await window.next();
    await rm(file, { recursive: true });
    await writeFile(file, `${history(1_000, 5_000, -60_000)}${user('new', 1_000)}`);
    runtime.failInfo = true;
    const noMetadata = await window.next();
    runtime.failInfo = false;
    runtime.failRange = true;
    const noBytes = await window.next();
    runtime.failRange = false;
    const placed = await drain(window);

    should(missing.batch?.issues.map(issue => issue.code)).eql(['source-missing']);
    should(notAFile.batch?.issues[0]).match({
      code: 'source-read-failed',
      message: 'transcript source is not a regular file',
    });
    should(noMetadata.batch?.issues[0]).match({ message: 'transcript file metadata could not be read' });
    should(noBytes.batch?.issues[0]).match({ message: 'transcript window could not be placed' });
    should(texts(placed).at(-1)).equal('new');
    should(texts(placed).length).be.below(500);
  });

  it('reads from the beginning for a start it cannot use', async () => {
    const file = join(await temporaryDirectory(), 'all.jsonl');
    await writeFile(file, `${user('a', -60_000)}${user('b', 0)}`);

    const unusable = await drain(
      source(new CountingRuntime()).window(file, { sessionId: 's', start: { at: 'since', instant: 'not an instant' } }),
    );
    const beginning = await drain(
      source(new CountingRuntime()).window(file, { sessionId: 's', start: { at: 'beginning' } }),
    );
    const nonsense = await drain(
      source(new CountingRuntime()).window(file, { sessionId: 's', start: { at: 'tail', bytes: Number.NaN } }),
    );

    should(texts(unusable)).eql(['a', 'b']);
    should(texts(beginning)).eql(['a', 'b']);
    should(texts(nonsense)).eql(['a', 'b']);
  });
});

describe('a held window over a live file', () => {
  it('reads a large file in bounded steps, carrying a partial last line until it is whole', async () => {
    const file = join(await temporaryDirectory(), 'steps.jsonl');
    await writeFile(file, history(40, 2_000, 0));
    const window = source(new CountingRuntime(), { maxReadBytes: 16 * 1024 }).window(file, {
      sessionId: 's',
      start: { at: 'beginning' },
    });

    const steps = [];
    for (;;) {
      const step = await window.next();
      steps.push(step);
      if (!step.more) break;
    }
    const half = user('whole', 1_000);
    await appendFile(file, half.slice(0, 40));
    const partial = await window.next();
    await appendFile(file, half.slice(40));
    const completed = await window.next();

    should(steps.length).be.above(4);
    should(steps.flatMap(step => step.batch?.observedInputs ?? [])).have.length(40);
    should(partial.batch?.observedInputs).eql([]);
    should(partial.batch?.issues.map(issue => issue.code)).eql(['incomplete-line']);
    should(texts(completed.batch === undefined ? [] : [completed.batch])).eql(['whole']);
  });

  it('restarts and says so when the file is replaced, and reads a hard link as the same file', async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, 'conversation.jsonl');
    const linked = join(directory, 'linked.jsonl');
    await writeFile(file, `${user('old', -60_000)}${user('a', 1_000)}`);
    await link(file, linked);
    const window = source(new CountingRuntime()).window(linked, { sessionId: 's', start: since(0) });

    const first = await drain(window);
    await appendFile(file, user('through the other name', 2_000));
    const shared = await drain(window);
    await writeFile(join(directory, 'next.jsonl'), user('replacement', 3_000));
    await rename(join(directory, 'next.jsonl'), linked);
    const replaced = await drain(window);

    // A file smaller than one scan chunk is read whole: older records are harmless, never missing.
    should(texts(first)).eql(['old', 'a']);
    should(texts(shared)).eql(['through the other name']);
    should(replaced[0]?.reset).be.true();
    should(texts(replaced)).eql(['replacement']);
  });
});
