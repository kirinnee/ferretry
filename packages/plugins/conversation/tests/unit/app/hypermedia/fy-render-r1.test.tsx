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
import { MESSAGE_LIMITS } from '../../../../app/hypermedia/limits.ts';
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
    const { doc } = readMessage(text, 'p-');
    expect(doc.problems.map(problem => problem.message).filter(message => /bytes|too big/iu.test(message))).toEqual([]);
  });
});
