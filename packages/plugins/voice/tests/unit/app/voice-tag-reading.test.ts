import { describe, expect, test } from 'bun:test';
import { MORE_ON_SCREEN, speakableSegments } from '../../../app/lib/voice-chat/speakable.ts';

/**
 * Read aloud and Auto-read say ONLY the `<voice>` lines of a reply that has any (Conversation's grammar,
 * `contract/voice-tag.ts`); a reply with none is read exactly as before.
 */

const FENCE = '```';
const said = (markdown: string, maxCharacters?: number): string[] =>
  speakableSegments(markdown, maxCharacters === undefined ? {} : { maxCharacters }).segments.map(s => s.text);

describe('a reply with spoken lines', () => {
  test('says only the lines, in order, and none of the written work', () => {
    const reply = [
      '<voice>Let me check.</voice>',
      '',
      '## Findings',
      '',
      '- the build is red',
      `${FENCE}ts\nconst secret = 1;\n${FENCE}`,
      '',
      '<voice>The build is red. I fixed it.</voice>',
    ].join('\n');
    expect(said(reply)).toEqual(['Let me check.', 'The build is red.', 'I fixed it.']);
  });

  test('says a line only once it is closed; with none closed the reply is read as written', () => {
    expect(said('Written words.\n\n<voice>Let me chec')).toEqual(['Written words.', 'Let me chec.']);
    expect(said('<voice>Done.</voice>\n\n<voice>Let me chec')).toEqual(['Done.']);
  });

  test('a tag shown inside code does not make the reply a spoken one', () => {
    expect(said('Use `<voice>hi</voice>` to speak.')).toEqual(['Use a code snippet to speak.']);
  });

  test('points each segment back at the words in the source', () => {
    const source = 'x <voice>Hello there.</voice>';
    const [segment] = speakableSegments(source).segments;
    expect(segment?.sourceRange).toEqual({ start: 9, end: source.length });
  });

  test('is still capped at about a minute, and says there is more', () => {
    const long = Array.from({ length: 40 }, (_, index) => `<voice>Sentence number ${index} is here.</voice>`).join(
      '\n\n',
    );
    const reading = speakableSegments(long, { maxCharacters: 120 });
    expect(reading.truncated).toBe(true);
    expect(reading.segments.at(-1)?.text).toBe(MORE_ON_SCREEN);
  });

  test('a reply of only an empty line says what it said before', () => {
    expect(said('<voice>  </voice>')).toEqual(said('  '));
  });
});

describe('a reply with no spoken line', () => {
  test('is read as it was', () => {
    expect(said('Plain words. And more.')).toEqual(['Plain words.', 'And more.']);
  });
});
