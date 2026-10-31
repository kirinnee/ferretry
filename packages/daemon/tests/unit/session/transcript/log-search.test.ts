import { describe, it } from 'bun:test';
import should from 'should';
import {
  prefilterNeedle,
  searchTranscriptRecords,
  type TranscriptRecordRange,
  type TranscriptRecordScanner,
} from '../../../../src/lib/session/transcript/log-search.ts';
import type {
  TranscriptBatch,
  TranscriptEvent,
  TranscriptSource,
  TranscriptWindowOptions,
} from '../../../../src/lib/transcript/types.ts';

/**
 * Search within a conversation: records newest first, parsed one at a time, kept when `accept` takes
 * them, until enough are found — and a raw prefilter that can only ever skip a record that cannot match.
 */

const message = (byteOffset: number, text: string, blockIndex = 0): TranscriptEvent => ({
  kind: 'message',
  harness: 'claude',
  role: 'assistant',
  text,
  byteOffset,
  blockIndex,
});

/** A transcript of records `[offset, events]`, each `size` bytes; the scanner walks them newest first. */
const transcript = (
  records: readonly (readonly TranscriptEvent[])[],
  options: { readonly reset?: boolean } = {},
): { readonly source: TranscriptSource; readonly scanner: TranscriptRecordScanner; readonly needles: unknown[] } => {
  const ranges: TranscriptRecordRange[] = records.map((_, index) => ({ start: index * 100, end: index * 100 + 100 }));
  const needles: unknown[] = [];
  return {
    needles,
    scanner: {
      records: async function* (_file, needle) {
        needles.push(needle);
        for (const range of [...ranges].reverse()) yield range;
      },
    },
    source: {
      harness: 'claude',
      read: async () => {
        throw new Error('not read whole');
      },
      follow: () => {
        throw new Error('not followed');
      },
      window: (file: string, windowOptions: TranscriptWindowOptions) => {
        const start = windowOptions.start.at === 'offset' ? windowOptions.start.byteOffset : 0;
        let done = false;
        return {
          file,
          next: async () => {
            if (done) return { more: false };
            done = true;
            const batch: TranscriptBatch = {
              harness: 'claude',
              file,
              reset: options.reset === true,
              cursor: { byteOffset: 0, pendingBytes: 0 } as TranscriptBatch['cursor'],
              events: records[start / 100] ?? [],
              observedInputs: [],
              issues: [],
            };
            return { batch, more: start === 100 };
          },
        };
      },
    },
  };
};

const says = (word: string) => (event: TranscriptEvent) => event.kind === 'message' && event.text.includes(word);

describe('prefilterNeedle', () => {
  it('keeps the whole query when JSON writes it as it is, lower-cased', () => {
    should(prefilterNeedle('Scroll Up')).equal('scroll up');
  });

  it('takes the longest run a JSON writer cannot spell differently', () => {
    should(prefilterNeedle('say "hello world" please')).equal('hello world');
    should(prefilterNeedle('a\\bcd')).equal('bcd');
    should(prefilterNeedle('café au lait')).equal(' au lait');
  });

  it('has nothing safe to look for in a query of quotes and non-ASCII letters', () => {
    should(prefilterNeedle('"é"')).be.undefined();
  });
});

describe('searchTranscriptRecords', () => {
  it('answers every accepted event in file order, and passes the needle to the scanner', async () => {
    const { source, scanner, needles } = transcript([
      [message(0, 'apple pie')],
      [message(100, 'pear'), message(100, 'apple crumble', 1)],
      [message(200, 'apple tart')],
    ]);

    const result = await searchTranscriptRecords(
      source,
      scanner,
      'f',
      's',
      { needle: 'apple', accept: says('apple') },
      10,
    );

    should(result.events.map(event => (event as { text: string }).text)).eql([
      'apple pie',
      'apple crumble',
      'apple tart',
    ]);
    should(result.truncated).be.false();
    should(needles).eql(['apple']);
  });

  it('stops at its limit, newest first, and says older records went unread', async () => {
    const { source, scanner } = transcript([[message(0, 'a1')], [message(100, 'a2')], [message(200, 'a3')]]);

    const result = await searchTranscriptRecords(source, scanner, 'f', 's', { needle: 'a', accept: says('a') }, 2);

    should(result.events.map(event => event.byteOffset)).eql([100, 200]);
    should(result.truncated).be.true();
  });

  it('stops after parsing its most records, whatever they held', async () => {
    const { source, scanner } = transcript([[message(0, 'x')], [message(100, 'y')], [message(200, 'z')]]);

    const result = await searchTranscriptRecords(
      source,
      scanner,
      'f',
      's',
      { needle: undefined, accept: says('q') },
      10,
      2,
    );

    should(result).eql({ events: [], truncated: true });
  });

  it('refuses a transcript replaced while it was searched', async () => {
    const { source, scanner } = transcript([[message(0, 'x')]], { reset: true });
    await should(
      searchTranscriptRecords(source, scanner, 'f', 's', { needle: 'x', accept: says('x') }, 10),
    ).be.rejectedWith(/replaced while it was searched/);
  });
});
