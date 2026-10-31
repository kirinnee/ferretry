import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  type BoundedTranscriptRead,
  NodeTranscriptFileRuntime,
  NodeTranscriptSource,
  type TranscriptFileInfo,
  type TranscriptFileRuntime,
  type TranscriptWatchHandle,
} from '../../../../src/adapters/transcript/file-source.ts';
import { readTranscriptPage, type TranscriptPage, tailPage } from '../../../../src/lib/session/transcript/log-page.ts';
import { tailTranscriptEvents } from '../../../../src/lib/session/transcript/reader.ts';
import { ClaudeTranscriptParser } from '../../../../src/lib/transcript/claude.ts';
import type { TranscriptEvent, TranscriptSource } from '../../../../src/lib/transcript/types.ts';

/**
 * Scrolling a long chat all the way back to its first message.
 *
 * The chat could only ever show a session's newest events: in a 400 MB conversation the reader scrolled
 * up into a wall. These tests page a real transcript backwards the way the chat now does — the tail,
 * then each page `before` the last one's `start` — and prove the pages laid end to end are EXACTLY the
 * conversation: every event once, in order, none missing at a page seam, a record never split, and no
 * page stuck in place. The transcript is the awkward kind on purpose: records of several events,
 * screenshots, bookkeeping lines with nothing to show, and records straddling the 8 MiB step a window
 * reads at a time (#1058).
 */

const KiB = 1024;
const MiB = 1024 * KiB;
const SESSION = 'log-page-session';
const T0 = Date.parse('2026-10-20T12:00:00.000Z');
const at = (index: number): string => new Date(T0 + index * 1000).toISOString();

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function transcriptFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-log-page-'));
  temporaryDirectories.push(directory);
  return join(directory, 'transcript.jsonl');
}

const line = (record: object): string => `${JSON.stringify(record)}\n`;

const userRecord = (index: number, padding = 0): string =>
  line({
    type: 'user',
    uuid: `u-${String(index)}`,
    message: { role: 'user', content: `message ${String(index)}${' '.repeat(padding)}` },
    timestamp: at(index),
  });

/** One record, three events: thinking, the reply and a tool call. */
const assistantRecord = (index: number): string =>
  line({
    type: 'assistant',
    uuid: `a-${String(index)}`,
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: `thinking ${String(index)}` },
        { type: 'text', text: `reply ${String(index)}` },
        { type: 'tool_use', id: `tool-${String(index)}`, name: 'Bash', input: { command: `echo ${String(index)}` } },
      ],
    },
    timestamp: at(index),
  });

/** A tool result carrying a screenshot of `bytes` base64 characters. */
const screenshotRecord = (index: number, bytes: number): string =>
  line({
    type: 'user',
    uuid: `r-${String(index)}`,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `tool-${String(index - 1)}`,
          content: [
            { type: 'text', text: `result ${String(index)}` },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(bytes) } },
          ],
        },
      ],
    },
    timestamp: at(index),
  });

/** A record the chat has nothing to show for. */
const bookkeepingRecord = (index: number, padding = 0): string =>
  line({ type: 'file-history-snapshot', messageId: `f-${String(index)}`, padding: ' '.repeat(padding) });

/** The real runtime, counting what it hands the source. */
class CountingRuntime implements TranscriptFileRuntime {
  private readonly real = new NodeTranscriptFileRuntime();
  bytes = 0;

  async info(file: string): Promise<TranscriptFileInfo | undefined> {
    return await this.real.info(file);
  }
  async readFrom(file: string, byteOffset: number, byteLimit: number): Promise<BoundedTranscriptRead> {
    const read = await this.real.readFrom(file, byteOffset, byteLimit);
    this.bytes += read.bytes.byteLength;
    return read;
  }
  async readRange(file: string, byteOffset: number, byteLength: number): Promise<Uint8Array> {
    const bytes = await this.real.readRange(file, byteOffset, byteLength);
    this.bytes += bytes.byteLength;
    return bytes;
  }
  async countNewlines(file: string, byteLength: number): Promise<number> {
    return await this.real.countNewlines(file, byteLength);
  }
  async readTrailingLine(file: string, byteOffset: number, maxBytes: number): Promise<BoundedTranscriptRead> {
    return await this.real.readTrailingLine(file, byteOffset, maxBytes);
  }
  watch(directory: string, onChange: () => void, onError: (error: Error) => void): TranscriptWatchHandle {
    return this.real.watch(directory, onChange, onError);
  }
}

