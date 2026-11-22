/**
 * r12 H3 R4 — two things the third review round found.
 *
 * (A) A CLOSER THAT IS THE LAST LINE OF A MESSAGE STILL ARRIVING IS NOT YET A CLOSER. While a reply streams, its text can
 * end exactly on a line that is a closing delimiter (` ``` `, `~~~`, `> ``` `) before the rest of that line arrives
 * (` ```js `, ` ``` js `); CommonMark reads the bare line as the fence's end, so the prefix of the body would draw and a
 * partial `html` body would run for one token. While arriving, a fence closed only by the last line (nothing after it,
 * not even a newline) is OPEN: its tail is inert. A final message is read as it always was.
 *
 * (B) A BODY IS MATCHED EXACTLY. The code slot is handed only text, so it finds its fence's body by key; a key that
 * ignored ALL whitespace made two quoted blocks that differ only by whitespace both draw the second one, hiding the
 * first block's content. Each block draws its own.
 */
import { describe, expect, it } from 'bun:test';
import { draw, drawn, FENCE, installFyRenderDom, NOTHING, SQUARE } from './fy-render-draw.tsx';

installFyRenderDom();

const OPEN = `${FENCE}fy-render`;
const TILDES = '~'.repeat(3);
const PARTIAL_HTML = [OPEN, 'type: html', 'alt: An agenda', '---', '<p>A</p><script>1</script>'];
const PARTIAL_SVG = [OPEN, 'type: svg', 'alt: A square', '---', SQUARE];

describe('a closer on the last line of a message that is still arriving does not close its fence (R4 A)', () => {
  const SHAPES: readonly (readonly [string, (lines: readonly string[], closer: string) => string])[] = [
    ['top level', (lines, closer) => [...lines, closer].join('\n')],
    ['in a quote', (lines, closer) => [...lines, closer].map(line => `> ${line}`).join('\n')],
    [
      'in a list item',
      (lines, closer) => [`- ${lines[0]}`, ...[...lines.slice(1), closer].map(line => `  ${line}`)].join('\n'),
    ],
    ['indented three spaces', (lines, closer) => [...lines, closer].map(line => `   ${line}`).join('\n')],
  ];

  for (const [name, spell] of SHAPES) {
    it(`draws nothing at the instant the closer is the last line (${name}), then draws it once the line ends`, async () => {
      for (const [lines, kind] of [
        [PARTIAL_HTML, 'html'],
        [PARTIAL_SVG, 'svg'],
      ] as const) {
        const atCloser = spell(lines, FENCE);
        expect({ name, kind, ...(await drawn(atCloser, true)) }).toEqual({ name, kind, ...NOTHING });
        // The next token turns the line into content (` ```js `): still open, still inert.
        expect({ name, kind, ...(await drawn(`${atCloser}js`, true)) }).toEqual({ name, kind, ...NOTHING });
        // The line ends: it was a closer.
        const ended = await drawn(`${atCloser}\n`, true);
        expect({ name, kind, blocks: ended.blocks, errors: ended.errors }).toEqual({
          name,
          kind,
          blocks: 1,
          errors: 0,
        });
      }
    });

    it(`reads a FINAL message whose last line is the closer as it always was (${name})`, async () => {
      const final = await drawn(spell(PARTIAL_SVG, FENCE), false);
      expect({ name, blocks: final.blocks, images: final.images, errors: final.errors }).toEqual({
        name,
        blocks: 1,
        images: 1,
        errors: 0,
      });
      const html = await drawn(spell(PARTIAL_HTML, FENCE), false);
      expect({ name, frames: html.frames, blocks: html.blocks }).toEqual({ name, frames: 1, blocks: 1 });
    });
  }

  it('does the same for a fence of tildes', async () => {
    const lines = [`${TILDES}fy-render`, ...PARTIAL_HTML.slice(1)];
    expect(await drawn([...lines, TILDES].join('\n'), true)).toEqual(NOTHING);
    expect(await drawn([...lines, `${TILDES}sh`].join('\n'), true)).toEqual(NOTHING);
    expect(await drawn([...lines, TILDES].join('\n'), false)).toMatchObject({ frames: 1, blocks: 1 });
  });

  it('holds a closer-looking last line of ANY open fence, and every block closed before it still draws', async () => {
    const closed = [...PARTIAL_SVG, FENCE, ''];
    const text = [...closed, `${FENCE}js`, 'const x = 1;', FENCE].join('\n');
    expect(await drawn(text, true)).toMatchObject({ blocks: 1, images: 1, frames: 0, errors: 0 });
    expect(await drawn(closed.join('\n'), true)).toMatchObject({ blocks: 1, images: 1, errors: 0 });
    expect(await drawn([...PARTIAL_SVG, FENCE].join('\n'), true)).toEqual(NOTHING);
  });

  it('shows the arriving fence as code, with no error chrome', async () => {
    const { container, unmount } = await draw([...PARTIAL_HTML, FENCE].join('\n'), true, true);
    expect(container.textContent).toContain('<p>A</p><script>1</script>');
    expect(container.querySelector('.dh-error')).toBeNull();
    await unmount();
  });
});

