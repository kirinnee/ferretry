/**
 * What the session observer asks of Conversation, answered by Conversation's own code over real transcript text.
 *
 * Moved from `packages/core/ferrets/tests/integration/daemon/session/observer/` — `session-worker-runtime.test.ts`,
 * `session-observation-applier.test.ts`, `worker-observer-host.test.ts`, `inline-observer-host.test.ts` and
 * `parity.test.ts`. Those tests keep the observer's own behaviour (when it looks, in what order it writes, how a
 * worker and this thread agree) against a scripted stand-in for Conversation. This file holds the other half: that the
 * real transcript reader, send evidence, hook-file parser and question policy give the answers the stand-in is
 * scripted with, for the same transcript lines and the same documents.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AnswerOperationRecord,
  reconcileAnswerEvidence,
  STRUCTURED_ANSWER_RELEASED_AGENDA_KIND,
} from '../../../daemon/questions/lib/answer-ledger.ts';
import { parseAskedQuestion, withAskedQuestion } from '../../../daemon/questions/lib/asked.ts';
import { projectStructuredQuestion, structuredQuestionStatePatch } from '../../../daemon/questions/lib/projection.ts';
import { IncrementalTranscriptTail } from '../../../daemon/reader/lib/session/reader.ts';
import { TranscriptSendEvidence } from '../../../daemon/delivery/lib/view.ts';
import { ClaudeTranscriptParser } from '../../../daemon/reader/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../daemon/reader/lib/transcript/codex.ts';
import type {
  TranscriptBatch,
  TranscriptHarness,
  TranscriptSource,
  TranscriptWindow,
} from '../../../daemon/reader/lib/transcript/types.ts';

const NOW = '2026-10-22T08:00:00.000Z';
const line = (record: object) => `${JSON.stringify(record)}\n`;
const claudeUser = (text: string) =>
  line({
    type: 'user',
    sessionId: 's',
    uuid: `u-${text}`,
    parentUuid: null,
    timestamp: NOW,
    message: { role: 'user', content: text },
  });
const ASK = line({
  type: 'assistant',
  sessionId: 's',
  uuid: 'a-ask',
  parentUuid: null,
  timestamp: NOW,
  message: {
    id: 'm-ask',
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_ship',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Ship?',
              header: 'Ship',
              multiSelect: false,
              options: [
                { label: 'Yes', description: 'y' },
                { label: 'No', description: 'n' },
              ],
            },
          ],
        },
      },
    ],
  },
});
const ANSWER = line({
  type: 'user',
  sessionId: 's',
  uuid: 'u-answer',
  parentUuid: null,
  timestamp: NOW,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ship', content: 'Yes' }] },
});
const codexEvent = (type: string) => line({ timestamp: NOW, type: 'event_msg', payload: { type, turn_id: 'turn-1' } });
const CODEX_CONTEXT = line({ timestamp: NOW, type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'high' } });

/** A transcript source over text the test holds, parsed by the real parser of the harness; a window answers it whole. */
function sourceOver(harness: TranscriptHarness, files: Map<string, string>): TranscriptSource {
  const parser = harness === 'claude' ? new ClaudeTranscriptParser() : new CodexTranscriptParser();
  const batch = (file: string): TranscriptBatch => {
    const text = files.get(file) ?? '';
    const parsed = parser.parse({ text, source: file, endOfInput: true });
    return {
      harness,
      file,
      reset: false,
      cursor: { byteOffset: Buffer.byteLength(text), pendingBytes: 0, nextLine: 1 },
      events: parsed.events,
      observedInputs: parsed.observedInputs,
      issues: parsed.issues,
    };
  };
  return {
    harness,
    read: async file => batch(file),
    follow: async function* (file) {
      yield batch(file);
    },
    window: (file): TranscriptWindow => {
      let read = false;
      return {
        file,
        next: async () => {
          if (read) return { more: false };
          read = true;
          return { batch: batch(file), more: false };
        },
      };
    },
  };
}