/** Every event of `file`, read forward from byte zero: the conversation the pages must add up to. */
async function wholeConversation(source: TranscriptSource, file: string): Promise<readonly TranscriptEvent[]> {
  const window = source.window(file, { sessionId: SESSION, start: { at: 'beginning' } });
  const events: TranscriptEvent[] = [];
  for (;;) {
    const { batch, more } = await window.next();
    if (batch !== undefined) events.push(...batch.events);
    if (!more) return events;
  }
}

/** Where an event is, and which of its record's events it is: enough to tell any two apart. */
const coordinate = (event: TranscriptEvent): string =>
  `${String(event.byteOffset)}#${String(event.blockIndex ?? '-')}:${event.kind}`;

/** The tail, then every page before it, to the start of the file — as the chat scrolls up. */
async function scrollToTheTop(
  source: TranscriptSource,
  file: string,
  size: number,
  limit: number,
  scan?: { readonly growth: readonly number[]; readonly max: number },
): Promise<{ readonly events: readonly TranscriptEvent[]; readonly pages: readonly TranscriptPage[] }> {
  const tail =
    tailPage(await tailTranscriptEvents(source, file, SESSION, limit), limit, size) ??
    (await readTranscriptPage(source, file, SESSION, { from: 0, before: size, limit }));
  const pages: TranscriptPage[] = [tail];
  let events = [...tail.events];
  let start = tail.start;
  while (start > 0) {
    const range = { from: 0, before: start, limit };
    const page =
      scan === undefined
        ? await readTranscriptPage(source, file, SESSION, range)
        : await readTranscriptPage(source, file, SESSION, range, scan.growth, scan.max);
    // Every page moves back: a page stuck at its own `before` is the wall this exists to remove.
    should(page.start).be.below(start);
    pages.push(page);
    events = [...page.events, ...events];
    start = page.start;
    should(pages.length).be.below(10_000);
  }
  return { events, pages };
}

