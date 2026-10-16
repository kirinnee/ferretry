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
import type { TranscriptBatch } from '../../../../src/lib/transcript/types.ts';

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

  it('serves a withdrawn send as a tombstone rather than dropping it', () => {
    const view = sendRecordView(record({ fate: 'withdrawn' }));
    should(view).match({ fate: 'accepted', withdrawn: true, attachmentIds: [] });
    should(SendRecordSchema.parse(view).withdrawn).be.true();
  });
});

describe('transcript evidence for the tracker', () => {
  const batch = (issues: TranscriptBatch['issues']): TranscriptBatch => ({
    harness: 'claude',
    file: '/t.jsonl',
    reset: false,
    cursor: { byteOffset: 0, pendingBytes: 0, nextLine: 1 },
    events: [],
    observedInputs: [
      { harness: 'claude', text: 'hi', proof: 'normal-user-record', observedAt: AT, proofKey: 'k', shapeVersion: 1 },
    ],
    issues,
  });

  it('is readable only when nothing blinded the read to its newest records', async () => {
    const reads: string[] = [];
    const subject = (result: TranscriptBatch | undefined, known = true) =>
      new TranscriptSendEvidence(async id => (known ? { sessionId: id, harness: 'claude' } : undefined), {
        read: async target => {
          reads.push(target.sessionId);
          return result;
        },
      });

    const clean = await subject(batch([])).read(ID);
    const truncated = await subject(
      batch([{ harness: 'claude', code: 'source-truncated', message: 'cut', recoverable: true }]),
    ).read(ID);
    const recoverable = await subject(
      batch([{ harness: 'claude', code: 'invalid-json', message: 'bad line', recoverable: true }]),
    ).read(ID);
    const unresolved = await subject(undefined).read(ID);
    const unknown = await subject(batch([]), false).read(ID);

    should(clean).match({ readable: true, inputs: [{ proofKey: 'k' }] });
    should(truncated.readable).be.false();
    should(recoverable.readable).be.true();
    should(unresolved).deepEqual({ readable: false, inputs: [] });
    should(unknown.readable).be.false();
    should(reads).eql([ID, ID, ID, ID]);
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
    should(
      sendFailureNotice('hadi', record({ fate: 'unaccounted', unaccountedReason: 'pane_unreadable' }), 'fy'),
    ).match(/\(pane unreadable\)/);
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
