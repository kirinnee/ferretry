import { describe, it } from 'bun:test';
import should from 'should';
import { newestWholeRecords, readTranscriptPage, tailPage } from '../../../../src/lib/session/transcript/log-page.ts';
import type {
  TranscriptBatch,
  TranscriptEvent,
  TranscriptSource,
  TranscriptWindow,
  TranscriptWindowOptions,
} from '../../../../src/lib/transcript/types.ts';

/**
 * Where a page of a chat begins. A page never begins inside a record, so the events of one record — a
 * reply with its thinking and tool call — are shown together or left whole for the page before.
 */

const event = (byteOffset: number, blockIndex = 0): TranscriptEvent => ({
  kind: 'message',
  harness: 'claude',
  role: 'assistant',
  text: `at ${String(byteOffset)}/${String(blockIndex)}`,
  byteOffset,
  blockIndex,
});

const places = (events: readonly TranscriptEvent[]): readonly string[] =>
  events.map(item => `${String(item.byteOffset)}/${String(item.blockIndex)}`);

describe('newestWholeRecords', () => {
  it('keeps everything that fits', () => {
    const events = [event(0), event(10)];
    should(newestWholeRecords(events, 5)).eql({ events, trimmed: false });
  });

  it('moves a cut back to the start of the record it fell in', () => {
    const events = [event(0), event(10, 0), event(10, 1), event(10, 2), event(20)];

    const kept = newestWholeRecords(events, 2);

    should(places(kept.events)).eql(['10/0', '10/1', '10/2', '20/0']);
    should(kept.trimmed).be.true();
  });

  it('keeps one record larger than the page whole rather than splitting it', () => {
    const events = [event(10, 0), event(10, 1), event(10, 2)];
    should(newestWholeRecords(events, 2)).eql({ events, trimmed: false });
  });
});

describe('tailPage', () => {
  it('begins an empty tail at the end of the file, so the page before it is everything', () => {
    should(tailPage([], 200, 4096)).eql({ events: [], start: 4096 });
  });

  it('begins a short tail at its first record', () => {
    should(tailPage([event(30), event(40)], 200, 4096)).eql({ events: [event(30), event(40)], start: 30 });
  });

  it('leaves a full tail’s first record, which may be cut, to the page before', () => {
    const page = tailPage([event(10, 1), event(10, 2), event(20), event(30)], 4, 4096);
    should(page).eql({ events: [event(20), event(30)], start: 20 });
  });

  it('declines a full tail that is all one record, since there is no boundary inside it to begin at', () => {
    should(tailPage([event(10, 1), event(10, 2)], 2, 4096)).be.undefined();
  });
});

/**
 * A source over records at known offsets, honouring a window's `offset` start and `end` the way the
 * file source does: placed on the first record at or after the offset, nothing read at or past the end.
 * `step` records per `next()`, so a page is read across several steps.
 */
interface FakeRecord {
  readonly offset: number;
  readonly events: number;
}

const fakeSource = (
  records: readonly FakeRecord[],
  options: { readonly step?: number; readonly raw?: boolean; readonly reset?: boolean } = {},
): TranscriptSource & { readonly windows: number[] } => {
  const windows: number[] = [];
  return {
    harness: 'claude',
    windows,
    read: async () => {
      throw new Error('not read whole');
    },
    follow: () => {
      throw new Error('not followed');
    },
    window: (file: string, windowOptions: TranscriptWindowOptions): TranscriptWindow => {
      const start = windowOptions.start.at === 'offset' ? windowOptions.start.byteOffset : 0;
      const end = windowOptions.end ?? Number.POSITIVE_INFINITY;
      windows.push(start);
      const inside = records.filter(record => record.offset >= start && record.offset < end);
      let at = 0;
      let first = true;
      return {
        file,
        next: async () => {
          if (first && inside.length === 0) {
            first = false;
            return { more: false };
          }
          first = false;
          const step = inside.slice(at, at + (options.step ?? inside.length));
          at += step.length;
          const batch: TranscriptBatch = {
            harness: 'claude',
            file,
            reset: options.reset === true,
            cursor: { byteOffset: 0, pendingBytes: 0 } as TranscriptBatch['cursor'],
            events: step.flatMap(record =>
              Array.from({ length: record.events }, (_, block) => event(record.offset, block)),
            ),
            observedInputs: [],
            issues: [],
            ...(options.raw === false
              ? {}
              : { rawRecords: step.map(record => ({ byteOffset: record.offset, bytes: new Uint8Array() })) }),
          };
          return { batch, more: at < inside.length };
        },
      };
    },
  };
};

