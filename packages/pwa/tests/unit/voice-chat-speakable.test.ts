import { describe, expect, test } from 'bun:test';
import {
  MORE_ON_SCREEN,
  READING_CHARACTERS_PER_MINUTE,
  readingCapCharacters,
  sentencesOf,
  speakableSegments,
  speakInline,
} from '../../src/lib/voice-chat/speakable.ts';

/**
 * Read aloud turns markdown into what is SAID. Each case is a golden: the markdown a ferret writes, and the
 * exact sentences the voice (and the captions) get. Code, tables and pictures are described, never read.
 */

const said = (markdown: string, maxCharacters?: number): string[] =>
  speakableSegments(markdown, maxCharacters === undefined ? {} : { maxCharacters }).segments.map(s => s.text);

const FENCE = '```';
const FY = (body: string): string => `${FENCE}fy-render\n${body}\n${FENCE}`;

describe('speakableSegments: prose', () => {
  test('reads paragraphs a sentence at a time, headings with a stop after them', () => {
    expect(said('# The plan\n\nFirst we look. Then we fix it!\n\nDone?')).toEqual([
      'The plan.',
      'First we look.',
      'Then we fix it!',
      'Done?',
    ]);
  });

  test('says the plain words of bold, italic, strikethrough and escapes', () => {
    expect(said('I **really** like _this_ and ~~not~~ that \\* thing.')).toEqual([
      'I really like this and not that * thing.',
    ]);
  });

  test('does not split on an abbreviation or before a lowercase word', () => {
    expect(sentencesOf('Use a tool, e.g. the hook. Then stop. then go.')).toEqual([
      'Use a tool, e.g. the hook.',
      'Then stop. then go.',
    ]);
  });

  test('drops emoji and HTML, and keeps the words around them', () => {
    expect(said('Shipped 🎉🚀 it <b>today</b>.<br>Really 👨‍👩‍👧.')).toEqual(['Shipped it today.', 'Really.']);
    expect(said('<details>\n<summary>More</summary>\n\nInside.\n</details>')).toEqual(
      ['More', 'Inside.'].map(s => `${s}${s.endsWith('.') ? '' : '.'}`),
    );
  });

  test('says nothing for a hidden comment, and keeps offsets honest', () => {
    const source = 'Before.\n\n<!-- secret\nmore -->\n\nAfter.';
    const reading = speakableSegments(source);
    expect(reading.segments.map(s => s.text)).toEqual(['Before.', 'After.']);
    const last = reading.segments[1];
    expect(source.slice(last?.sourceRange.start, last?.sourceRange.end)).toBe('After.');
  });

  test('a quote is announced as one', () => {
    expect(said('> Careful with <b>this</b>.\n> Really.')).toEqual(['Quote: Careful with this.', 'Really.']);
  });

  test('horizontal rules are silent', () => {
    expect(said('One.\n\n---\n\nTwo.')).toEqual(['One.', 'Two.']);
  });
});

