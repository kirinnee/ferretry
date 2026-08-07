import { createHmac } from 'node:crypto';
import { describe, it } from 'bun:test';
import { SessionTranscriptPageSchema } from '@ferretry/protocol';
import should from 'should';
import {
  DEFAULT_LOG_TAIL,
  DEFAULT_MESSAGE_PAGE,
  JOURNAL_EVENT_SOURCE,
  MAX_EVENT_PAGE,
  MAX_LOG_TAIL,
  MAX_MESSAGE_PAGE,
  type OperatorMessageReadResult,
  OperatorReadError,
  OperatorReadService,
  type PaneCapture,
  renderTranscript,
  type StoredSessionEvent,
  type TranscriptTailResult,
} from '../../../../src/lib/session/reads/index.ts';
import type { PortableConversationRow } from '../../../../src/lib/session/transcript/digest.ts';
import {
  issueSessionTranscriptMessageToken,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
  type SessionTranscriptMessageTokenCodec,
  type SessionTranscriptMessageTokenContext,
  verifySessionTranscriptMessageToken,
} from '../../../../src/lib/session/transcript/message-token.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

/**
 * Every way an operator read can be WRONG rather than merely empty.
 *
 * The four reads share one rule and these cases are its proof: a blank answer is served only when
 * blankness is a fact the daemon can stand behind. A dead pane, an unprovable transcript and an
 * out-of-range query are all refusals, because each of them renders as "nothing is happening" to the
 * human reading the output and each of them is actually "I could not tell".
 */

const INSTANT = '2026-02-01T09:08:07.000Z';

const stored = (sequence: number, type = 'session.created'): StoredSessionEvent => ({
  sequence,
  sessionId: 's1',
  time: INSTANT,
  type,
  data: { note: sequence },
});

interface JournalCall {
  readonly sessionId: string;
  readonly afterSequence: number;
  readonly limit: number;
}

/** The private key a production codec would hold in its adapter and nothing else would ever see. */
const KEY = Buffer.from('the daemon-private session message token key', 'utf8');

/**
 * A stand-in for that adapter: HMAC-SHA-256 with full 32-byte tags, exactly as the pinned framing
 * says, so the tokens these cases page over are real tokens rather than strings this file invented.
 *
 * `matches` compares with `equals` rather than in constant time. That difference is the whole reason
 * this is a fake — the timing property belongs to the one adapter that holds the key, and its own
 * tests own it.
 */
const messageCodec = (key: Buffer = KEY): SessionTranscriptMessageTokenCodec => ({
  tag: async input => new Uint8Array(createHmac('sha256', key).update(input).digest()),
  matches: async (input, tag) => Buffer.from(createHmac('sha256', key).update(input).digest()).equals(Buffer.from(tag)),
});

/** A COMPLETED context: a resolved identity, so every optional the refinements tie to it is present. */
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

/**
 * One portable row — the DIGEST OWNER'S type, not a local restatement — and the 32-byte value standing
 * in for the raw-prefix commitment ending at it.
 *
 * The commitment is DISTINCT PER ROW and derived from the row's own offset rather than its text, which
 * is what lets these cases hold text constant and change the raw prefix underneath it — the exact
 * substitution a durable coordinate alone cannot refuse. Blocks of ONE physical record share a value;
 * the same-offset case below is the one that fixes that.
 */
const row = (byteOffset: number, overrides: Partial<PortableConversationRow> = {}): PortableConversationRow => ({
  point: { v: 1, byteOffset, blockIndex: 0 },
  role: 'assistant',
  text: `said at ${byteOffset}`,
  timestamp: INSTANT,
  rawPrefix: new Uint8Array(32).fill(byteOffset),
  ...overrides,
});

