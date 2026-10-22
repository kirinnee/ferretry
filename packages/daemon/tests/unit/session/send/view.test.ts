import { describe, it } from 'bun:test';
import { SendRecordSchema } from '@ferretry/protocol';
import should from 'should';
import { parseSessionId, type SessionId } from '../../../../src/lib/index.ts';
import {
  AgentSendFailureNotifier,
  type SendRecord,
  type SendTarget,
  sendFailureNotice,
  sendRecordView,
  TranscriptSendEvidence,
} from '../../../../src/lib/session/send/index.ts';
import type { SessionTranscriptReader, TranscriptTarget } from '../../../../src/lib/session/transcript/reader.ts';
import type {
  ObservedHumanInput,
  TranscriptBatch,
  TranscriptWindow,
  TranscriptWindowStart,
  TranscriptWindowStep,
} from '../../../../src/lib/transcript/types.ts';

const ID = parseSessionId('session-1');
const AT = '2026-08-01T12:00:00.000Z';

function record(overrides: Partial<SendRecord> = {}): SendRecord {
  return {
    sendId: 'send-1',
    acceptedAt: AT,
    acceptedTurn: 2,
    path: 'native-file',
    message: 'hi',
    fate: 'accepted',
    ...overrides,
  };
}

describe('a send record on the wire', () => {
  it('keeps every proven fact and drops the private payload path and typed text', () => {
    const view = sendRecordView(
      record({
        matchText: 'Read /state/channel/queued-send-1.md',
        payloadFile: '/state/channel/queued-send-1.md',
        turn: 3,
        attachmentIds: ['att_1'],
        from: 'session-2',
        fromName: 'hadi',
        senderKind: 'agent',
        replyExpected: true,
        held: false,
        fate: 'timed_out',
        fateAt: AT,
        unaccountedReason: 'not_delivered',
        queuedAt: AT,
        queueProof: 'pane',
        attempt: 2,
        attemptAt: AT,
        deadlineAt: AT,
        retryable: true,
        evidence: {
          key: 'k',
          harness: 'claude',
          kind: 'chat.user',
          proof: 'normal-user-record',
          observedAt: AT,
          shapeVersion: 1,
          matchedTurn: 3,
          tier: 'queue-file-id',
        },
      }),
    );

    should(SendRecordSchema.parse(view)).deepEqual(view);
    should(view).match({ v: 1, fate: 'timed_out', attachmentIds: ['att_1'], senderKind: 'agent', retryable: true });
    should(JSON.stringify(view)).not.match(/queued-send-1/);
  });

  it('carries what the pane showed and what a cancel did, so the row can say it', () => {
    const typed = sendRecordView(record({ typedNotSent: true }));
    const cancelled = sendRecordView(record({ fate: 'cancelled', cancelEffect: 'left_in_queue' }));

    should(SendRecordSchema.parse(typed)).match({ fate: 'accepted', typedNotSent: true });
    should(SendRecordSchema.parse(cancelled)).match({ fate: 'cancelled', cancelEffect: 'left_in_queue' });
  });

  it('serves a withdrawn send as a tombstone rather than dropping it', () => {
    const view = sendRecordView(record({ fate: 'withdrawn' }));
    should(view).match({ fate: 'accepted', withdrawn: true, attachmentIds: [] });
    should(SendRecordSchema.parse(view).withdrawn).be.true();
  });
});