describe('speakableSegments: described, not read', () => {
  test('code fence: lines and language, never the code', () => {
    const markdown = `Look:\n\n${FENCE}ts\nconst secret = 'x';\nconst b = 2;\n${FENCE}\n\nOk.`;
    expect(said(markdown)).toEqual(['Look:', "Code block, 2 lines of TypeScript. It's on screen.", 'Ok.']);
    expect(said(markdown).join(' ')).not.toContain('secret');
  });

  test('code fence with no language, one line, and an unclosed fence', () => {
    expect(said(`${FENCE}\nls\n${FENCE}`)).toEqual(["Code block, 1 line. It's on screen."]);
    expect(said(`${FENCE}bash\na\nb\nc`)).toEqual(["Code block, 3 lines of shell. It's on screen."]);
    expect(said('~~~rust\nfn main() {}\n~~~')).toEqual(["Code block, 1 line of Rust. It's on screen."]);
  });

  test('table: how many rows and what the columns are, not the cells', () => {
    const table =
      '| name | status | cost |\n| --- | :-: | ---: |\n| alpha | done | 4 |\n| beta | open | 9 |\n| gamma | open | 1 |';
    expect(said(table)).toEqual(['A table with 3 rows. Columns: name, status, cost.']);
    expect(said('| a |\n|---|\n| x |')).toEqual(['A table with 1 row. Columns: a.']);
    expect(said(`| ${'c |'.repeat(8)}\n|${'-|'.repeat(8)}\n| ${'x |'.repeat(8)}`)).toEqual([
      'A table with 1 row. Columns: c, c, c, c, c, c, and 2 more.',
    ]);
  });

  test('fy-render: the required alt, by kind', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    expect(said(FY(`type: svg\nalt: A ten by ten square, filled solid\n---\n${svg}`))).toEqual([
      'An illustration: A ten by ten square, filled solid.',
    ]);
    expect(said(FY('type: mermaid\nalt: Login flow from browser to daemon.\n---\ngraph TD; A-->B'))).toEqual([
      'A diagram: Login flow from browser to daemon.',
    ]);
    expect(said(FY('type: map\nalt: The office\n---\ncenter: [0, 0]'))[0]).toBe('A map: The office.');
  });

  test('a broken fy-render block is what the screen shows it as: a code block', () => {
    expect(said(FY('type: nonsense\nalt: x\n---\nbody'))).toEqual(["Code block, 4 lines. It's on screen."]);
  });

  test('images: the alt text, or just "an image"', () => {
    expect(said('![Cost by month](chart.png)')).toEqual(['An image: Cost by month.']);
    expect(said('![](x.png)')).toEqual(["An image. It's on screen."]);
    expect(said('See ![the chart](c.png) here.')).toEqual(['See an image: the chart here.']);
  });
});

describe('speakableSegments: links, references and ids', () => {
  test('a link is its text; a bare URL is a link to its host', () => {
    expect(said('Open [the docs](https://example.com/a/b) now.')).toEqual(['Open the docs now.']);
    expect(said('Go to https://www.github.com/kirinnee/ferretry/pull/3. Then <https://x.dev:8080/y>.')).toEqual([
      'Go to a link to github.com.',
      'Then a link to x.dev.',
    ]);
    expect(said('[https://example.com/long/path](https://example.com/long/path)')).toEqual(['a link to example.com.']);
  });

  test('references become words, from the one reference grammar', () => {
    expect(said('Ask :dev about &F12, then !A3, see @packages/pwa/src/lib/a.ts:12 and %terminal:build.')).toEqual([
      'Ask ferret dev about task F12, then agenda item A3, see a.ts and terminal build.',
    ]);
  });

  test('commit hashes and UUIDs are "a commit" and "an ID", but numbers and versions are read', () => {
    expect(said('Fixed in 3f2a9c1b4d and 11b889e72f0a1b2c3d4e5f60718293a4b5c6d7e8.')).toEqual([
      'Fixed in a commit and a commit.',
    ]);
    expect(said('Run 0a1b2c3d-1111-2222-3333-444455556666 on version 4.277.0 (20261105, 1234567).')).toEqual([
      'Run an ID on version 4.277.0 (20261105, 1234567).',
    ]);
    expect(said(`The digest ${'ab12'.repeat(16)} is stored.`)).toEqual(['The digest an ID is stored.']);
  });

  test('inline code: short word-like code is read, paths by file name, the rest is "a code snippet"', () => {
    expect(said('Call `useDictation` or `snake_case_name` and `fy-render`.')).toEqual([
      'Call use dictation or snake case name and fy render.',
    ]);
    expect(said('Edit `packages/pwa/src/hooks/use-dictation.ts` and `package.json`.')).toEqual([
      'Edit use-dictation.ts and package dot json.',
    ]);
    expect(said('Run `const x = foo(a, b) => { return 1 }` now.')).toEqual(['Run a code snippet now.']);
    expect(said('A reference in code: `@src/lib/a.ts` and `&F9`.')).toEqual(['A reference in code: a.ts and task F9.']);
  });
});