const accepted: AnswerOperationRecord = {
  requestId: 'request-1',
  toolUseId: 'tool-1',
  fingerprint: 'fingerprint-1',
  acceptedAt: NOW,
  outcome: 'accepted',
} as AnswerOperationRecord;
const questionCall = {
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  timestamp: NOW,
  call: {
    id: 'tool-1',
    name: 'AskUserQuestion',
    input: {},
    questions: [{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }], multiple: false }],
  },
} as const;
const released = {
  kind: 'tool-result',
  harness: 'claude',
  role: 'tool',
  result: { callId: 'tool-1', content: 'Yes', isError: false },
} as const;

describe('the transcript tail, as the observer reads it', () => {
  it('should read a person’s message and a question call from a Claude transcript, and only what was appended on the next read', async () => {
    // Arrange
    const files = new Map([['/t/a.jsonl', claudeUser('go')]]);
    const tail = new IncrementalTranscriptTail(sourceOver('claude', files), '/t/a.jsonl', 'a', 400);

    // Act
    const first = await tail.read();
    files.set('/t/a.jsonl', claudeUser('go') + ASK);
    const second = await tail.read();

    // Assert
    should(first.map(event => [event.kind, event.role])).deepEqual([['message', 'user']]);
    should(second.map(event => event.kind)).deepEqual(['message', 'tool-call']);
    const call = second.at(-1);
    should(call).containDeep({ kind: 'tool-call', call: { id: 'toolu_ship', name: 'AskUserQuestion' } });
  });

  it('should read a Codex turn’s boundaries and the model its context names', async () => {
    // Arrange
    const files = new Map([['/t/c.jsonl', codexEvent('task_started') + CODEX_CONTEXT + codexEvent('task_complete')]]);
    const tail = new IncrementalTranscriptTail(sourceOver('codex', files), '/t/c.jsonl', 'c', 400);

    // Act
    const events = await tail.read();

    // Assert
    should(events.filter(event => event.kind === 'turn').map(event => (event as { state: string }).state)).deepEqual([
      'started',
      'completed',
    ]);
    should(events.some(event => event.kind === 'settings' && event.settings.model === 'gpt-5.5')).be.true();
  });
});

describe('the send tracker’s transcript evidence, as the observer’s worker answers it', () => {
  it('should read a transcript it is bound to and find the person’s message in it', async () => {
    // Arrange
    const files = new Map([['/t/a.jsonl', claudeUser('go')]]);
    const source = sourceOver('claude', files);
    const subject = new TranscriptSendEvidence(async id => ({ sessionId: id, harness: 'claude' }), {
      file: async () => '/t/a.jsonl',
      window: async (target, start) => source.window('/t/a.jsonl', { sessionId: target.sessionId, start }),
    });

    // Act
    const evidence = await subject.read('a', '2026-10-22T07:59:00.000Z');

    // Assert
    should(evidence.readable).be.true();
    should(evidence.inputs.map(input => input.text)).deepEqual(['go']);
  });

  it('should answer unreadable, with no input, for a session with no transcript bound', async () => {
    // Arrange
    const subject = new TranscriptSendEvidence(async () => undefined, {
      file: async () => undefined,
      window: async () => undefined,
    });

    // Act
    const evidence = await subject.read('a', NOW);

    // Assert
    should(evidence).deepEqual({ readable: false, inputs: [] });
  });
});