describe('paging a transcript back to its first message', () => {
  it('lays the pages of a mixed transcript past the 8 MiB step end to end, with nothing lost or repeated', async () => {
    const file = await transcriptFile();
    await writeFile(file, '');
    // ~20 MiB: messages, three-event records, screenshots of up to 1.5 MiB, bookkeeping lines, and
    // padded records so several straddle each 8 MiB step a window reads.
    let index = 0;
    let chunk = '';
    for (let round = 0; round < 900; round += 1) {
      chunk += userRecord(index++, round % 3 === 0 ? 40 * KiB : 0);
      chunk += assistantRecord(index++);
      chunk += round % 9 === 0 ? screenshotRecord(index++, (round % 3) * 512 * KiB + 64 * KiB) : '';
      chunk += round % 4 === 0 ? bookkeepingRecord(index++, round % 8 === 0 ? 30 * KiB : 0) : '';
      if (chunk.length > MiB) {
        await appendFile(file, chunk);
        chunk = '';
      }
    }
    await appendFile(file, chunk);
    const runtime = new CountingRuntime();
    const source = new NodeTranscriptSource(new ClaudeTranscriptParser(), runtime);
    const size = (await runtime.info(file))?.size ?? 0;
    should(size).be.above(16 * MiB);

    const whole = await wholeConversation(source, file);
    const { events, pages } = await scrollToTheTop(source, file, size, 50);

    should(events.map(coordinate)).eql(whole.map(coordinate));
    should(pages.length).be.above(10);
    // A page never begins inside a record: its first event is the first event of that record.
    for (const page of pages) {
      const first = page.events[0];
      if (first === undefined) continue;
      const record = whole.findIndex(event => event.byteOffset === first.byteOffset);
      should(coordinate(whole[record] as TranscriptEvent)).equal(coordinate(first));
    }
  }, 60_000);

  it('reads only about what a page covers, never a whole step past its end', async () => {
    const file = await transcriptFile();
    // 24 MiB of small records; a 50-event page near the end is a few kilobytes.
    const records: string[] = [];
    for (let index = 0; index < 1_000; index += 1) records.push(userRecord(index, 24 * KiB));
    await writeFile(file, records.join(''));
    const runtime = new CountingRuntime();
    const source = new NodeTranscriptSource(new ClaudeTranscriptParser(), runtime);
    const size = (await runtime.info(file))?.size ?? 0;

    runtime.bytes = 0;
    const page = await readTranscriptPage(source, file, SESSION, { from: 0, before: size - 10 * MiB, limit: 10 });

    should(page.events.length).equal(10);
    // The page is ten records of 24 KiB inside its first 512 KiB window, and placing that window scans
    // ahead for a boundary. A window with no end would have read a whole 8 MiB step from where it began.
    should(runtime.bytes).be.below(2 * MiB);
  });

  it('fills exactly the gap between two offsets, for a tail that moved on while older pages were held', async () => {
    const file = await transcriptFile();
    await writeFile(file, Array.from({ length: 300 }, (_, index) => userRecord(index)).join(''));
    const source = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const whole = await wholeConversation(source, file);
    const from = whole[100]?.byteOffset ?? 0;
    const before = whole[160]?.byteOffset ?? 0;

    const gap = await readTranscriptPage(source, file, SESSION, { from, before, limit: 2_000 });

    should(gap.start).equal(from);
    should(gap.events.map(coordinate)).eql(whole.slice(100, 160).map(coordinate));
  });

  it('steps back over a stretch with nothing to show rather than stopping in front of it', async () => {
    const file = await transcriptFile();
    // 64 KiB of bookkeeping between two conversations, against a scan of only 8 KiB a page.
    const early = Array.from({ length: 20 }, (_, index) => userRecord(index)).join('');
    const quiet = Array.from({ length: 64 }, (_, index) => bookkeepingRecord(index, KiB)).join('');
    const late = Array.from({ length: 20 }, (_, index) => userRecord(100 + index)).join('');
    await writeFile(file, early + quiet + late);
    const source = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const size = Buffer.byteLength(early + quiet + late);
    const whole = await wholeConversation(source, file);

    const { events, pages } = await scrollToTheTop(source, file, size, 10, { growth: [2 * KiB], max: 8 * KiB });

    should(events.map(coordinate)).eql(whole.map(coordinate));
    // Some pages found nothing at all, and the walk went on through them.
    should(pages.some(page => page.events.length === 0)).be.true();
  });

  it('keeps a record of more events than the page holds whole, rather than splitting it', async () => {
    const file = await transcriptFile();
    await writeFile(file, [userRecord(0), assistantRecord(1), assistantRecord(2)].join(''));
    const source = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const whole = await wholeConversation(source, file);
    const size = Buffer.byteLength([userRecord(0), assistantRecord(1), assistantRecord(2)].join(''));

    const { events } = await scrollToTheTop(source, file, size, 2);

    should(events.map(coordinate)).eql(whole.map(coordinate));
  });

  it('answers an empty page at the start of the file', async () => {
    const file = await transcriptFile();
    await writeFile(file, userRecord(0));
    const source = new NodeTranscriptSource(new ClaudeTranscriptParser());

    should(await readTranscriptPage(source, file, SESSION, { from: 0, before: 0, limit: 10 })).eql({
      events: [],
      start: 0,
    });
  });
});

describe('a window that starts at an offset and stops at an end', () => {
  const drain = async (source: TranscriptSource, file: string, byteOffset: number, end?: number) => {
    const window = source.window(file, {
      sessionId: SESSION,
      start: { at: 'offset', byteOffset },
      ...(end === undefined ? {} : { end }),
    });
    const events: TranscriptEvent[] = [];
    for (let step = 0; step < 16; step += 1) {
      const { batch, more } = await window.next();
      if (batch !== undefined) events.push(...batch.events);
      if (!more) return events;
    }
    throw new Error('the window never stopped');
  };

  it('keeps the record a start lands exactly on, and leaves out the one an end cuts', async () => {
    const file = await transcriptFile();
    const records = [userRecord(0), userRecord(1), userRecord(2), userRecord(3)];
    await writeFile(file, records.join(''));
    const source = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const second = Buffer.byteLength(records[0] ?? '');
    const fourth = Buffer.byteLength(records.slice(0, 3).join(''));

    const events = await drain(source, file, second, fourth + 5);

    should(events.map(item => item.byteOffset)).eql([second, second + Buffer.byteLength(records[1] ?? '')]);
  });

  it('reads nothing when it ends where it starts, or starts past the end of the file', async () => {
    const file = await transcriptFile();
    const records = [userRecord(0), userRecord(1)];
    await writeFile(file, records.join(''));
    const source = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const second = Buffer.byteLength(records[0] ?? '');

    should(await drain(source, file, second, second)).eql([]);
    should(await drain(source, file, 10 * MiB)).eql([]);
  });
});