describe('speakableSegments: lists', () => {
  test('each item is read, task boxes and wrapped lines handled, nesting flattened', () => {
    expect(said('- one\n- two\n  wrapped\n  - nested\n- [x] done\n1. first\n2) second')).toEqual([
      'one.',
      'two wrapped.',
      'nested.',
      'done.',
      'first.',
      'second.',
    ]);
  });

  test('more than eight items: the first five, then a count', () => {
    const items = Array.from({ length: 11 }, (_, i) => `- item ${i + 1}`).join('\n');
    expect(said(items)).toEqual(['item 1.', 'item 2.', 'item 3.', 'item 4.', 'item 5.', 'and 6 more.']);
    expect(said(Array.from({ length: 8 }, (_, i) => `- item ${i + 1}`).join('\n'))).toHaveLength(8);
  });

  test('a list ends at the first blank line that is not followed by more of it', () => {
    expect(said('- a\n- b\n\nAfter the list.')).toEqual(['a.', 'b.', 'After the list.']);
    expect(said('- a\n\n- b\n\nAfter.')).toEqual(['a.', 'b.', 'After.']);
  });
});

describe('speakableSegments: a long reply', () => {
  const sentence = 'This sentence is exactly fifty characters long ok.';
  const long = Array.from({ length: 40 }, () => sentence).join(' ');

  test('stops at about a minute and says there is more on screen', () => {
    const reading = speakableSegments(long);
    expect(reading.truncated).toBe(true);
    const texts = reading.segments.map(s => s.text);
    expect(texts.at(-1)).toBe(MORE_ON_SCREEN);
    expect(reading.segments.at(-1)?.kind).toBe('more');
    const spoken = texts.slice(0, -1).join(' ').length;
    expect(spoken).toBeLessThanOrEqual(READING_CHARACTERS_PER_MINUTE);
    expect(spoken).toBeGreaterThan(READING_CHARACTERS_PER_MINUTE - 60);
  });

  test('faster speech fits more into the same minute', () => {
    expect(readingCapCharacters(1)).toBe(900);
    expect(readingCapCharacters(2)).toBe(1800);
    expect(readingCapCharacters(0.1)).toBe(720);
    expect(readingCapCharacters(Number.NaN)).toBe(900);
    const slow = speakableSegments(long, { maxCharacters: readingCapCharacters(0.8) }).segments.length;
    const fast = speakableSegments(long, { maxCharacters: readingCapCharacters(2) }).segments.length;
    expect(fast).toBeGreaterThan(slow);
  });

  test('a short reply is not truncated and has no "more" segment', () => {
    const reading = speakableSegments('Short and sweet.');
    expect(reading.truncated).toBe(false);
    expect(reading.segments.map(s => s.kind)).toEqual(['text']);
  });

  test('one huge sentence with no stops is cut at a word, never mid-word', () => {
    const reading = speakableSegments(`${'wordy '.repeat(500)}end`);
    const first = reading.segments[0]?.text ?? '';
    expect(first.length).toBeLessThanOrEqual(READING_CHARACTERS_PER_MINUTE + 1);
    expect(
      first
        .replace(/\.$/u, '')
        .split(' ')
        .every(word => word === 'wordy'),
    ).toBe(true);
    expect(reading.segments.at(-1)?.text).toBe(MORE_ON_SCREEN);
  });

  test('a code-heavy reply spends its minute on descriptions too', () => {
    const block = `Intro.\n\n${FENCE}ts\na\n${FENCE}\n\n`;
    const reading = speakableSegments(block.repeat(30), { maxCharacters: 120 });
    expect(reading.truncated).toBe(true);
    expect(reading.segments.some(s => s.kind === 'code')).toBe(true);
  });
});