const service = (options: {
  readonly events?: readonly StoredSessionEvent[];
  readonly calls?: JournalCall[];
  readonly capture?: PaneCapture | undefined;
  readonly tail?: TranscriptTailResult;
  readonly tailLimits?: number[];
  readonly storedSnapshot?:
    | { readonly kind: 'absent' | 'unreadable' }
    | { readonly kind: 'read'; readonly text: string };
  readonly rows?: readonly PortableConversationRow[];
  readonly read?: OperatorMessageReadResult;
  readonly context?: SessionTranscriptMessageTokenContext;
  readonly reads?: string[];
  readonly codec?: SessionTranscriptMessageTokenCodec;
}): OperatorReadService =>
  new OperatorReadService(
    {
      replay: async (sessionId, afterSequence, limit) => {
        options.calls?.push({ sessionId, afterSequence, limit });
        return options.events ?? [];
      },
    },
    { capture: async () => options.capture },
    {
      tail: async (_sessionId, limit) => {
        options.tailLimits?.push(limit);
        return options.tail ?? { kind: 'read', events: [] };
      },
    },
    {
      read: async sessionId => {
        options.reads?.push(sessionId);
        return options.read ?? { kind: 'read', context: options.context ?? CONTEXT, rows: options.rows ?? [] };
      },
    },
    options.codec ?? messageCodec(),
    { read: async () => options.storedSnapshot ?? { kind: 'absent' } },
  );

const message = (text: string, overrides: Partial<TranscriptEvent> = {}): TranscriptEvent =>
  ({
    kind: 'message',
    harness: 'claude',
    role: 'assistant',
    text,
    timestamp: INSTANT,
    ...overrides,
  }) as TranscriptEvent;

describe('OperatorReadService.events', () => {
  it('should project the journal into the protocol envelope without inventing a turn', async () => {
    // Arrange
    const reads = service({ events: [stored(4), stored(5, 'session.stopped')] });

    // Act
    const page = await reads.events('s1', 3, undefined);

    // Assert
    should(page).eql([
      { sequence: 4, time: INSTANT, sessionId: 's1', type: 'session.created', source: 'daemon', data: { note: 4 } },
      { sequence: 5, time: INSTANT, sessionId: 's1', type: 'session.stopped', source: 'daemon', data: { note: 5 } },
    ]);
    // The turn is ABSENT rather than zero: the journal does not record it, and `turn: 0` on every
    // event would render a whole session's history as one opening turn.
    should(page[0]).not.have.property('turn');
    should(page[0]?.source).equal(JOURNAL_EVENT_SOURCE);
  });

  it('should default to the protocol client page ceiling and pass the cursor through unchanged', async () => {
    // Arrange
    const calls: JournalCall[] = [];
    const reads = service({ calls });

    // Act
    await reads.events('s1', 12, undefined);

    // Assert
    should(calls).eql([{ sessionId: 's1', afterSequence: 12, limit: MAX_EVENT_PAGE }]);
  });

  it('should serve an empty page as a fact', async () => {
    // Arrange
    const reads = service({ events: [] });

    // Act
    const page = await reads.events('s1', 0, 10);

    // Assert — the journal is authoritative and keyed by session id, so "nothing after 0" is true.
    should(page).eql([]);
  });

  it('should refuse a page carrying another session or a non-advancing cursor', async () => {
    // Arrange
    const wrongSession = service({ events: [{ ...stored(4), sessionId: 's2' }] });
    const staleCursor = service({ events: [stored(3)] });

    // Act
    const crossed = await wrongSession.events('s1', 3, 10).catch((error: unknown) => error);
    const stale = await staleCursor.events('s1', 3, 10).catch((error: unknown) => error);

    // Assert — neither contradiction may be rendered as this session's history.
    should(crossed).be.instanceof(OperatorReadError).and.have.property('failure', 'event_evidence_mismatch');
    should(stale).be.instanceof(OperatorReadError).and.have.property('failure', 'event_evidence_mismatch');
  });

  it('should refuse a cursor that is not a whole non-negative number', async () => {
    // Arrange
    const reads = service({});

    // Act
    const negative = await reads.events('s1', -1, undefined).catch((error: unknown) => error);
    const fractional = await reads.events('s1', 1.5, undefined).catch((error: unknown) => error);

    // Assert
    should(negative).be.instanceof(OperatorReadError).and.have.property('failure', 'invalid_query');
    should(fractional).be.instanceof(OperatorReadError).and.have.property('failure', 'invalid_query');
  });

  it('should refuse a page size outside the ceiling', async () => {
    // Arrange
    const reads = service({});

    // Act
    const zero = await reads.events('s1', 0, 0).catch((error: unknown) => error);
    const huge = await reads.events('s1', 0, MAX_EVENT_PAGE + 1).catch((error: unknown) => error);
    const fractional = await reads.events('s1', 0, 2.5).catch((error: unknown) => error);

    // Assert
    should(zero).be.instanceof(OperatorReadError).and.have.property('failure', 'invalid_query');
    should(huge).be.instanceof(OperatorReadError).and.have.property('failure', 'invalid_query');
    should(fractional).be.instanceof(OperatorReadError).and.have.property('failure', 'invalid_query');
  });
});