describe('the question the harness’s hook recorded, as the observer projects it', () => {
  it('should project the question the hook wrote while the transcript still holds it back', () => {
    // Arrange — Claude 2.1.281 writes the call only once the form is answered; its hook wrote it as asked.
    const transcript = '/t/a.jsonl';
    const hook = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_hook',
      transcript_path: transcript,
      tool_input: { questions: [{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
    });
    const askedAtMs = Date.parse(NOW) + 1_000;
    const events = new ClaudeTranscriptParser().parse({ text: claudeUser('ship it?'), endOfInput: true }).events;

    // Act
    const asked = parseAskedQuestion(hook, askedAtMs, transcript);
    const projection = projectStructuredQuestion(withAskedQuestion(events, asked));

    // Assert
    should(projection).containDeep({ kind: 'pending', question: { toolUseId: 'toolu_hook' } });
  });

  it('should ignore a hook file that names another transcript', () => {
    // Arrange
    const hook = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_hook',
      transcript_path: '/t/other.jsonl',
      tool_input: { questions: [{ question: 'Ship?', options: [{ label: 'Yes' }] }] },
    });

    // Act
    const asked = parseAskedQuestion(hook, Date.parse(NOW), '/t/a.jsonl');

    // Assert
    should(asked).be.undefined();
  });
});

describe('the question policy, for the documents and receipts the observer’s writer decides from', () => {
  it('should project a question call as pending, then as resolved once its result lands', async () => {
    // Arrange
    const files = new Map([['/t/a.jsonl', claudeUser('go') + ASK]]);
    const source = sourceOver('claude', files);

    // Act
    const asking = projectStructuredQuestion((await source.read('/t/a.jsonl')).events);
    files.set('/t/a.jsonl', claudeUser('go') + ASK + ANSWER);
    const answered = projectStructuredQuestion((await source.read('/t/a.jsonl')).events);

    // Assert
    should(asking).containDeep({ kind: 'pending', question: { toolUseId: 'toolu_ship' } });
    should(answered).deepEqual({ kind: 'resolved', toolUseId: 'toolu_ship' });
  });

  it('should record a pending question as awaiting the owner’s answer', () => {
    // Arrange
    const projection = projectStructuredQuestion([questionCall]);

    // Act
    const patch = structuredQuestionStatePatch({ status: 'running' }, projection, []);

    // Assert
    should(patch.status).equal('awaiting_question');
    should(patch.pendingQuestion?.toolUseId).equal('tool-1');
  });

  it('should settle a receipt the document already stamped as confirmed, and write nothing more', () => {
    // Arrange
    const state = { status: 'running', lastAnsweredQuestionToolUseId: 'tool-1' } as const;
    const projection = projectStructuredQuestion([questionCall, released]);

    // Act
    const evidence = reconcileAnswerEvidence(new Map([['request-1', accepted]]), state, {
      resolvedToolUseId: 'tool-1',
    });
    const patch = structuredQuestionStatePatch(state, projection, [...evidence.records.values()]);

    // Assert
    should(evidence.settlements.map(record => record.outcome)).deepEqual(['confirmed']);
    should(patch).deepEqual({});
  });

  it('should quarantine a receipt whose form advanced without a stamp, and ask the owner to look', () => {
    // Arrange
    const state = { status: 'awaiting_question' } as const;
    const projection = projectStructuredQuestion([questionCall, released]);

    // Act
    const evidence = reconcileAnswerEvidence(new Map([['request-1', accepted]]), state, {
      resolvedToolUseId: 'tool-1',
    });
    const patch = structuredQuestionStatePatch(state, projection, [...evidence.records.values()]);

    // Assert
    should(evidence.settlements.map(record => record.outcome)).deepEqual(['quarantined']);
    should(patch).match({ status: 'awaiting_user', needsHumanKind: STRUCTURED_ANSWER_RELEASED_AGENDA_KIND });
  });

  it('should leave a receipt open while its form has not advanced', () => {
    // Arrange
    const state = { status: 'awaiting_question' } as const;
    const projection = projectStructuredQuestion([questionCall]);

    // Act
    const evidence = reconcileAnswerEvidence(new Map([['request-1', accepted]]), state, {
      activeToolUseId: 'tool-1',
    });

    // Assert
    should(evidence.settlements).deepEqual([]);
    should(projection.kind).equal('pending');
  });
});
