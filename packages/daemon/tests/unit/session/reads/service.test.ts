import { describe, it } from 'bun:test';
import should from 'should';
import {
  DEFAULT_LOG_TAIL,
  JOURNAL_EVENT_SOURCE,
  MAX_EVENT_PAGE,
  MAX_LOG_TAIL,
  OperatorReadError,
  OperatorReadService,
  type PaneCapture,
  renderTranscript,
  type StoredSessionEvent,
  type TranscriptTailResult,
} from '../../../../src/lib/session/reads/index.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

/**
 * Every way an operator read can be WRONG rather than merely empty.
 *
 * The three reads share one rule and these cases are its proof: a blank answer is served only when
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

const service = (options: {
  readonly events?: readonly StoredSessionEvent[];
  readonly calls?: JournalCall[];
  readonly capture?: PaneCapture | undefined;
  readonly tail?: TranscriptTailResult;
  readonly tailLimits?: number[];
  readonly storedSnapshot?:
    | { readonly kind: 'absent' | 'unreadable' }
    | { readonly kind: 'read'; readonly text: string };
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
