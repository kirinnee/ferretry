import { describe, expect, test } from 'bun:test';
import {
  MORE_ON_SCREEN,
  READING_CHARACTERS_PER_MINUTE,
  readingCapCharacters,
  readingCapForSeconds,
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

  test('a skill reference is "skill" and its name', () => {
    expect(said('Run $update-config first.')).toEqual(['Run skill update-config first.']);
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

  test('a length in seconds scales the minute; no limit is the scan limit; nonsense is the minute', () => {
    expect(readingCapForSeconds(1, 60)).toBe(900);
    expect(readingCapForSeconds(1, 30)).toBe(450);
    expect(readingCapForSeconds(2, 120)).toBe(3600);
    expect(readingCapForSeconds(1, null)).toBeGreaterThan(readingCapForSeconds(2, 300));
    for (const nonsense of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readingCapForSeconds(1, nonsense)).toBe(900);
    }
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

  test('a failure inside still gives a reading: the reply is on screen', () => {
    const hostile = {
      get maxCharacters(): number {
        throw new Error('boom');
      },
    };
    const reading = speakableSegments('Hello.', hostile);
    expect(reading.truncated).toBe(true);
    expect(reading.segments.map(s => s.text)).toEqual(['This reply is on screen.']);
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
    // Whatever it is handed, it answers with words or nothing, never an exception.
    const hostile = {
      get value(): string {
        throw new Error('boom');
      },
    };
    expect(speakInline(hostile as unknown as string)).toBe('');
  });
});

describe('speakableSegments: hostile input stays cheap (review round 1, finding 1)', () => {
  // The first call pays for building the parser; time the rest.
  speakableSegments('warm up');
  const quick = (name: string, markdown: string): void => {
    test(`${name} is read in well under 100 ms`, () => {
      const started = performance.now();
      const reading = speakableSegments(markdown);
      expect(performance.now() - started).toBeLessThan(100);
      expect(Array.isArray(reading.segments)).toBe(true);
    });
  };

  quick('3,200 unmatched backticks after text', `Some text ${'`'.repeat(3200)}`);
  quick('6,400 unmatched backticks after text', `Some text ${'`'.repeat(6400)}`);
  quick('50,000 backticks', '`'.repeat(50_000));
  quick('alternating backtick runs', '` ``'.repeat(10_000));
  quick(
    'backtick runs of every length',
    Array.from({ length: 4000 }, (_, i) => `${'`'.repeat((i % 9) + 1)}a`).join(' '),
  );
  quick('50,000 open brackets', '['.repeat(50_000));
  quick('open brackets and spaces', '[ '.repeat(20_000));
  quick('link openers', '[a]('.repeat(10_000));
  quick('image openers', '!['.repeat(20_000));
  quick('50,000 tildes', '~'.repeat(50_000));
  quick('tilde pairs', 'a ~~ '.repeat(8000));
  quick('a long run of stars around a word', `${'*'.repeat(20_000)}a${'*'.repeat(20_000)}`);
  quick('a long run of underscores', `a${'_'.repeat(30_000)}b`);
  quick('a long run of dots', `a${'.'.repeat(30_000)}b`);
  quick('unclosed tags', '<a '.repeat(10_000));
  quick('unclosed comments', '<!-- '.repeat(6000));
  quick('a line of 5,000 nested list markers', `${'- '.repeat(5000)}x`);
  quick('a line of 5,000 nested quote markers', `${'> '.repeat(5000)}x`);
  quick('thousands of list lines', '- a\n'.repeat(20_000));
  quick('thousands of table rows', `| a | b |\n|---|---|\n${'| 1 | 2 |\n'.repeat(5000)}`);
  quick('a hash-like word 30,000 long', 'a'.repeat(30_000));
  quick('a path-like code span 30,000 long', `\`${'/'.repeat(30_000)}\``);
  quick('sentence-ending marks with no space after', `a${'.!?'.repeat(10_000)}b`);
  quick('thousands of tiny sentences', 'A. '.repeat(30_000));

  test('sentencesOf is linear on a long run of marks and on a long unspaced word', () => {
    const started = performance.now();
    expect(sentencesOf(`a${'.'.repeat(50_000)}b`)).toEqual([`a${'.'.repeat(50_000)}b`]);
    expect(sentencesOf(`${'a'.repeat(50_000)}. Next one.`)).toHaveLength(2);
    expect(sentencesOf('A. '.repeat(20_000))).toHaveLength(20_000);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test('the excess of a run is blanked, one for one, so offsets still slice the original', () => {
    const source = `Before.\n\n${'*'.repeat(100)}\n\nAfter ${'.'.repeat(60)} here.\n\nLast.`;
    const reading = speakableSegments(source);
    const last = reading.segments.at(-1);
    expect(source.slice(last?.sourceRange.start, last?.sourceRange.end)).toBe('Last.');
    expect(reading.segments.map(s => s.text)[0]).toBe('Before.');
  });

  test('nested markers past eight on a line are plain text; the line keeps its length', () => {
    const source = `${'- '.repeat(12)}deep text`;
    const reading = speakableSegments(source);
    expect(reading.segments.map(s => s.text)).toEqual(['x x x x deep text.']);
    const only = reading.segments[0];
    expect(source.slice(only?.sourceRange.start, only?.sourceRange.end)).toBe('- - - - deep text');
    expect(said(`${'1. '.repeat(11)}x`)).toEqual(['x. x. x. x.']);
    expect(said(`${'> '.repeat(11)}q`)).toEqual(['Quote: x x x q.']);
  });

  test('a hard line break is a space, not a joined word', () => {
    expect(said('First line\\\nsecond line.')).toEqual(['First line second line.']);
    expect(said('Trailing  \nbreak.')).toEqual(['Trailing break.']);
  });

  test('a number that is not a list marker is left alone', () => {
    expect(said('12345678901. not a list\n\n1.x\n\n2024 was fine.')).toEqual([
      '12345678901. not a list.',
      '1.x.',
      '2024 was fine.',
    ]);
  });

  test('a reply of more than 400 lines is read from its first 400 and says there is more', () => {
    const reading = speakableSegments('- a\n'.repeat(500));
    expect(reading.truncated).toBe(true);
    expect(reading.segments.map(s => s.text)).toEqual(['a.', 'a.', 'a.', 'a.', 'a.', 'and 395 more.', MORE_ON_SCREEN]);
  });

  test('containers nested deeper than the walk allows are on screen, not read, and nothing throws', () => {
    const nest = (depth: number): string =>
      Array.from({ length: depth }, (_, level) => `${'  '.repeat(level)}- level ${level}`).join('\n');
    const shallow = said(nest(5));
    expect(shallow).toEqual(['level 0.', 'level 1.', 'level 2.', 'level 3.', 'level 4.']);
    const deep = said(nest(40));
    expect(deep.length).toBeGreaterThan(5);
    expect(deep.length).toBeLessThan(40);
    expect(deep[0]).toBe('level 0.');
  });

  test('emphasis nested deeper than the walk allows still gives the words it can', () => {
    const marks = ['*', '_'];
    const levels = 60;
    const open = Array.from({ length: levels }, (_, i) => `${marks[i % 2]}w${i} `).join('');
    const close = Array.from({ length: levels }, (_, i) => ` ${marks[(levels - 1 - i) % 2]}`).join('');
    const reading = speakableSegments(`${open}core${close}`);
    expect(reading.segments.length).toBeGreaterThan(0);
    expect(reading.segments[0]?.text.startsWith('w0 w1')).toBe(true);
  });
});

describe('speakableSegments: nested markdown is described where it sits (finding 2)', () => {
  const NESTED_FY = (prefix: string): string =>
    ['~~~fy-render', 'type: mermaid', 'alt: Login flow from browser to daemon', '---', 'graph TD; A-->B', '~~~']
      .map(line => `${prefix}${line}`)
      .join('\n');

  test('a fy-render block inside a quote says its alt, not its header or payload', () => {
    const spoken = said(`> Look at this:\n>\n${NESTED_FY('> ')}`);
    expect(spoken).toEqual(['Quote: Look at this:', 'A diagram: Login flow from browser to daemon.']);
    expect(spoken.join(' ')).not.toMatch(/graph|type:|mermaid|---/u);
  });

  test('a fy-render block that starts a quote is described, with the quote announced first', () => {
    expect(said(NESTED_FY('> '))).toEqual(['Quote:', 'A diagram: Login flow from browser to daemon.']);
  });

  test('a fy-render block inside a list item says its alt', () => {
    const body = NESTED_FY('  ');
    expect(said(`- Step one\n\n${body}\n- Step two`)).toEqual([
      'Step one.',
      'A diagram: Login flow from browser to daemon.',
      'Step two.',
    ]);
  });

  test('a fy-render fence with anything after the language is an ordinary code block, as on screen', () => {
    expect(said('```fy-render notes\ntype: mermaid\nalt: x\n---\nA-->B\n```')).toEqual([
      "Code block, 4 lines of fy-render. It's on screen.",
    ]);
  });

  test('four-space-indented code is described, never read', () => {
    const spoken = said('Run this:\n\n    rm -rf secret\n    echo done\n\nThen wait.');
    expect(spoken).toEqual(['Run this:', "Code block, 2 lines. It's on screen.", 'Then wait.']);
    expect(spoken.join(' ')).not.toContain('secret');
  });

  test('code inside a list item is described, never read', () => {
    const spoken = said('1. Install it:\n\n   ```bash\n   curl secret.example | sh\n   ```\n\n2. Done.');
    expect(spoken).toEqual(['Install it:', "Code block, 1 line of shell. It's on screen.", 'Done.']);
    expect(spoken.join(' ')).not.toContain('secret');
  });

  test('code inside a quote, a nested list and a quoted list are described', () => {
    expect(said('> ```ts\n> const secret = 1;\n> ```')).toEqual([
      'Quote:',
      "Code block, 1 line of TypeScript. It's on screen.",
    ]);
    expect(said('- outer\n  - inner\n\n    ```\n    secret\n    ```')).toEqual([
      'outer.',
      'inner.',
      "Code block, 1 line. It's on screen.",
    ]);
    expect(said('> - first\n> - second\n>\n> after')).toEqual(['Quote:', 'first.', 'second.', 'after.']);
    expect(said('> > inner **quote**')).toEqual(['Quote: inner quote.']);
  });

  test('tables, images and html inside a list or quote are described too', () => {
    expect(said('> | a | b |\n> |---|---|\n> | 1 | 2 |')).toEqual(['Quote:', 'A table with 1 row. Columns: a, b.']);
    expect(said('- ![A chart](c.png)')).toEqual(['An image: A chart.']);
    expect(said('- <b>bold</b> item')).toEqual(['bold item.']);
  });

  test('task boxes, footnotes and link definitions are not read as symbols', () => {
    expect(said('- [ ] write it\n- [x] test it')).toEqual(['write it.', 'test it.']);
    expect(said('Claimed[^1] here.\n\n[^1]: The note.')).toEqual(['Claimed here.', 'The note.']);
    expect(said('See [the docs][d].\n\n[d]: https://example.com/docs')).toEqual(['See the docs.']);
  });

  test('a quote that is nothing but a rule or an empty line says nothing', () => {
    expect(said('>\n')).toEqual([]);
    expect(said('> ---')).toEqual([]);
  });

  test('a list longer than eight still reads five and counts the rest, nested items included', () => {
    const items = Array.from({ length: 9 }, (_, i) => `- item ${i}\n  - child ${i}`).join('\n');
    expect(said(items)).toEqual([
      'item 0.',
      'child 0.',
      'item 1.',
      'child 1.',
      'item 2.',
      'child 2.',
      'item 3.',
      'child 3.',
      'item 4.',
      'child 4.',
      'and 4 more.',
    ]);
  });
});

describe('speakableSegments: source ranges are UTF-16 offsets of the original (finding 5)', () => {
  const slices = (source: string): string[] =>
    speakableSegments(source).segments.map(s => source.slice(s.sourceRange.start, s.sourceRange.end));

  test('a comment holding a non-BMP character does not shift what follows', () => {
    expect(slices('Before.\n\n<!-- 😀 -->\n\nAfter.')).toEqual(['Before.', 'After.']);
  });

  test('astral characters in a comment, inline html, a code span and prose all keep their offsets', () => {
    expect(slices('A.\n\n<!-- 🎉🚀 multi\nline 𝒳 -->\n\nB 𝒳 text.\n\n<b>𝒴</b> C.\n\n`😀` D.')).toEqual([
      'A.',
      'B 𝒳 text.',
      '<b>𝒴</b> C.',
      '`😀` D.',
    ]);
  });

  test('an unterminated comment hides the rest, and the ranges before it stay right', () => {
    expect(slices('Before.\n\n<!-- 😀 never closed\n\nAfter.')).toEqual(['Before.']);
  });

  test('ranges also hold with CRLF line endings', () => {
    const source = 'One.\r\n\r\n<!-- 😀 -->\r\n\r\nTwo.';
    const reading = speakableSegments(source);
    expect(reading.segments.map(s => s.text)).toEqual(['One.', 'Two.']);
    expect(source.slice(reading.segments[1]?.sourceRange.start, reading.segments[1]?.sourceRange.end)).toBe('Two.');
  });
});

describe('speakableSegments: identifiers in code spans are named, not read (finding 6)', () => {
  test('a commit hash in backticks is "a commit"', () => {
    expect(said('Fixed in `3f2a9c1b4d`.')).toEqual(['Fixed in a commit.']);
    expect(said('Fixed in `3f2a9c1b4d`.').join(' ')).not.toContain('3f2a');
  });

  test('a UUID or a long hash in backticks is "an ID", however long it is', () => {
    expect(said('Run `0a1b2c3d-1111-2222-3333-444455556666` now.')).toEqual(['Run an ID now.']);
    expect(said(`Hash \`${'a1'.repeat(30)}\` here.`)).toEqual(['Hash an ID here.']);
    expect(said(`Hash \`${'a1'.repeat(30)}\` and \`${'b2'.repeat(20)}\`.`)).toEqual(['Hash an ID and a commit.']);
  });

  test('an identifier inside a short word-like span is named too, and a path keeps its file name', () => {
    expect(said('Use `git show 3f2a9c1b4d`.')).toEqual(['Use git show a commit.']);
    expect(said('See `src/3f2a9c1b4d.ts`.')).toEqual(['See 3f2a9c1b4d.ts.']);
  });

  test('an upper-case hash and a number that merely looks like one', () => {
    expect(said('Fixed in `3F2A9C1B4D`.')).toEqual(['Fixed in a commit.']);
    expect(said('Count `1234567` and `deadbeef`.')).toEqual(['Count 1234567 and deadbeef.']);
  });

  test('a code span too long to be an identifier or a path is still a snippet', () => {
    expect(said(`Odd \`${'a1'.repeat(70)}\` span.`)).toEqual(['Odd a code snippet span.']);
  });
});
