import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { NodeTranscriptFileRuntime, NodeTranscriptSource } from '../../../../src/adapters/transcript/file-source.ts';
import { NodeTranscriptRecordScanner } from '../../../../src/adapters/transcript/record-scan.ts';
import {
  prefilterNeedle,
  searchTranscriptRecords,
  type TranscriptRecordRange,
} from '../../../../src/lib/session/transcript/log-search.ts';
import { ClaudeTranscriptParser } from '../../../../src/lib/transcript/claude.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

/**
 * Searching a real transcript file: the raw scan reads it backwards a chunk at a time and offers only
 * the records whose bytes hold the needle, newest first, with every record whole — across chunk
 * boundaries and past a record longer than a chunk — and the search then parses exactly those.
 */

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const file = async (lines: readonly string[]): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-log-search-'));
  directories.push(directory);
  const path = join(directory, 'transcript.jsonl');
  await writeFile(path, lines.join(''));
  return path;
};

const user = (text: string): string =>
  `${JSON.stringify({ type: 'user', uuid: `u-${text.slice(0, 12)}`, message: { role: 'user', content: text } })}\n`;

const collect = async (records: AsyncIterable<TranscriptRecordRange>): Promise<TranscriptRecordRange[]> => {
  const found: TranscriptRecordRange[] = [];
  for await (const record of records) found.push(record);
  return found;
};

/** Where each line of `lines` begins and ends. */
const ranges = (lines: readonly string[]): TranscriptRecordRange[] => {
  let at = 0;
  return lines.map(line => {
    const range = { start: at, end: at + Buffer.byteLength(line) };
    at = range.end;
    return range;
  });
};

describe('the raw record scan', () => {
  it('offers the records holding the needle in any case, newest first, across chunk boundaries', async () => {
    const lines = Array.from({ length: 40 }, (_, index) =>
      user(index % 7 === 0 ? `Line ${String(index)} mentions the PARSER` : `line ${String(index)} says nothing`),
    );
    const path = await file(lines);
    const scanner = new NodeTranscriptRecordScanner(new NodeTranscriptFileRuntime(), 300);

    const found = await collect(scanner.records(path, 'parser'));

    const expected = ranges(lines)
      .filter((_, index) => index % 7 === 0)
      .reverse();
    should(found).eql(expected);
  });

  it('offers every record, newest first, with no needle', async () => {
    const lines = [user('one'), user('two'), user('three')];
    const path = await file(lines);

    should(await collect(new NodeTranscriptRecordScanner(undefined, 64).records(path, undefined))).eql(
      ranges(lines).reverse(),
    );
  });

  it('widens past a record longer than a chunk, and keeps it whole', async () => {
    const lines = [user('before'), user(`long ${'x'.repeat(5_000)} needle`), user('after')];
    const path = await file(lines);

    const found = await collect(new NodeTranscriptRecordScanner(undefined, 256).records(path, 'needle'));

    should(found).eql([ranges(lines)[1]]);
  });

  it('steps over a record past the per-record bound, as the source drops it, and goes on', async () => {
    const lines = [user('first needle'), user(`huge ${'x'.repeat(2_000)} needle`), user('last needle')];
    const path = await file(lines);

    const found = await collect(new NodeTranscriptRecordScanner(undefined, 64, 256).records(path, 'needle'));

    should(found.map(record => record.start)).not.containEql(ranges(lines)[1]?.start);
    should(found[0]).eql(ranges(lines)[2]);
    should(found.at(-1)).eql(ranges(lines)[0]);
  });

  it('offers nothing for a file that is not there', async () => {
    should(await collect(new NodeTranscriptRecordScanner().records('/nonexistent/transcript.jsonl', 'x'))).eql([]);
  });
});

describe('searching a real transcript', () => {
  it('finds a quoted, mixed-case phrase through the prefilter and parses only what holds it', async () => {
    const lines = [
      user('He said "Hello World" twice'),
      user('hello there'),
      user('nothing'),
      user('HELLO WORLD again'),
    ];
    const path = await file(lines);
    const query = '"hello world"';
    const accept = (event: TranscriptEvent): boolean =>
      event.kind === 'message' && event.text.toLowerCase().includes(query);

    const loose = await searchTranscriptRecords(
      new NodeTranscriptSource(new ClaudeTranscriptParser()),
      new NodeTranscriptRecordScanner(),
      path,
      's',
      { needle: prefilterNeedle(query), accept },
      10,
    );
    const phrase = await searchTranscriptRecords(
      new NodeTranscriptSource(new ClaudeTranscriptParser()),
      new NodeTranscriptRecordScanner(),
      path,
      's',
      {
        needle: prefilterNeedle('hello world'),
        accept: event => event.kind === 'message' && event.text.toLowerCase().includes('hello world'),
      },
      10,
    );

    should(loose.events.map(event => event.byteOffset)).eql([0]);
    should(phrase.events.map(event => event.byteOffset)).eql([ranges(lines)[0]?.start, ranges(lines)[3]?.start]);
  });
});