describe('OperatorReadService.snapshot', () => {
  it('should serve the live screen when the pane is alive', async () => {
    // Arrange
    const reads = service({ capture: { alive: true, dead: false, text: 'the agent is thinking' } });

    // Act
    const screen = await reads.snapshot('s1');

    // Assert
    should(screen).equal('the agent is thinking');
  });

  it('should refuse a session that records no terminal', async () => {
    // Arrange
    const reads = service({ capture: undefined });

    // Act
    const refusal = await reads.snapshot('s1').catch((error: unknown) => error);

    // Assert — distinct from a dead pane: this session never had a terminal to capture.
    should(refusal).be.instanceof(OperatorReadError).and.have.property('failure', 'no_terminal');
  });

  it('should refuse a dead pane rather than serving the blank screen it captures', async () => {
    // Arrange — the legacy capture returned '' with a zero exit code here, which a script reads as
    // a healthy but idle terminal. That is the false success this refusal exists to prevent.
    const gone = service({ capture: { alive: false, dead: true, text: '' } });
    const exited = service({ capture: { alive: true, dead: true, text: 'leftover frame' } });

    // Act
    const goneRefusal = await gone.snapshot('s1').catch((error: unknown) => error);
    const exitedRefusal = await exited.snapshot('s1').catch((error: unknown) => error);

    // Assert
    should(goneRefusal).be.instanceof(OperatorReadError).and.have.property('failure', 'pane_dead');
    should(exitedRefusal).be.instanceof(OperatorReadError).and.have.property('failure', 'pane_dead');
  });

  it('should serve the captured terminal frame only when stored evidence exists', async () => {
    // Arrange
    const reads = service({ storedSnapshot: { kind: 'read', text: 'finished screen' } });

    // Act
    const frame = await reads.snapshot('s1', false);

    // Assert
    should(frame).equal('finished screen');
  });

  it('should refuse a missing or unreadable stored frame rather than inventing a blank screen', async () => {
    // Arrange
    const missing = service({ storedSnapshot: { kind: 'absent' } });
    const damaged = service({ storedSnapshot: { kind: 'unreadable' } });

    // Act
    const missingRefusal = await missing.snapshot('s1', false).catch((error: unknown) => error);
    const damagedRefusal = await damaged.snapshot('s1', false).catch((error: unknown) => error);

    // Assert
    should(missingRefusal).be.instanceof(OperatorReadError).and.have.property('failure', 'stored_snapshot_unavailable');
    should(damagedRefusal).be.instanceof(OperatorReadError).and.have.property('failure', 'stored_snapshot_unreadable');
  });
});

