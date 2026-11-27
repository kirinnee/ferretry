import { createHmac } from 'node:crypto';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type MessageRowReadResult,
  TranscriptReadError,
  TranscriptReadService,
} from '../../../daemon/reader/lib/reads.ts';
import type { PortableConversationRow } from '../../../daemon/reader/lib/session/digest.ts';
import type {
  SessionTranscriptMessageTokenCodec,
  SessionTranscriptMessageTokenContext,
} from '../../../daemon/reader/lib/session/message-token.ts';

const INSTANT = '2026-02-01T09:08:07.000Z';
const codec = (key: string): SessionTranscriptMessageTokenCodec => ({
  tag: async input => new Uint8Array(createHmac('sha256', key).update(input).digest()),
  matches: async (input, tag) => Buffer.from(createHmac('sha256', key).update(input).digest()).equals(Buffer.from(tag)),
});
const CONTEXT: SessionTranscriptMessageTokenContext = {
  sessionId: 's1',
  incarnation: 'inc-one',
  provenance: {
    v: 1,
    home: '/harness/home',
    identity: 'minted',
    harnessSessionId: 'harness-one',
    file: '/harness/home/one.jsonl',
    resolvedAt: INSTANT,
  },
};
const row = (
  byteOffset: number,
  role: 'user' | 'assistant',
  extra: Partial<PortableConversationRow> = {},
): PortableConversationRow => ({
  point: { v: 1, byteOffset, blockIndex: 0 },
  role,
  text: `${role} at ${byteOffset}`,
  timestamp: INSTANT,
  rawPrefix: new Uint8Array(32).fill(byteOffset),
  ...extra,
});

/** A conversation: the harness's own note first, then two turns the owner typed (one of them queued natively). */
const ROWS = [
  row(10, 'user', { inputSource: 'harness' }),
  row(20, 'assistant'),
  row(30, 'user'),
  row(40, 'assistant'),
  row(50, 'user', { inputSource: 'native-queue' }),
  row(60, 'assistant'),
];

const service = (read: () => MessageRowReadResult, key = 'k'): TranscriptReadService =>
  new TranscriptReadService(
    { tail: async () => ({ kind: 'read', events: [] }) },
    { read: async () => read() },
    codec(key),
  );

const served = () => service(() => ({ kind: 'read', context: CONTEXT, rows: ROWS }));
const refusal = async (promise: Promise<unknown>): Promise<TranscriptReadError> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof TranscriptReadError)) throw new Error('expected a transcript read refusal');
  return error;
};
/** The point and the binding a person was shown for the row at `offset`. */
const shown = async (reads: TranscriptReadService, offset: number) => {
  const page = await reads.messages('s1', undefined, undefined);
  const message = page.messages.find(each => each.point.startsWith(`${offset}.`));
  if (message === undefined) throw new Error(`no row at ${offset}`);
  return message;
};

describe('TranscriptReadService.forkTurn', () => {
  it('counts only what the owner said, up to and including the chosen row', async () => {
    const reads = served();

    should(await reads.forkTurn('s1', (await shown(reads, 30)).point, (await shown(reads, 30)).selectionBinding)).equal(
      1,
    );
    should(await reads.forkTurn('s1', (await shown(reads, 40)).point, (await shown(reads, 40)).selectionBinding)).equal(
      1,
    );
    should(await reads.forkTurn('s1', (await shown(reads, 60)).point, (await shown(reads, 60)).selectionBinding)).equal(
      2,
    );
  });

  it('refuses a message before anything the owner said as not a turn', async () => {
    const reads = served();
    const first = await shown(reads, 10);

    should(await refusal(reads.forkTurn('s1', first.point, first.selectionBinding))).have.property(
      'failure',
      'not_a_turn',
    );
  });

  it('refuses a point that is not a point, with no read made', async () => {
    const reads = service(() => {
      throw new Error('must not read');
    });

    should(await refusal(reads.forkTurn('s1', 'nope', 's2.x'))).have.property('failure', 'invalid_query');
  });

  it('says plainly when the conversation cannot be proved, or cannot be read', async () => {
    const unresolved = service(() => ({ kind: 'unresolved' }));
    const unreadable = service(() => ({ kind: 'unreadable', reason: 'a torn record' }));
    const unexplained = service(() => ({ kind: 'unreadable' }));

    should(await refusal(unresolved.forkTurn('s1', '10.0', 's2.x'))).have.property('failure', 'no_transcript');
    const torn = await refusal(unreadable.forkTurn('s1', '10.0', 's2.x'));
    should(torn).have.property('failure', 'transcript_unreadable');
    should(torn.message).containEql(': a torn record');
    should((await refusal(unexplained.forkTurn('s1', '10.0', 's2.x'))).message).not.containEql(': ');
  });

  it('reads every kind of mismatch as one answer, selection_stale', async () => {
    const reads = served();
    const chosen = await shown(reads, 30);
    const undiscovered = service(() => ({
      kind: 'read',
      context: { ...CONTEXT, provenance: { v: 1, identity: 'undiscovered' } } as never,
      rows: ROWS,
    }));
    const rewritten = service(() => ({
      kind: 'read',
      context: CONTEXT,
      rows: ROWS.map(each =>
        each.point.byteOffset === 30 ? { ...each, rawPrefix: new Uint8Array(32).fill(99) } : each,
      ),
    }));
    const otherKey = service(() => ({ kind: 'read', context: CONTEXT, rows: ROWS }), 'another key');

    for (const [name, attempt] of [
      ['a point no longer there', reads.forkTurn('s1', '999.0', chosen.selectionBinding)],
      ['a binding that was never issued', reads.forkTurn('s1', chosen.point, `s2.${'A'.repeat(43)}`)],
      ['a rewritten prefix', rewritten.forkTurn('s1', chosen.point, chosen.selectionBinding)],
      ['another daemon key', otherKey.forkTurn('s1', chosen.point, chosen.selectionBinding)],
      ['an identity not yet discovered', undiscovered.forkTurn('s1', chosen.point, chosen.selectionBinding)],
    ] as const) {
      const refused = await refusal(attempt);
      should([name, refused.failure]).eql([name, 'selection_stale']);
      should(refused.message).startWith('That message no longer reads as it did');
    }
  });
});