describe('speakableSegments: golden — a real-looking reply', () => {
  const reply = [
    '## What I changed',
    '',
    'I fixed `useDictation` in [the hook](https://github.com/x/y/pull/9) (commit 3f2a9c1b4d). See @packages/pwa/src/hooks/use-dictation.ts:12 ✅',
    '',
    `${FENCE}ts`,
    'export const a = 1;',
    'export const b = 2;',
    FENCE,
    '',
    '| file | change |',
    '| --- | --- |',
    '| a.ts | edit |',
    '',
    FY('type: mermaid\nalt: Browser talks to the daemon.\n---\ngraph TD; A-->B'),
    '',
    '- Tests pass',
    '- Docs updated',
    '',
    '> Ask :dev about &F12.',
  ].join('\n');

  test('segments, kinds and the source each came from', () => {
    const reading = speakableSegments(reply);
    expect(reading.truncated).toBe(false);
    expect(reading.segments.map(s => [s.kind, s.text])).toEqual([
      ['heading', 'What I changed.'],
      ['text', 'I fixed use dictation in the hook (commit a commit).'],
      ['text', 'See use-dictation.ts.'],
      ['code', "Code block, 2 lines of TypeScript. It's on screen."],
      ['table', 'A table with 1 row. Columns: file, change.'],
      ['diagram', 'A diagram: Browser talks to the daemon.'],
      ['list', 'Tests pass.'],
      ['list', 'Docs updated.'],
      ['quote', 'Quote: Ask ferret dev about task F12.'],
    ]);
    for (const segment of reading.segments) {
      expect(segment.sourceRange.start).toBeGreaterThanOrEqual(0);
      expect(segment.sourceRange.end).toBeLessThanOrEqual(reply.length);
      expect(segment.sourceRange.end).toBeGreaterThanOrEqual(segment.sourceRange.start);
    }
    const code = reading.segments.find(s => s.kind === 'code');
    expect(reply.slice(code?.sourceRange.start, code?.sourceRange.end)).toBe(
      `${FENCE}ts\nexport const a = 1;\nexport const b = 2;\n${FENCE}`,
    );
  });
});

describe('speakableSegments: total', () => {
  test('empty, blank and markup-only input has nothing to say', () => {
    for (const empty of ['', '   \n\n  ', '---', '<div></div>', '<!-- x -->', '🎉', '```\n```x']) {
      const reading = speakableSegments(empty);
      expect(reading.truncated).toBe(false);
      expect(Array.isArray(reading.segments)).toBe(true);
    }
    expect(said('')).toEqual([]);
    expect(said('   \n\n  ')).toEqual([]);
    expect(said('<div></div>')).toEqual([]);
  });

  test('never throws, whatever it is given', () => {
    const hostile: unknown[] = [
      undefined,
      null,
      42,
      {},
      '\u0000 \uD800 lone surrogate \uDC00',
      '[[[[[[[[[[[[[[[[](((((((((',
      '`'.repeat(5000),
      '*'.repeat(5000),
      '> '.repeat(3000),
      '| a |\n|---|\n'.repeat(2000),
      `${'#'.repeat(10)} x`,
      '&#99999999999; &#xD800; &bogus; &amp;',
      `${FENCE}fy-render\ntype: svg\n${FENCE}`,
      '- '.repeat(50_000),
      'x'.repeat(300_000),
    ];
    for (const input of hostile) {
      const reading = speakableSegments(input as string);
      expect(Array.isArray(reading.segments)).toBe(true);
      for (const segment of reading.segments) expect(typeof segment.text).toBe('string');
    }
  });

  test('a huge reply is bounded in time and says there is more', () => {
    const started = performance.now();
    const reading = speakableSegments('A sentence here. '.repeat(100_000));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(reading.truncated).toBe(true);
  });

  test('speakInline is total too and strips its own marker character', () => {
    expect(speakInline('ab')).toBe('a b');
    expect(speakInline('')).toBe('');
    expect(speakInline('&amp; &lt;3 &#x41;')).toBe('& <3 A');
  });
});