describe('OperatorReadService.logs', () => {
  it('should render a resolved transcript tail', async () => {
    // Arrange
    const reads = service({ tail: { kind: 'read', events: [message('ready')] } });

    // Act
    const text = await reads.logs('s1', undefined);

    // Assert
    should(text).equal('[09:08:07] assistant/message: ready');
  });

  it('should read the default tail when no limit is named and honour one that is', async () => {
    // Arrange
    const tailLimits: number[] = [];
    const reads = service({ tailLimits });

    // Act
    await reads.logs('s1', undefined);
    await reads.logs('s1', 7);

    // Assert
    should(tailLimits).eql([DEFAULT_LOG_TAIL, 7]);
  });

  it('should refuse a tail outside the ceiling', async () => {
    // Arrange
    const reads = service({});

    // Act
    const refusal = await reads.logs('s1', MAX_LOG_TAIL + 1).catch((error: unknown) => error);

    // Assert
    should(refusal).be.instanceof(OperatorReadError).and.have.property('failure', 'invalid_query');
  });

  it('should refuse a session whose transcript file cannot be proved', async () => {
    // Arrange
    const reads = service({ tail: { kind: 'unresolved' } });

    // Act
    const refusal = await reads.logs('s1', undefined).catch((error: unknown) => error);

    // Assert — a blank page would tell the operator the agent said nothing, which is a claim the
    // daemon has no evidence for. The watcher's empty projection is right for the watcher only.
    should(refusal).be.instanceof(OperatorReadError).and.have.property('failure', 'no_transcript');
  });

  it('should refuse a transcript that was proved but could not be read', async () => {
    // Arrange
    const reads = service({ tail: { kind: 'unreadable' } });

    // Act
    const refusal = await reads.logs('s1', undefined).catch((error: unknown) => error);

    // Assert — a vanished or malformed file is damaged evidence, not an honestly empty transcript.
    should(refusal).be.instanceof(OperatorReadError).and.have.property('failure', 'transcript_unreadable');
  });

  it('should serve an empty read of a file it did resolve', async () => {
    // Arrange
    const reads = service({ tail: { kind: 'read', events: [] } });

    // Act
    const text = await reads.logs('s1', undefined);

    // Assert — the file exists and holds nothing yet. That one IS a fact.
    should(text).equal('');
  });

  it('should slice only between explicit started markers', async () => {
    // Arrange
    const reads = service({
      tail: {
        kind: 'read',
        events: [
          { kind: 'turn', harness: 'codex', role: 'system', state: 'started' },
          message('first'),
          { kind: 'turn', harness: 'codex', role: 'system', state: 'completed' },
          { kind: 'turn', harness: 'codex', role: 'system', state: 'started' },
          message('second'),
        ],
      },
    });

    // Act
    const first = await reads.logs('s1', undefined, 0);
    const second = await reads.logs('s1', undefined, 1);

    // Assert
    should(first).containEql('first').and.not.containEql('second');
    should(second).containEql('second').and.not.containEql('first');
  });

  it('should refuse a requested turn when transcript evidence has no explicit boundary', async () => {
    // Arrange
    const reads = service({ tail: { kind: 'read', events: [message('unpartitioned')] } });

    // Act
    const refusal = await reads.logs('s1', undefined, 0).catch((error: unknown) => error);

    // Assert
    should(refusal).be.instanceof(OperatorReadError).and.have.property('failure', 'turn_partition_unavailable');
  });
});