/** `count` one-event records, `size` bytes apart. */
const evenly = (count: number, size = 100): FakeRecord[] =>
  Array.from({ length: count }, (_, index) => ({ offset: index * size, events: 1 }));

describe('readTranscriptPage', () => {
  it('answers an empty page when the range is empty', async () => {
    const source = fakeSource(evenly(5));
    should(await readTranscriptPage(source, 'f', 's', { from: 300, before: 300, limit: 10 })).eql({
      events: [],
      start: 300,
    });
    should(source.windows).eql([]);
  });

  it('stops at the first window that holds a full page, beginning at its first kept record', async () => {
    const source = fakeSource(evenly(100), { step: 7 });

    const page = await readTranscriptPage(source, 'f', 's', { from: 0, before: 9_000, limit: 5 }, [1_000], 4_000);

    should(places(page.events)).eql(['8500/0', '8600/0', '8700/0', '8800/0', '8900/0']);
    should(page.start).equal(8_500);
    should(source.windows).eql([8_000]);
  });

  it('widens until it reaches the floor, and then begins at the floor', async () => {
    const source = fakeSource(evenly(10));

    const page = await readTranscriptPage(source, 'f', 's', { from: 250, before: 900, limit: 50 }, [100, 300], 4_000);

    should(places(page.events)).eql(['300/0', '400/0', '500/0', '600/0', '700/0', '800/0']);
    should(page.start).equal(250);
    should(source.windows).eql([800, 600, 250]);
  });

  it('begins a page that found too little at its scan bound on the first record it read', async () => {
    const source = fakeSource([
      { offset: 0, events: 1 },
      { offset: 5_000, events: 0 },
      { offset: 9_000, events: 1 },
    ]);

    const page = await readTranscriptPage(source, 'f', 's', { from: 0, before: 9_500, limit: 5 }, [100], 6_000);

    should(places(page.events)).eql(['9000/0']);
    should(page.start).equal(5_000);
  });

  it('falls back to the first event, then to where the window began, when no raw record is reported', async () => {
    const withEvent = fakeSource([{ offset: 9_000, events: 1 }], { raw: false });
    const empty = fakeSource([], { raw: false });

    should(
      (await readTranscriptPage(withEvent, 'f', 's', { from: 0, before: 9_500, limit: 5 }, [100], 2_000)).start,
    ).equal(9_000);
    should((await readTranscriptPage(empty, 'f', 's', { from: 0, before: 9_500, limit: 5 }, [100], 2_000)).start).equal(
      7_500,
    );
  });

  it('refuses a file replaced while the page was read', async () => {
    const source = fakeSource(evenly(3), { reset: true });
    await should(readTranscriptPage(source, 'f', 's', { from: 0, before: 300, limit: 5 })).be.rejectedWith(
      /replaced while a page of it was read/,
    );
  });

  it('leaves out an event at or past the end, and counts one with no offset as the file’s start', async () => {
    const source: TranscriptSource = {
      ...fakeSource([]),
      window: (file: string) => ({
        file,
        next: async () => ({
          batch: {
            harness: 'claude',
            file,
            reset: false,
            cursor: { byteOffset: 0, pendingBytes: 0 } as TranscriptBatch['cursor'],
            events: [{ ...event(0), byteOffset: undefined }, event(50), event(500)],
            observedInputs: [],
            issues: [],
          },
          more: false,
        }),
      }),
    };

    const page = await readTranscriptPage(source, 'f', 's', { from: 0, before: 100, limit: 5 });

    should(page.events.map(item => item.byteOffset)).eql([undefined, 50]);
  });
});
