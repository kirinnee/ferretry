/**
 * Where Claude keeps a conversation's transcript, and what a conversation id may be. Pure.
 */
import { describe, expect, it } from 'bun:test';
import { claudeTranscriptPath, isConversationId } from '../../../daemon/lib/harness/claude-path.ts';

describe('claudeTranscriptPath', () => {
  it('encodes every character of the folder that is not a letter or a digit as a dash', () => {
    expect(claudeTranscriptPath('/placeholder/work.dir/my_app', 'abc-123')).toBe(
      'projects/-placeholder-work-dir-my-app/abc-123.jsonl',
    );
  });
});

describe('isConversationId', () => {
  it('accepts one plain name', () => {
    expect(isConversationId('0a1b2c3d-4e5f')).toBe(true);
    expect(isConversationId('A_b-c')).toBe(true);
  });

  it('refuses what is not a string, is empty, starts with a separator or holds a path', () => {
    for (const value of [undefined, 7, '', '-leading', '_leading', 'a/b', '../up', 'has space', 'a'.repeat(129)])
      expect(isConversationId(value)).toBe(false);
  });

  it('accepts a name of the longest allowed length', () => {
    expect(isConversationId('a'.repeat(128))).toBe(true);
  });
});
