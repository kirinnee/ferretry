import { describe, it } from 'bun:test';
import should from 'should';
import { TranscriptReadError, TranscriptReadService } from '../../../daemon/reader/lib/reads.ts';
import type { TranscriptEvent } from '../../../daemon/reader/lib/transcript/types.ts';

const INSTANT = '2026-02-01T09:08:07.000Z';

const READY: TranscriptEvent = {
  kind: 'message',
  harness: 'claude',
  role: 'assistant',
  text: 'ready',
  timestamp: INSTANT,
} as TranscriptEvent;

const service = (): TranscriptReadService =>
  new TranscriptReadService(
    { tail: async () => ({ kind: 'read', events: [READY] }) },
    { read: async () => ({ kind: 'unreadable' }) },
    {
      tag: async () => new Uint8Array(32),
      matches: async () => false,
    },
  );

describe('TranscriptReadService.logs turn validation', () => {
  it('should refuse a turn that is not a non-negative integer', async () => {
    // Arrange
    const reads = service();

    // Act
    const refusals = await Promise.all(
      [-1, 1.5, Number.NaN].map(async turn => await reads.logs('s1', undefined, turn).catch((error: unknown) => error)),
    );

    // Assert
    for (const refusal of refusals)
      should(refusal)
        .be.instanceof(TranscriptReadError)
        .and.have.properties({ failure: 'invalid_query', message: 'turn must be a non-negative integer' });
  });
});

const CODEC = { tag: async () => new Uint8Array(32), matches: async () => false };
const NEVER = { read: async () => ({ kind: 'unreadable' as const }) };
const event = (partial: Record<string, unknown>): TranscriptEvent =>
  ({
    kind: 'message',
    harness: 'claude',
    role: 'assistant',
    timestamp: INSTANT,
    text: 'hello world',
    ...partial,
  }) as TranscriptEvent;

const withPages = (page: () => Promise<unknown>): TranscriptReadService =>
  new TranscriptReadService({ tail: async () => ({ kind: 'read', events: [] }) }, NEVER, CODEC, undefined, {
    page,
  } as never);

const withSearch = (search: (query: { accept: (event: TranscriptEvent) => boolean }) => Promise<unknown>) =>
  new TranscriptReadService({ tail: async () => ({ kind: 'read', events: [] }) }, NEVER, CODEC, undefined, undefined, {
    search: async (_session: string, query: { accept: (event: TranscriptEvent) => boolean }) => await search(query),
  } as never);

const failureOf = async (promise: Promise<unknown>) =>
  await promise.then(
    () => undefined,
    (error: unknown) => (error as TranscriptReadError).failure,
  );

describe('TranscriptReadService.logPage refusals', () => {
  it('should refuse a page of a transcript it cannot prove or read, and one of another file', async () => {
    should(await failureOf(withPages(async () => ({ kind: 'unresolved' })).logPage('s1', {}))).equal('no_transcript');
    should(await failureOf(withPages(async () => ({ kind: 'unreadable' })).logPage('s1', {}))).equal(
      'transcript_unreadable',
    );
    const other = withPages(async () => ({ kind: 'read', events: [], start: 0, file: 'file-b' }));
    should(await failureOf(other.logPage('s1', { file: 'file-a' }))).equal('log_cursor_stale');
  });
});

describe('TranscriptReadService.logSearch', () => {
  const found = (events: TranscriptEvent[]) => async () => ({ kind: 'read', events, truncated: false, file: 'f' });

  it('should refuse a transcript it cannot prove or read', async () => {
    should(await failureOf(withSearch(async () => ({ kind: 'unresolved' })).logSearch('s1', { q: 'x' }))).equal(
      'no_transcript',
    );
    should(await failureOf(withSearch(async () => ({ kind: 'unreadable' })).logSearch('s1', { q: 'x' }))).equal(
      'transcript_unreadable',
    );
  });

  it('should refuse an empty or over-long query, and a who it does not know', async () => {
    const reads = withSearch(found([]));
    should(await failureOf(reads.logSearch('s1', { q: '   ' }))).equal('invalid_query');
    should(await failureOf(reads.logSearch('s1', { q: 'x'.repeat(201) }))).equal('invalid_query');
    should(await failureOf(reads.logSearch('s1', { q: 'x', who: 'nobody' }))).equal('invalid_query');
  });

  it('should accept what each who and tools setting shows, and only that', async () => {
    const accepted: Record<string, boolean[]> = {};
    const probe = async (label: string, query: { who?: string; tools?: boolean }) => {
      await withSearch(async search => {
        accepted[label] = [
          event({ role: 'assistant' }),
          event({ role: 'user' }),
          event({ role: 'tool', kind: 'tool-result', result: { text: 'hello world', content: [] } }),
          event({ role: 'assistant', kind: 'reasoning' }),
        ].map(each => search.accept(each));
        return { kind: 'read', events: [], truncated: false, file: 'f' };
      }).logSearch('s1', { q: 'hello', ...query });
    };
    await probe('all', {});
    await probe('allTools', { tools: true });
    await probe('agent', { who: 'agent' });
    await probe('me', { who: 'me' });
    should(accepted.all).deepEqual([false, false, false, false].map((_, index) => index < 2));
    should(accepted.allTools).deepEqual([true, true, true, true]);
    should(accepted.agent?.[0]).be.true();
    should(accepted.agent?.[1]).be.false();
    should(accepted.me?.[0]).be.false();
  });

  it('should answer where the query is in each event, and drop an event whose scrubbed text no longer holds it', async () => {
    const reads = withSearch(
      found([event({ text: 'say Hello there', byteOffset: 7 }), event({ text: 'no match here', byteOffset: 9 })]),
    );
    const answer = await reads.logSearch('s1', { q: 'hello' });
    should(answer.matches).have.length(1);
    should(answer.matches[0]).containEql({ offset: 7, role: 'assistant', kind: 'message' });
    should(answer).containEql({ query: 'hello', truncated: false, file: 'f' });
  });
});
