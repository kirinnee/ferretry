import { describe, it } from 'bun:test';
import should from 'should';
import { createdPrUrls } from '../../../src/lib/board-github/index.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';

const meta = { harness: 'claude', sessionId: 's', index: 0 } as const;
const call = (id: string, command: string): TranscriptEvent =>
  ({
    ...meta,
    kind: 'tool-call',
    call: { id, name: 'Bash', input: { command, nested: [1, null, true] } },
  }) as unknown as TranscriptEvent;
const result = (callId: string, text: string | undefined, content: unknown = [], isError = false): TranscriptEvent =>
  ({
    ...meta,
    kind: 'tool-result',
    result: { callId, content, isError, ...(text === undefined ? {} : { text }) },
  }) as unknown as TranscriptEvent;

describe('createdPrUrls', () => {
  it("should find the URL printed by the session's own gh pr create, from text or content, each once", () => {
    const events: TranscriptEvent[] = [
      call('1', 'cd /w && direnv exec . gh pr create --title x --body y'),
      result('1', 'Creating pull request…\nhttps://github.com/kirinnee/ferretry/pull/940\n'),
      call('2', 'gh  pr   create -f'),
      result('2', undefined, [{ type: 'text', text: 'https://github.com/kirinnee/ferretry/pull/941' }]),
      call('3', 'gh pr create'),
      result('3', 'https://github.com/kirinnee/ferretry/pull/940'),
    ];
    should(createdPrUrls(events)).deepEqual([
      'https://github.com/kirinnee/ferretry/pull/940',
      'https://github.com/kirinnee/ferretry/pull/941',
    ]);
  });

  it('should ignore URLs the session only mentioned, viewed, or that a failed create printed', () => {
    const events: TranscriptEvent[] = [
      call('1', 'gh pr view 12'),
      result('1', 'https://github.com/kirinnee/ferretry/pull/12'),
      call('2', 'gh pr create'),
      result('2', 'a pull request for branch already exists: https://github.com/kirinnee/ferretry/pull/13', [], true),
      result('9', 'https://github.com/kirinnee/ferretry/pull/14'),
      {
        ...meta,
        kind: 'message',
        role: 'assistant',
        text: 'see https://github.com/kirinnee/ferretry/pull/15',
      } as unknown as TranscriptEvent,
    ];
    should(createdPrUrls(events)).be.empty();
  });
});
