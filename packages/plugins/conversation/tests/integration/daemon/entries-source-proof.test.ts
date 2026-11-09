import { describe, expect, test } from 'bun:test';
import type { TranscriptEntry, TranscriptReader } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import { EntriesTranscriptSource } from '../../../daemon/reader/adapters/entries-source.ts';

const at = (value: string): Instant => value as Instant;

/** A conversation that holds the harness's own queue records between two real messages. */
const entries: readonly TranscriptEntry[] = [
  { id: 'u1', role: 'user', text: 'FIXTURE hello', at: at('2026-11-09T10:00:00.000Z') },
  {
    id: 'queue-operation:1',
    role: 'system',
    text: 'FIXTURE typed mid-turn',
    at: at('2026-11-09T10:00:01.000Z'),
    data: { proof: 'queue-operation', operation: 'enqueue' },
  },
  {
    id: 'att-1',
    role: 'system',
    text: 'FIXTURE typed mid-turn',
    at: at('2026-11-09T10:00:02.000Z'),
    data: { proof: 'queued-prompt' },
  },
  { id: 'a1', role: 'assistant', text: 'FIXTURE reply', at: at('2026-11-09T10:00:03.000Z') },
];

describe('#45 BG-052 the harness’s queue records are evidence for the send tracker, not messages of the conversation', () => {
  const reader: TranscriptReader = {
    read: async (_ferret, after, limit) =>
      entries.slice(after === undefined ? 0 : 1 + entries.findIndex(e => e.id === after), limit),
    follow: async function* () {},
    find: async (_ferret, id) => entries.find(each => each.id === id),
  };
  const source = new EntriesTranscriptSource(async () => ({ harness: 'claude', reader }));

  test('the tail of the conversation holds the messages and none of the queue records', async () => {
    const tail = await source.tail('f1', 10);

    expect(tail.kind).toBe('read');
    if (tail.kind !== 'read') return;
    expect(tail.events.map(event => event.recordId)).toEqual(['u1', 'a1']);
    expect(JSON.stringify(tail)).not.toContain('typed mid-turn');
  });

  test('a search finds no queue record, and the rows of the conversation carry none', async () => {
    const found = await source.search('f1', { needle: 'mid-turn', accept: () => true, limit: 5 });
    expect(found.kind === 'read' ? found.events : 'unread').toEqual([]);

    const read = await source.read('f1');
    expect(read.kind).toBe('read');
    expect(JSON.stringify(read)).not.toContain('typed mid-turn');
  });
});
