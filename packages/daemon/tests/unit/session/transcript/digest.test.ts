import { describe, it } from 'bun:test';
import should from 'should';
import {
  ConversationDigestError,
  type ConversationMessagePoint,
  digestConversation,
} from '../../../../src/lib/session/transcript/index.ts';
import type { TranscriptBatch, TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

const point = (byteOffset: number, blockIndex?: number): ConversationMessagePoint => ({
  byteOffset,
  ...(blockIndex === undefined ? {} : { blockIndex }),
});

const message = (
  byteOffset: number,
  role: 'user' | 'assistant' | 'developer' | 'system',
  text: string,
  blockIndex?: number,
): TranscriptEvent => ({
  kind: 'message',
  harness: 'claude',
  role,
  text,
  byteOffset,
  ...(blockIndex === undefined ? {} : { blockIndex }),
});

const toolCall = (byteOffset: number): TranscriptEvent => ({
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  byteOffset,
  call: { id: 'tool-1', name: 'Bash', input: { command: 'git status' } },
});

const transcript = (events: readonly TranscriptEvent[], issues: TranscriptBatch['issues'] = []): TranscriptBatch => ({
  harness: 'claude',
  file: '/durable/transcript.jsonl',
  reset: false,
  cursor: { byteOffset: 300, pendingBytes: 0, nextLine: 4 },
  events,
  observedInputs: [],
  issues,
});

describe('digestConversation', () => {
  it('should produce a portable prefix at an exact message coordinate and declare omitted tool state', () => {
    // Arrange
    const batch = transcript([
      message(0, 'system', 'You are an assistant.'),
      message(40, 'user', 'Inspect the repository.'),
      toolCall(88),
      message(150, 'assistant', 'The repository is clean.'),
      message(210, 'user', 'This must not be included.'),
    ]);

    // Act
    const actual = digestConversation('session-1', batch, point(150));

    // Assert
    should(actual).eql({
      sessionId: 'session-1',
      through: { byteOffset: 150 },
      messages: [
        { point: { byteOffset: 0 }, role: 'system', text: 'You are an assistant.' },
        { point: { byteOffset: 40 }, role: 'user', text: 'Inspect the repository.' },
        { point: { byteOffset: 150 }, role: 'assistant', text: 'The repository is clean.' },
      ],
      omissions: [{ point: { byteOffset: 88 }, kind: 'tool-call', reason: 'harness-specific' }],
    });
  });

  it('should distinguish messages normalized from one record by block index', () => {
    // Arrange
    const batch = transcript([message(0, 'user', 'first', 0), message(0, 'assistant', 'second', 1)]);

    // Act
    const actual = digestConversation('session-1', batch, point(0, 1));

    // Assert
    should(actual.messages.map(entry => entry.text)).eql(['first', 'second']);
    should(actual.through).eql({ byteOffset: 0, blockIndex: 1 });
  });

  it('should refuse a bounded or malformed transcript rather than returning a shorter history', () => {
    // Arrange
    const batch = transcript(
      [message(0, 'user', 'keep me')],
      [
        {
          harness: 'claude',
          code: 'source-truncated',
          message: 'read cap reached',
          recoverable: false,
        },
      ],
    );

    // Act
    const failure = () => digestConversation('session-1', batch, point(0));

    // Assert
    should(failure).throw(ConversationDigestError, { failure: 'incomplete_transcript' });
  });

  it('should refuse a target that is absent or names non-message evidence', () => {
    // Arrange
    const batch = transcript([message(0, 'user', 'keep me'), toolCall(80)]);

    // Act / Assert
    should(() => digestConversation('session-1', batch, point(20))).throw(ConversationDigestError, {
      failure: 'target_not_found',
    });
    should(() => digestConversation('session-1', batch, point(80))).throw(ConversationDigestError, {
      failure: 'target_not_message',
    });
  });
});