describe('transcript evidence for the tracker', () => {
  type Issue = TranscriptBatch['issues'][number];
  const issue = (code: Issue['code']): Issue => ({ harness: 'claude', code, message: code, recoverable: true });
  const input = (key: string, observedAt = AT): ObservedHumanInput => ({
    harness: 'claude',
    text: key,
    proof: 'normal-user-record',
    observedAt,
    proofKey: key,
    shapeVersion: 1,
  });
  const batch = (
    inputs: readonly ObservedHumanInput[],
    issues: readonly Issue[] = [],
    reset = false,
  ): TranscriptBatch => ({
    harness: 'claude',
    file: '/t.jsonl',
    reset,
    cursor: { byteOffset: 0, pendingBytes: 0, nextLine: 1 },
    events: [],
    observedInputs: inputs,
    issues,
  });

  /** A window that answers each step from a script, then reports nothing new. */
  class ScriptedWindow implements TranscriptWindow {
    readonly steps: (TranscriptWindowStep | Error)[];
    taken = 0;
    constructor(
      readonly file: string,
      readonly start: TranscriptWindowStart,
      steps: (TranscriptWindowStep | Error)[] = [],
    ) {
      this.steps = [...steps];
    }
    async next(): Promise<TranscriptWindowStep> {
      this.taken += 1;
      const step = this.steps.shift() ?? { more: false };
      if (step instanceof Error) throw step;
      return step;
    }
  }

  class FakeReader implements Pick<SessionTranscriptReader, 'window' | 'file'> {
    file$: string | undefined = '/t.jsonl';
    opened: ScriptedWindow[] = [];
    script: (TranscriptWindowStep | Error)[][] = [];
    noSource = false;
    async file(): Promise<string | undefined> {
      return this.file$;
    }
    async window(_target: TranscriptTarget, start: TranscriptWindowStart): Promise<TranscriptWindow | undefined> {
      if (this.noSource) return undefined;
      const window = new ScriptedWindow(this.file$ ?? '', start, this.script.shift());
      this.opened.push(window);
      return window;
    }
  }

  const evidence = (reader: FakeReader, known = true) =>
    new TranscriptSendEvidence(async id => (known ? { sessionId: id, harness: 'claude' } : undefined), reader);

  it('opens a window a minute before the oldest send, and is readable when nothing blinded it', async () => {
    const reader = new FakeReader();
    reader.script = [[{ batch: batch([input('k')], [issue('invalid-json')]), more: false }]];

    const reading = await evidence(reader).read(ID, AT);

    should(reading).match({ readable: true, inputs: [{ proofKey: 'k' }] });
    should(reader.opened[0]?.start).eql({ at: 'since', instant: '2026-08-01T11:59:00.000Z' });
  });

  it('holds the window, so a later look reads only what was appended since', async () => {
    const reader = new FakeReader();
    reader.script = [
      [
        { batch: batch([input('a')]), more: true },
        { batch: batch([input('b')]), more: false },
      ],
    ];
    const subject = evidence(reader);

    const first = await subject.read(ID, AT);
    reader.opened[0]?.steps.push({ batch: batch([input('c')]), more: false });
    const second = await subject.read(ID, '2026-08-01T12:05:00.000Z');
    reader.opened[0]?.steps.push({ batch: batch([input('d')], [], true), more: false });
    const replaced = await subject.read(ID, '2026-08-01T12:05:00.000Z');

    should(first.inputs.map(each => each.proofKey)).eql(['a', 'b']);
    should(second.inputs.map(each => each.proofKey)).eql(['a', 'b', 'c']);
    // A file that restarted drops what the old one proved.
    should(replaced.inputs.map(each => each.proofKey)).eql(['d']);
    should(reader.opened).have.length(1);
  });

  it('opens a new window for an older send, a re-bound file, or an instant it cannot read', async () => {
    const reader = new FakeReader();
    const subject = evidence(reader);

    await subject.read(ID, AT);
    await subject.read(ID, '2026-08-01T11:00:00.000Z');
    reader.file$ = '/other.jsonl';
    await subject.read(ID, '2026-08-01T11:00:00.000Z');
    await subject.read(parseSessionId('session-9'), 'not an instant');

    should(reader.opened.map(window => window.file)).eql(['/t.jsonl', '/t.jsonl', '/other.jsonl', '/other.jsonl']);
    should(reader.opened.at(-1)?.start).eql({ at: 'beginning' });
  });

  it('is blind on a look that lost records, and for good once the window could not reach the send', async () => {
    const reader = new FakeReader();
    reader.script = [
      [{ batch: batch([], [issue('oversized-record')]), more: false }],
      [{ batch: batch([input('k')], [issue('source-truncated')]), more: false }],
    ];
    const lossy = evidence(reader);
    const capped = evidence(reader);

    const lost = await lossy.read(ID, AT);
    const recovered = await lossy.read(ID, AT);
    const partial = await capped.read(ID, AT);
    const stillPartial = await capped.read(ID, AT);

    should(lost.readable).be.false();
    should(recovered.readable).be.true();
    // Presence it saw is still handed over; only absence is unprovable.
    should(partial).match({ readable: false, inputs: [{ proofKey: 'k' }] });
    should(stillPartial.readable).be.false();
  });

  it('is blind when a step throws or the file outgrows the steps one look may take', async () => {
    const reader = new FakeReader();
    reader.script = [[new Error('EIO')], Array.from({ length: 80 }, () => ({ batch: batch([]), more: true }))];

    const failed = await evidence(reader).read(ID, AT);
    const endless = await evidence(reader).read(ID, AT);

    should(failed.readable).be.false();
    should(endless.readable).be.false();
    should(reader.opened[1]?.taken).equal(64);
  });

  it('tells an unknown session, an unbound transcript and a missing source apart', async () => {
    const reader = new FakeReader();
    const unknown = await evidence(reader, false).read(ID, AT);
    reader.noSource = true;
    const sourceless = await evidence(reader).read(ID, AT);
    reader.file$ = undefined;
    const unbound = await evidence(reader).read(ID, AT);

    should(unknown).deepEqual({ readable: false, inputs: [] });
    should(sourceless).deepEqual({ readable: false, inputs: [] });
    // No transcript this daemon can prove: said as itself, because waiting never makes it readable.
    should(unbound).deepEqual({ readable: false, unbound: true, inputs: [] });
  });

  it('holds a bounded number of windows and inputs', async () => {
    const reader = new FakeReader();
    const many = Array.from({ length: 5_000 }, (_, index) => input(`k${String(index)}`));
    reader.script = [[{ batch: batch(many), more: false }]];
    const subject = evidence(reader);

    await subject.read(ID, AT);
    const kept = await subject.read(ID, AT);
    for (let index = 0; index < 64; index += 1) await subject.read(parseSessionId(`session-x${String(index)}`), AT);
    await subject.read(ID, AT);

    should(kept.inputs).have.length(4_096);
    should(kept.inputs[0]?.proofKey).equal('k904');
    // The first session's window was the least recently used, so it was let go and opened again.
    should(reader.opened).have.length(66);
  });
});

