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

describe('claudeTranscriptPath for a long folder', () => {
  // Recorded from the real Claude Code 2.1.327: each folder below was the working folder of a real `claude -p` run, and
  // the last word is the name of the project folder Claude then made (the first 200 characters of the dashed spelling,
  // a dash, and a base-36 hash of the folder).
  const folderOf = (...widths: number[]) =>
    `/tmp/gen-long-FM19ly/${widths.map((width, index) => `d${index}${'x'.repeat(width)}`).join('/')}`;
  const recorded: readonly [readonly number[], string][] = [
    [[100, 100, 100], 'twad71'],
    [[120, 120, 90, 7], 'g2zsyb'],
    [[60, 60, 60, 60, 60, 25], 'exwzys'],
  ];

  for (const [widths, hash] of recorded)
    it(`spells a ${folderOf(...widths).length}-character folder the way Claude does`, () => {
      const folder = folderOf(...widths);
      const dashed = folder.replaceAll(/[^a-zA-Z0-9]/gu, '-');
      const spelled = claudeTranscriptPath(folder, 'abc-123');
      expect(spelled).toBe(`projects/${dashed.slice(0, 200)}-${hash}/abc-123.jsonl`);
      expect(spelled.split('/')[1]?.length).toBe(207);
    });

  it('keeps a folder of exactly 200 characters as it is, and hashes one of 201', () => {
    expect(claudeTranscriptPath(`/${'a'.repeat(199)}`, 'c').split('/')[1]).toBe(`-${'a'.repeat(199)}`);
    expect(claudeTranscriptPath(`/${'a'.repeat(200)}`, 'c').split('/')[1]).toMatch(/^-a{199}-[0-9a-z]+$/u);
  });
});