describe('OperatorReadService.messages', () => {
  const five = [row(10), row(20), row(30), row(40), row(50)];

  it('should serve the first page from the start and hand back a continuation', async () => {
    // Arrange
    const reads = service({ rows: five });

    // Act
    const page = await reads.messages('s1', undefined, 2);

    // Assert — the strict protocol projection, parsed rather than eyeballed.
    should(SessionTranscriptPageSchema.parse(page)).eql(page);
    should(page.v).equal(1);
    should(page.sessionId).equal('s1');
    should(page.messages.map(message => message.point.byteOffset)).eql([10, 20]);
    should(page.nextCursor).be.a.String();
  });

  it('should continue strictly after the anchor and end with a null cursor', async () => {
    // Arrange
    const reads = service({ rows: five });

    // Act — the real journey: every page but the first is opened with the previous page's own token.
    const first = await reads.messages('s1', undefined, 2);
    const middle = await reads.messages('s1', first.nextCursor ?? undefined, 2);
    const end = await reads.messages('s1', middle.nextCursor ?? undefined, 2);

    // Assert — no row is served twice and none is skipped, and the end is stated rather than guessed.
    should(middle.messages.map(message => message.point.byteOffset)).eql([30, 40]);
    should(end.messages.map(message => message.point.byteOffset)).eql([50]);
    should(end.nextCursor).be.null();
  });

  it('should answer a conversation with no addressable rows as an empty page', async () => {
    // Arrange
    const reads = service({ rows: [] });

    // Act
    const page = await reads.messages('s1', undefined, undefined);

    // Assert — the file was resolved and read; it holds nothing forkable yet, and that IS a fact.
    should(page.messages).eql([]);
    should(page.nextCursor).be.null();
  });

  it('should report no continuation exactly at the current end', async () => {
    // Arrange — a page whose size is the whole conversation must not hand back a cursor that would
    // then answer an empty page: null means "this is everything as it reads right now".
    const reads = service({ rows: five });

    // Act
    const page = await reads.messages('s1', undefined, five.length);

    // Assert
    should(page.messages).have.length(5);
    should(page.nextCursor).be.null();
  });

  it('should bound an unstated page by the default rather than serving the whole conversation', async () => {
    // Arrange
    const many = Array.from({ length: DEFAULT_MESSAGE_PAGE + 1 }, (_unused, index) => row(index));
    const reads = service({ rows: many });

    // Act
    const page = await reads.messages('s1', undefined, undefined);

    // Assert
    should(page.messages).have.length(DEFAULT_MESSAGE_PAGE);
    should(page.nextCursor).be.a.String();
  });

  it('should address two blocks of one record independently', async () => {
    // Arrange — ONE physical record, two message blocks. They share that record's chain value, exactly
    // as the frozen commitment requires, so the required block index is the only thing that tells them
    // apart — and the only thing that can make their tokens differ.
    const shared = new Uint8Array(32).fill(7);
    const blocks = [
      row(10, { point: { v: 1, byteOffset: 10, blockIndex: 0 }, rawPrefix: shared }),
      row(10, { point: { v: 1, byteOffset: 10, blockIndex: 1 }, rawPrefix: shared }),
    ];
    const reads = service({ rows: blocks });

    // Act
    const first = await reads.messages('s1', undefined, 1);
    const second = await reads.messages('s1', first.nextCursor ?? undefined, 1);

    // Assert — the cursor resumed at the SECOND block of the same offset, not past the record.
    should(first.messages.map(message => message.point.blockIndex)).eql([0]);
    should(second.messages.map(message => message.point.blockIndex)).eql([1]);
    should(first.messages[0]?.selectionBinding).not.equal(second.messages[0]?.selectionBinding);
  });

  it("should refuse a blank or malformed cursor as the caller's own query", async () => {
    // Arrange
    const reads = service({ rows: five });

    // Act
    const blank = await reads.messages('s1', '', undefined).catch((error: unknown) => error);
    const spaces = await reads.messages('s1', '   ', undefined).catch((error: unknown) => error);
    const nonsense = await reads.messages('s1', 'page-2', undefined).catch((error: unknown) => error);
    const selection = await reads.messages('s1', `s1.${'A'.repeat(43)}`, undefined).catch((error: unknown) => error);

    // Assert — `?cursor=` is not "no cursor": answering the first page would silently restart a walk
    // the caller thought it was resuming. A selection binding is not a cursor either.
    for (const refusal of [blank, spaces, nonsense, selection])
      should(refusal).be.instanceof(OperatorReadError).and.have.property('failure', 'invalid_query');
  });

  it('should refuse a cursor whose anchor is no longer in the conversation', async () => {
    // Arrange — truncated back past the anchor, so the row the cursor named is simply gone.
    const reads = service({ rows: five });
    const first = await reads.messages('s1', undefined, 2);
    const truncated = service({ rows: [row(10)] });

    // Act
    const refusal = await truncated.messages('s1', first.nextCursor ?? undefined, 2).catch((error: unknown) => error);

    // Assert
    should(refusal).be.instanceof(OperatorReadError).and.have.property('failure', 'message_cursor_stale');
  });

  it('should refuse a cursor whose anchor raw content was replaced at the same point', async () => {
    // Arrange — the point still resolves and the DISPLAY is byte-identical; only the raw prefix moved.
    const reads = service({ rows: five });
    const first = await reads.messages('s1', undefined, 2);
    const rewritten = service({
      rows: [row(10), row(20, { rawPrefix: new Uint8Array(32).fill(200) }), row(30)],
    });

    // Act
    const refusal = await rewritten.messages('s1', first.nextCursor ?? undefined, 2).catch((error: unknown) => error);

    // Assert — this is the substitution a coordinate alone cannot see.
    should(refusal).be.instanceof(OperatorReadError).and.have.property('failure', 'message_cursor_stale');
  });

  it('should refuse a cursor replayed against another session, run, provenance or key', async () => {
    // Arrange
    const issued = await service({ rows: five }).messages('s1', undefined, 2);
    const cursor = issued.nextCursor ?? undefined;
    const elsewhere = service({ rows: five, context: { ...CONTEXT, sessionId: 'other' } });
    const relaunched = service({ rows: five, context: { ...CONTEXT, incarnation: 'inc-two' } });
    const reresolved = service({
      rows: five,
      context: { ...CONTEXT, provenance: { ...CONTEXT.provenance, file: '/harness/home/two.jsonl' } },
    });
    const otherKey = service({ rows: five, codec: messageCodec(Buffer.from('a different key', 'utf8')) });

    // Act — `elsewhere` is asked for ITS own session id, so the refusal is about the token, not the path.
    const crossed = await elsewhere.messages('other', cursor, 2).catch((error: unknown) => error);
    const rerun = await relaunched.messages('s1', cursor, 2).catch((error: unknown) => error);
    const moved = await reresolved.messages('s1', cursor, 2).catch((error: unknown) => error);
    const tampered = await otherKey.messages('s1', cursor, 2).catch((error: unknown) => error);

    // Assert — ONE public answer for all four, so verification is no oracle for which part was wrong.
    for (const refusal of [crossed, rerun, moved, tampered])
      should(refusal).be.instanceof(OperatorReadError).and.have.property('failure', 'message_cursor_stale');
  });

  it('should keep a cursor valid across an append and a later-only rewrite or truncation', async () => {
    // Arrange
    const first = await service({ rows: five }).messages('s1', undefined, 2);
    const cursor = first.nextCursor ?? undefined;
    const appended = service({ rows: [...five, row(60), row(70)] });
    const laterRewritten = service({
      rows: [row(10), row(20), row(30, { rawPrefix: new Uint8Array(32).fill(201) }), row(40)],
    });
    const laterTruncated = service({ rows: [row(10), row(20), row(30)] });

    // Act
    const grown = await appended.messages('s1', cursor, 2);
    const changed = await laterRewritten.messages('s1', cursor, 2);
    const shortened = await laterTruncated.messages('s1', cursor, 2);

    // Assert — a live append must not invalidate the next page, and neither must a change to rows the
    // page never claimed. The cursor binds only the raw prefix already served.
    should(grown.messages.map(message => message.point.byteOffset)).eql([30, 40]);
    should(changed.messages.map(message => message.point.byteOffset)).eql([30, 40]);
    should(shortened.messages.map(message => message.point.byteOffset)).eql([30]);
    should(shortened.nextCursor).be.null();
  });

  it('should keep identical displays independently actionable', async () => {
    // Arrange — two rows a reader cannot tell apart, whose raw records differ.
    const twins = [
      row(10, { text: 'the same words', rawPrefix: new Uint8Array(32).fill(3) }),
      row(20, { text: 'the same words', rawPrefix: new Uint8Array(32).fill(4) }),
    ];
    const reads = service({ rows: twins });

    // Act
    const page = await reads.messages('s1', undefined, 2);
    const [first, second] = page.messages;

    // Assert — the browser never has to correlate by index or by hash, and the two cannot exchange
    // bindings however identical their text is.
    should(first?.text).equal(second?.text);
    should(first?.selectionBinding).not.equal(second?.selectionBinding);
  });

  it('should issue each binding over its own row raw prefix', async () => {
    // Arrange
    const codec = messageCodec();
    const reads = service({ rows: five, codec });

    // Act
    const page = await reads.messages('s1', undefined, 2);
    const target = five[1];
    const binding = page.messages[1]?.selectionBinding ?? '';
    const own = await verifySessionTranscriptMessageToken(
      codec,
      SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
      CONTEXT,
      target?.point ?? { v: 1, byteOffset: 0, blockIndex: 0 },
      target?.rawPrefix ?? new Uint8Array(32),
      binding,
    );
    const neighbour = await verifySessionTranscriptMessageToken(
      codec,
      SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
      CONTEXT,
      five[0]?.point ?? { v: 1, byteOffset: 0, blockIndex: 0 },
      five[0]?.rawPrefix ?? new Uint8Array(32),
      binding,
    );

    // Assert — the row the page served is the row the binding names, and no other row's.
    should(own).equal('accepted');
    should(neighbour).equal('stale');
  });

  it('should carry no raw evidence onto the wire', async () => {
    // Arrange
    const reads = service({ rows: five });

    // Act
    const page = await reads.messages('s1', undefined, 2);
    const wire = JSON.stringify(page);

    // Assert — the commitment leaves this module only inside a MAC. A bare digest beside a redacted
    // display would be an offline oracle against the very text redaction removed.
    should(wire).not.match(/rawPrefix/u);
    should(wire).not.containEql(Buffer.from(five[0]?.rawPrefix ?? new Uint8Array(0)).toString('base64url'));
    should(wire).not.containEql(Buffer.from(five[0]?.rawPrefix ?? new Uint8Array(0)).toString('hex'));
    // The WHOLE key set, not the absence of one name: a field added here later must be a decision.
    should(Object.keys(page.messages[0] ?? {}).sort()).eql(['point', 'role', 'selectionBinding', 'text', 'timestamp']);
  });

  it('should preserve order, cardinality and every durable fact of a served row', async () => {
    // Arrange — one row the harness stamped no time on, beside one it did.
    const unstamped = row(20, { timestamp: undefined, role: 'user' });
    const reads = service({ rows: [row(10), unstamped, row(30)] });

    // Act
    const page = await reads.messages('s1', undefined, 3);

    // Assert — the display is the only field this surface may change.
    should(page.messages.map(message => message.point)).eql([
      { v: 1, byteOffset: 10, blockIndex: 0 },
      { v: 1, byteOffset: 20, blockIndex: 0 },
      { v: 1, byteOffset: 30, blockIndex: 0 },
    ]);
    should(page.messages.map(message => message.role)).eql(['assistant', 'user', 'assistant']);
    should(page.messages[0]?.timestamp).equal(INSTANT);
    // ABSENT rather than null: `00:00:00` beside a real message is a claim about when it was said.
    should(page.messages[1]).not.have.property('timestamp');
  });

  it('should refuse a transcript it cannot prove, cannot read, or has not identified', async () => {
    // Arrange
    const unresolved = service({ read: { kind: 'unresolved' } });
    const unreadable = service({ read: { kind: 'unreadable' } });
    const undiscovered = service({
      rows: five,
      context: {
        ...CONTEXT,
        provenance: { v: 1, home: '/harness/home', identity: 'undiscovered' },
      },
    });

    // Act
    const missing = await unresolved.messages('s1', undefined, undefined).catch((error: unknown) => error);
    const damaged = await unreadable.messages('s1', undefined, undefined).catch((error: unknown) => error);
    const unnamed = await undiscovered.messages('s1', undefined, undefined).catch((error: unknown) => error);

    // Assert — a token framed over an unresolved provenance is evidence about a snapshot the daemon has
    // already replaced, so no row is addressable until the identity is established.
    should(missing).be.instanceof(OperatorReadError).and.have.property('failure', 'no_transcript');
    should(damaged).be.instanceof(OperatorReadError).and.have.property('failure', 'transcript_unreadable');
    should(unnamed).be.instanceof(OperatorReadError).and.have.property('failure', 'no_transcript');
    // COMPLETELY, and the code is unchanged. A complete read is bounded at 32 MiB and a read that stops
    // there reports `source-truncated`, which the digest owner refuses on rather than returning the rows
    // it did manage to read — so an operator who reads "could not read it" and retries is being told the
    // wrong thing. Clients still match the code; this asserts the human-facing half did not regress.
    should((damaged as OperatorReadError).message).match(/could not read completely$/u);
    should((damaged as OperatorReadError).message).not.match(/could not read it$/u);
  });

  it('should fail closed when the read answered under another session context', async () => {
    // Arrange — a miswired composition root, which must never be served as this session's conversation.
    const reads = service({ rows: five, context: { ...CONTEXT, sessionId: 's2' } });

    // Act
    const refusal = await reads.messages('s1', undefined, undefined).catch((error: unknown) => error);

    // Assert
    should(refusal).be.instanceof(OperatorReadError).and.have.property('failure', 'event_evidence_mismatch');
  });

  it('should refuse a page size outside the ceiling before it reads anything', async () => {
    // Arrange
    const reads: string[] = [];
    const service_ = service({ rows: five, reads });

    // Act
    const zero = await service_.messages('s1', undefined, 0).catch((error: unknown) => error);
    const huge = await service_.messages('s1', undefined, MAX_MESSAGE_PAGE + 1).catch((error: unknown) => error);
    const fractional = await service_.messages('s1', undefined, 2.5).catch((error: unknown) => error);

    // Assert
    for (const refusal of [zero, huge, fractional])
      should(refusal).be.instanceof(OperatorReadError).and.have.property('failure', 'invalid_query');
    should(reads).eql([]);
  });

  it('should read the source exactly once per page', async () => {
    // Arrange
    const reads: string[] = [];
    const service_ = service({ rows: five, reads });

    // Act
    const first = await service_.messages('s1', undefined, 2);
    await service_.messages('s1', first.nextCursor ?? undefined, 2);

    // Assert — the anchor is resolved from the SAME read that serves the rows, so no page is ever
    // assembled from two views of a file that changed in between, and no cursor costs a second scan.
    should(reads).eql(['s1', 's1']);
  });

  it('should issue a cursor whose anchor is the final row it served', async () => {
    // Arrange
    const codec = messageCodec();
    const reads = service({ rows: five, codec });

    // Act
    const page = await reads.messages('s1', undefined, 2);
    const last = five[1];
    const verdict = await verifySessionTranscriptMessageToken(
      codec,
      SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
      CONTEXT,
      last?.point ?? { v: 1, byteOffset: 0, blockIndex: 0 },
      last?.rawPrefix ?? new Uint8Array(32),
      page.nextCursor ?? '',
    );
    const minted = await issueSessionTranscriptMessageToken(
      codec,
      SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
      CONTEXT,
      last?.point ?? { v: 1, byteOffset: 0, blockIndex: 0 },
      last?.rawPrefix ?? new Uint8Array(32),
    );

    // Assert
    should(verdict).equal('accepted');
    should(page.nextCursor).equal(minted);
  });
});