describe('telling an agent its message did not arrive', () => {
  it('says why, how many attempts, and that the decision is theirs', () => {
    should(sendFailureNotice('hadi', record({ fate: 'timed_out', attempt: 4 }), 'fy')).match(
      /Your message to hadi \(send send-1\) did not reach it: it was not delivered \(not delivered\) after 4 attempt\(s\)\. Decide whether to send it again with `fy send hadi …`\./,
    );
    should(sendFailureNotice('hadi', record({ fate: 'timed_out', unaccountedReason: 'session_ended' }), 'fy')).match(
      /\(session ended\) after 1 attempt/,
    );
    should(sendFailureNotice('hadi', record({ fate: 'unaccounted' }), 'fy')).match(
      /could not be confirmed \(timeout\) — it may still have landed/,
    );
    // Unconfirmed is not "did not reach it": it may be in the recipient's queue right now.
    should(sendFailureNotice('hadi', record({ fate: 'unaccounted' }), 'fy')).not.match(/did not reach it/);
    should(
      sendFailureNotice('hadi', record({ fate: 'unaccounted', unaccountedReason: 'pane_unreadable' }), 'fy'),
    ).match(/\(pane unreadable\)/);
  });

  it('says a message to a session with no provable transcript reached its terminal, and not to resend', () => {
    const notice = sendFailureNotice(
      'zarah',
      record({ fate: 'unaccounted', unaccountedReason: 'transcript_unbound' }),
      'fy',
    );

    should(notice).match(/was typed into zarah’s terminal/);
    should(notice).match(/no transcript Ferretry can prove is zarah’s/);
    should(notice).match(/Do not send it again/);
    should(notice).not.match(/did not reach it/);
  });

  it('says a revive-carried message was handed over as the relaunch’s first turn, and not to resend', () => {
    const notice = sendFailureNotice(
      'hank',
      record({ path: 'revive', fate: 'unaccounted', unaccountedReason: 'revive_unconfirmed' }),
      'fy',
    );

    should(notice).match(/was handed to hank as the first turn of its relaunch/);
    should(notice).match(/delivery cannot be confirmed/);
    should(notice).match(/do not send it again unless hank stays silent/);
    should(notice).not.match(/did not reach it/);
  });

  it('sends the notice into the sender’s own session, as the daemon, keyed by the failed send', async () => {
    const sent: unknown[] = [];
    const sender: SendTarget = { id: parseSessionId('session-2'), status: 'running', mode: 'auto', turn: 1 };
    const recipient: SendTarget = { id: ID, status: 'running', mode: 'auto', turn: 1, teammate: 'hadi' };
    const subject = (named: boolean, found: boolean) =>
      new AgentSendFailureNotifier(
        { send: async request => void sent.push(request) as never },
        {
          resolveSender: async () => (found ? sender : undefined),
          read: async (_id: SessionId) => (named ? recipient : undefined),
        },
        'fy',
      );

    await subject(true, true).notify('session-2', ID, record({ fate: 'timed_out' }));
    await subject(false, true).notify('session-2', ID, record({ fate: 'timed_out' }));
    await subject(true, false).notify('gone', ID, record({ fate: 'timed_out' }));

    should(sent).have.length(2);
    should(sent[0]).match({
      id: 'session-2',
      sendId: `send-failed:${ID}:send-1`,
      origin: 'daemon',
      message: /to hadi/,
    });
    should(sent[1]).match({ message: new RegExp(`to ${ID}`) });
  });
});