describe('a body is matched exactly: two blocks that differ only by whitespace each show their own (R4 B)', () => {
  const svgWith = (alt: string, text: string): string[] => [
    OPEN,
    'type: svg',
    `alt: ${alt}`,
    '---',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>${text}</text></svg>`,
    FENCE,
  ];
  const seen = async (text: string) => {
    const { container, unmount } = await draw(text, true, false);
    const images = [...container.querySelectorAll('[data-fy-render-type="svg"] img')].map(img => ({
      alt: img.getAttribute('alt') ?? '',
      src: decodeURIComponent(img.getAttribute('src') ?? ''),
    }));
    await unmount();
    return images;
  };

  for (const [name, wrap] of [
    ['quoted', (line: string) => `> ${line}`],
    ['list item', (line: string, index: number) => (index === 0 ? `- ${line}` : `  ${line}`)],
  ] as const)
    it(`draws both ${name} blocks, each with its own text and its own alt`, async () => {
      const first = svgWith('first block', 'PAY 1 00').map(wrap);
      const second = svgWith('firstblock', 'PAY100').map(wrap);
      const images = await seen([...first, '', ...second].join('\n'));
      expect(images.length).toBe(2);
      expect(images[0]?.alt).toBe('first block');
      expect(images[0]?.src).toContain('PAY 1 00');
      expect(images[1]?.alt).toBe('firstblock');
      expect(images[1]?.src).toContain('PAY100');
    });

  it('draws two quoted blocks that are identical, each once', async () => {
    const one = svgWith('same', 'PAY100').map(line => `> ${line}`);
    expect((await seen([...one, '', ...one].join('\n'))).length).toBe(2);
  });
});

describe('the transcript passes "still arriving" only for the live session\'s last row (R4 A)', () => {
  const rowDraws = async (props: { readonly live: boolean; readonly isLast: boolean }): Promise<number> => {
    const { TranscriptRow } = await import('../../../../app/chat/transcript-row.tsx');
    const { ReferenceSurfaceProvider } = await import('@ferretry/app');
    const { interact, mount } = await import('@ferretry/app/testing');
    const { fixture, inShell } = await import('./surface-fixture.tsx');
    const { fyRenderFences } = await import('../../../../app/render/fences.tsx');
    const f = fixture();
    const mounted = await mount(
      inShell(
        <ReferenceSurfaceProvider surface={{ ...f.surface, fences: fyRenderFences({ cardEmbed: { daemon: 'd1' } }) }}>
          <TranscriptRow
            entry={{ id: 'a1', kind: 'assistant', text: [...PARTIAL_HTML, FENCE].join('\n') }}
            isLast={props.isLast}
            live={props.live}
          />
        </ReferenceSurfaceProvider>,
      ) as never,
    );
    await interact(() => Promise.resolve());
    const frames = mounted.container.querySelectorAll('iframe').length;
    await mounted.unmount();
    return frames;
  };

  it('holds the closer back on a live last row, and draws it on any other row', async () => {
    expect(await rowDraws({ live: true, isLast: true })).toBe(0);
    expect(await rowDraws({ live: false, isLast: true })).toBe(1);
    expect(await rowDraws({ live: true, isLast: false })).toBe(1);
  });
});