describe('renderTranscript', () => {
  it('should render every event kind in the author/kind vocabulary', () => {
    // Arrange
    const events = [
      message('hello', { role: 'user' }),
      { kind: 'reasoning', harness: 'claude', role: 'assistant', text: 'thinking', format: 'thinking' },
      {
        kind: 'tool-call',
        harness: 'claude',
        role: 'tool',
        call: { id: 'c1', name: 'Read', input: { file: 'a.ts' } },
      },
      {
        kind: 'tool-result',
        harness: 'claude',
        role: 'tool',
        result: { callId: 'c1', content: null, text: 'ok', isError: false },
      },
      {
        kind: 'tool-result',
        harness: 'claude',
        role: 'tool',
        result: { callId: 'c2', content: { a: 1 }, isError: true },
      },
      { kind: 'attachment', harness: 'claude', role: 'user', attachment: { kind: 'image', name: 'a.png' } },
      { kind: 'attachment', harness: 'claude', role: 'user', attachment: { kind: 'remote-control', url: 'wss://x' } },
      { kind: 'error', harness: 'claude', role: 'system', error: { message: 'boom', code: 'E1', recoverable: false } },
      { kind: 'error', harness: 'claude', role: 'system', error: { message: 'plain', recoverable: true } },
      { kind: 'usage', harness: 'claude', role: 'system', usage: { inputTokens: 3 } },
      { kind: 'turn', harness: 'claude', role: 'system', state: 'completed' },
      { kind: 'settings', harness: 'claude', role: 'system', settings: { model: 'opus' } },
    ] as unknown as readonly TranscriptEvent[];

    // Act
    const lines = renderTranscript(events).split('\n');

    // Assert
    should(lines).eql([
      '[09:08:07] user/message: hello',
      'assistant/reasoning: thinking',
      'tool/tool-call: Read({"file":"a.ts"})',
      'tool/tool-result: ok',
      'tool/tool-result: error {"a":1}',
      'user/attachment: image',
      'user/attachment: remote-control wss://x',
      'system/error: E1: boom',
      'system/error: plain',
      'system/usage: in=3 out=0',
      'system/turn: completed',
      'system/settings: {"model":"opus"}',
    ]);
  });

  it('should indent a multi-line body under its own header', () => {
    // Arrange / Act
    const text = renderTranscript([message('first\nsecond')]);

    // Assert — a code block an agent wrote stays readable, and the event boundary stays visible.
    should(text).equal('[09:08:07] assistant/message: first\n    second');
  });

  it('should omit the time rather than inventing one', () => {
    // Arrange / Act
    const missing = renderTranscript([message('a', { timestamp: undefined })]);
    const unparseable = renderTranscript([message('b', { timestamp: 'not a time' })]);

    // Assert — `00:00:00` beside a real message is a claim about when the agent said it.
    should(missing).equal('assistant/message: a');
    should(unparseable).equal('assistant/message: b');
  });

  it('should render an empty tail as an empty string', () => {
    // Arrange / Act / Assert
    should(renderTranscript([])).equal('');
  });
});
