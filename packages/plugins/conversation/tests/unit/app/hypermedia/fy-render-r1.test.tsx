/**
 * R1 follow-ups of the `fy-render` host (L147, L148, and the 2312 H4 cap finding).
 *
 * (L147) THE "STILL ARRIVING" FLAG FOLLOWS THE LAST ASSISTANT ITEM, NOT THE LAST ROW. A message queued by the owner while
 * a reply streams lands AFTER the assistant row; the flag used to read "is this the last row", so it went false and the
 * one-token partial-draw window (a closer that is the last line of the text) reopened.
 *
 * (L148) TWO QUOTED BLOCKS WHOSE BODIES DIFFER ONLY BY THEIR PAYLOAD'S INDENTATION BOTH DRAW, each its own.
 *
 * (H4) THE SIZE CAP IS ABOUT THE TEXT THE READER WAS GIVEN. Holding a chart or a code walk renames its opener (a few bytes
 * longer), and Durian counts the renamed text: a message at the cap with chart fences in it must never be answered with
 * Durian's own "the page is too big" error, which hides the message (`limits.ts`).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import { readMessage } from '../../../../app/hypermedia/parse-message.ts';
import {
  exceedsMessageCap,
  exceedsParserBudget,
  MESSAGE_LIMITS,
  PARSER_LIMITS,
} from '../../../../app/hypermedia/limits.ts';
import { mustRead } from './must-read.ts';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, type Mounted, mount } from '@ferretry/app/testing';
import { fyRenderFences } from '../../../../app/render/fences.tsx';
import { draw, FENCE, installFyRenderDom } from './fy-render-draw.tsx';
import { fixture, inShell } from './surface-fixture.tsx';

installFyRenderDom();

const OPEN = `${FENCE}fy-render`;

describe('a queued owner message keeps the last assistant item arriving (L147)', () => {
  const PARTIAL_HTML = [OPEN, 'type: html', 'alt: An agenda', '---', '<p>A</p><script>1</script>', FENCE].join('\n');
  let mounted: Mounted | null = null;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
  });

  const framesOf = async (rows: readonly { id: string; kind: 'assistant' | 'user'; text: string }[], busy: boolean) => {
    const f = fixture();
    mounted = await mount(
      inShell(
        <ReferenceSurfaceProvider surface={{ ...f.surface, fences: fyRenderFences({ cardEmbed: { daemon: 'd1' } }) }}>
          <Transcript busy={busy} daemonId="d" entries={rows} sessionId="s" />
        </ReferenceSurfaceProvider>,
      ) as never,
    );
    await interact(() => Promise.resolve());
    return mounted.container.querySelectorAll('iframe').length;
  };

  const assistant = { id: 'a1', kind: 'assistant', text: PARTIAL_HTML } as const;
  const queued = { id: 'u1', kind: 'user', text: 'one more thing' } as const;

  it('holds the closer back when an owner message is queued after the streaming reply', async () => {
    expect(await framesOf([assistant, queued], true)).toBe(0);
  });

  it('holds it back with no queued message (the case that always worked)', async () => {
    expect(await framesOf([assistant], true)).toBe(0);
  });

  it('draws it once the session is no longer live', async () => {
    expect(await framesOf([assistant, queued], false)).toBe(1);
  });

  it('draws an assistant row that is not the last assistant item, even while live', async () => {
    const later = { id: 'a2', kind: 'assistant', text: 'done' } as const;
    expect(await framesOf([assistant, queued, later], true)).toBe(1);
  });
});

describe('two quoted blocks that differ only by payload indentation each draw their own (L148)', () => {
  const svgBody = (indent: string): string[] => [
    OPEN,
    'type: svg',
    'alt: Same alt',
    '---',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
    `${indent}<text>PAY100</text>`,
    '</svg>',
    FENCE,
  ];

  const seen = async (text: string) => {
    const { container, unmount } = await draw(text, true, false);
    const sources = [...container.querySelectorAll('[data-fy-render-type="svg"] img')].map(img =>
      decodeURIComponent(img.getAttribute('src') ?? ''),
    );
    await unmount();
    return sources;
  };

  for (const [name, wrap] of [
    ['quoted', (line: string) => `> ${line}`],
    ['list item', (line: string, index: number) => (index === 0 ? `- ${line}` : `  ${line}`)],
  ] as const)
    it(`draws both ${name} blocks, in the order they were written`, async () => {
      const plain = svgBody('').map(wrap);
      const indented = svgBody('    ').map(wrap);
      const sources = await seen([...plain, '', ...indented].join('\n'));
      expect(sources.length).toBe(2);
      expect(sources[0]).toContain('\n<text>PAY100');
      expect(sources[1]).toContain('\n    <text>PAY100');
    });

  // A quoted list: Marked expands the TAB inside the first block to spaces, so its slot text IS the space-indented twin's.
  // Neither slot can be told from the other by its text, so neither may draw a body (never one body twice, never one under
  // the other's fence): an ambiguous slot stays code.
  const quotedList = (line: string, index: number): string => (index === 0 ? `> - ${line}` : `>   ${line}`);

  for (const [first, second] of [
    ['\t', '    '],
    ['    ', '\t'],
  ] as const)
    it(`never draws one body twice when a tab-indented block and its space-indented twin share a quoted list (${JSON.stringify(first)} then ${JSON.stringify(second)})`, async () => {
      const text = [...svgBody(first).map(quotedList), '', ...svgBody(second).map(quotedList)].join('\n');
      const sources = await seen(text);
      expect(new Set(sources).size).toBe(sources.length);
    });

  it('still draws a tab-indented block that has no twin, in a quoted list and in a quote', async () => {
    for (const wrap of [quotedList, (line: string) => `> ${line}`])
      expect((await seen(svgBody('\t').map(wrap).join('\n'))).length).toBe(1);
  });

  it('in a quote, where the tab is kept, draws the block whose text only it spells and keeps the one it cannot tell as code', async () => {
    const quote = (line: string): string => `> ${line}`;
    const sources = await seen([...svgBody('\t').map(quote), '', ...svgBody('    ').map(quote)].join('\n'));
    // The tab-indented block's text is its own alone. The space-indented text could be either body's spelling (a renderer
    // that expands tabs would spell the first as it), so that slot is ambiguous: code, never the first body a second time.
    expect(sources.length).toBe(1);
    expect(sources[0]).toContain('\n\t<text>PAY100');
  });
});

describe('the size cap is checked on the text the reader parses (2312 H4)', () => {
  const chart = `${FENCE}chart\nkind: bar\n${FENCE}\n`;
  const bytes = (text: string): number => new TextEncoder().encode(text).length;
  const padded = (target: number): string => {
    const fences = `${chart}\n${chart}\n`;
    return `${fences}${'a'.repeat(target - bytes(fences))}`;
  };

  it('a message at the cap that holds two chart fences is read, not answered with Durian’s too-big error', () => {
    const text = padded(MESSAGE_LIMITS.maxInputBytes - 2);
    expect(bytes(text)).toBe(MESSAGE_LIMITS.maxInputBytes - 2);
    const { doc } = mustRead(text, 'p-');
    expect(doc.problems.map(problem => problem.message).filter(message => /bytes|too big/iu.test(message))).toEqual([]);
  });

  // UTF-8, not UTF-16: normalising a CRLF takes a character AND a byte away, a held fence's opener adds characters, and a
  // NUL becomes U+FFFD, the same one UTF-16 unit and two bytes more. Nine CRLFs against the nine characters of a held
  // fence's added word leave the length EQUAL while the bytes grew by the NUL's two: 299,999 bytes written, 300,001 given.
  it('a 299,999-byte message whose normalised text is 300,001 bytes at the SAME length is read, not answered with the too-big error', () => {
    const head = ['> ```fy-render', '> x', '', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\r\n');
    const text = `${head}\n${'a'.repeat(MESSAGE_LIMITS.maxInputBytes - 1 - bytes(head) - 2)}\u{0}`;
    expect(bytes(text)).toBe(MESSAGE_LIMITS.maxInputBytes - 1);
    const read = mustRead(text, 'p-');
    expect(read.doc.problems.map(problem => problem.message)).toEqual([]);
    expect(read.doc.blocks.length).toBeGreaterThan(0);
  });

  it('a message over the cap in UTF-8 but not in UTF-16 is shown as text (null), never read', () => {
    const text = '€'.repeat(100_001);
    expect(text.length).toBeLessThan(MESSAGE_LIMITS.maxInputBytes);
    expect(bytes(text)).toBeGreaterThan(MESSAGE_LIMITS.maxInputBytes);
    expect(readMessage(text, 'p-')).toBeNull();
    expect(exceedsMessageCap(text)).toBe(true);
  });

  it('the parser has a fixed budget above any reading of a message under the cap, counted in UTF-8', () => {
    // The worst growth of a message at the cap is three times (every byte a NUL, U+FFFD is three bytes).
    expect(PARSER_LIMITS.maxInputBytes).toBeGreaterThan(MESSAGE_LIMITS.maxInputBytes * 3);
    expect(exceedsParserBudget('a'.repeat(PARSER_LIMITS.maxInputBytes))).toBe(false);
    expect(exceedsParserBudget('a'.repeat(PARSER_LIMITS.maxInputBytes + 1))).toBe(true);
    // Fewer characters than the budget, more bytes than it.
    const wide = '€'.repeat(Math.ceil(PARSER_LIMITS.maxInputBytes / 3) + 1);
    expect(wide.length).toBeLessThan(PARSER_LIMITS.maxInputBytes);
    expect(exceedsParserBudget(wide)).toBe(true);
  });
});
