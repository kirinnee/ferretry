/**
 * r12 H3 R3 — EVERY FENCE'S BOUNDARIES ARE DECIDED ONCE, BY COMMONMARK, BEFORE DURIAN SPLITS THE MESSAGE.
 *
 * The cases are the ones the reviews found while the boundaries were mirrored with regular expressions: a list marker
 * followed by a TAB, a closer indented four columns, an opener CommonMark does not take, a fence in a container no
 * pattern had met, and CR / CRLF line endings. Each draws the REAL `HypermediaProse`, so a pass means the page showed
 * nothing runnable, not that a helper said so. Rules proved here:
 *  - while ANY fence (any info string) is still open at the tail, nothing from its opener on draws, a complete block
 *    inside it included;
 *  - a `fy-render` fence draws only when CommonMark found it opened as exactly that AND closed by a real delimiter.
 */
import { describe, expect, it } from 'bun:test';
import { drawn, FENCE, installFyRenderDom, NOTHING, SQUARE } from './fy-render-draw.tsx';

installFyRenderDom();

const OPEN = `${FENCE}fy-render`;
const PARTIAL_HTML = [OPEN, 'type: html', 'alt: An agenda', '---', '<p>partial</p><script>1</script>'];
const PARTIAL_SVG = [OPEN, 'type: svg', 'alt: A square', '---', SQUARE];
const COMPLETE_HTML = [...PARTIAL_HTML, FENCE];
const COMPLETE_SVG = [...PARTIAL_SVG, FENCE];

/**
 * The lines of a fence behind `lead` on its first line, and after it behind the same width of blanks, a quote marker kept
 * and a tab spelled as the spaces it stands for: the indent that keeps a line inside the list item the lead opens.
 */
const behind = (lead: string, lines: readonly string[]): string[] => {
  let column = 0;
  let rest = '';
  for (const ch of lead.replace(/[-*+]|\d+[.)]/gu, marker => ' '.repeat(marker.length))) {
    const width = ch === '\t' ? 4 - (column % 4) : 1;
    rest += ch === '>' ? ch : ' '.repeat(width);
    column += width;
  }
  return lines.map((line, index) => `${index === 0 ? lead : rest}${line}`);
};

/** The same text with every newline spelled as CRLF, or as a lone CR. */
const crlf = (text: string): string => text.replace(/\n/gu, '\r\n');
const cr = (text: string): string => text.replace(/\n/gu, '\r');

describe('a list marker followed by a TAB holds a fence with no closer, whatever the marker', () => {
  const LEADS = ['-\t', '*\t', '+\t', '1.\t', '1)\t', ' -\t', '> -\t', '> 1.\t', '>\t-\t', '- -\t'] as const;
  for (const lead of LEADS)
    it(`draws nothing for ${JSON.stringify(lead)} before a fy-render opener with no closer`, async () => {
      expect({ lead, ...(await drawn(behind(lead, PARTIAL_HTML).join('\n'))) }).toEqual({ lead, ...NOTHING });
      expect({ lead, ...(await drawn(behind(lead, PARTIAL_SVG).join('\n'))) }).toEqual({ lead, ...NOTHING });
    });

  for (const lead of LEADS.filter(lead => !lead.includes('>')))
    it(`draws the block of ${JSON.stringify(lead)} once its closer arrives`, async () => {
      const result = await drawn(behind(lead, COMPLETE_SVG).join('\n'));
      expect({ lead, blocks: result.blocks, images: result.images, errors: result.errors }).toEqual({
        lead,
        blocks: 1,
        images: 1,
        errors: 0,
      });
    });

  // A quote around a tab-indented item is read by Durian's Markdown renderer in a way CommonMark does not (it keeps the
  // closing line as code), so the text it hands the code slot matches no CommonMark fence: the block stays CODE, the
  // safe direction. It is never an error and never a frame.
  for (const lead of LEADS.filter(lead => lead.includes('>')))
    it(`never draws more than the block of ${JSON.stringify(lead)} once its closer arrives, and never errors`, async () => {
      const result = await drawn(behind(lead, COMPLETE_SVG).join('\n'));
      expect({ lead, errors: result.errors, frames: result.frames }).toEqual({ lead, errors: 0, frames: 0 });
      expect(result.blocks).toBeLessThanOrEqual(1);
    });
});

describe('while any fence is still open, nothing from its opener on draws (gpt R2 clem)', () => {
  const QUOTED_HTML = COMPLETE_HTML.map(line => `> ${line}`);

  it('draws nothing of a complete quoted block after an open fence that a four-space line did not close', async () => {
    const text = [...PARTIAL_HTML, `    ${FENCE}`, '', ...QUOTED_HTML].join('\n');
    expect(await drawn(text)).toEqual(NOTHING);
  });

  it('does the same for a tab-indented line, and for an open fence of tildes', async () => {
    expect(await drawn([...PARTIAL_HTML, `\t${FENCE}`, '', ...QUOTED_HTML].join('\n'))).toEqual(NOTHING);
    const tildes = ['~~~fy-render', 'type: html', 'alt: x', '---', '<p>x</p>', `    ~~~`, '', ...QUOTED_HTML];
    expect(await drawn(tildes.join('\n'))).toEqual(NOTHING);
  });

  it('holds every later block when the open fence has ANY other info string', async () => {
    for (const info of ['js', 'ts title="a"', 'text', '']) {
      // The quoted lines cannot close the fence (a closing fence is not behind a quote marker), so a complete block
      // inside it is its content and the fence is open at the tail.
      const text = [`${FENCE}${info}`, 'const x = 1;', '', ...COMPLETE_SVG.map(line => `> ${line}`)].join('\n');
      expect({ info, ...(await drawn(text)) }).toEqual({ info, ...NOTHING });
    }
  });

  it('holds a complete block that sits inside an open fence of another language', async () => {
    const text = [`${FENCE}markdown`, 'Here is how to write one:', '', ...COMPLETE_SVG.map(line => `> ${line}`)].join(
      '\n',
    );
    expect(await drawn(text)).toEqual(NOTHING);
  });

  it('draws a block closed before the open fence, and nothing from the open fence on', async () => {
    const text = [...COMPLETE_SVG, '', ...PARTIAL_HTML].join('\n');
    expect(await drawn(text)).toMatchObject({ blocks: 1, images: 1, frames: 0, errors: 0 });
  });
});

describe('Durian and CommonMark are never left to disagree about where a fence ends', () => {
  const closedBy = (closer: string): string[] => [`${FENCE}js`, 'const x = 1;', closer, '', ...COMPLETE_HTML];

  it('draws nothing from a js fence whose only "closer" before a complete block is indented four columns', async () => {
    // Durian ends the js fence at the indented line and then reads the block after it; CommonMark keeps it all as code.
    for (const closer of [`    ${FENCE}`, `\t${FENCE}`, `        ${FENCE}`])
      expect({ closer, ...(await drawn(closedBy(closer).join('\n'))) }).toEqual({ closer, ...NOTHING });
  });

  it('draws nothing when the "closer" is prefixed with a no-break space, which only Durian trims', async () => {
    expect(await drawn(closedBy(` ${FENCE}`).join('\n'))).toEqual(NOTHING);
  });

  it('draws nothing for a block whose own closer is indented four columns, a tab or a no-break space', async () => {
    for (const closer of [`    ${FENCE}`, `\t${FENCE}`, ` ${FENCE}`])
      expect({ closer, ...(await drawn([...PARTIAL_SVG, closer].join('\n'))) }).toEqual({ closer, ...NOTHING });
  });

  it('draws nothing for a fy-render opener that is indented code, a quote line or a paragraph continuation to CommonMark', async () => {
    expect(await drawn(COMPLETE_SVG.map(line => `    ${line}`).join('\n'))).toEqual(NOTHING);
    expect(await drawn(['<div>', ...COMPLETE_SVG, '</div>'].join('\n'))).toMatchObject({ blocks: 0, images: 0 });
  });

  it('still draws an ordinary message with every fence closed, before and after a code fence', async () => {
    const text = [...COMPLETE_SVG, '', `${FENCE}js`, 'const x = 1;', FENCE, '', ...COMPLETE_SVG].join('\n');
    expect(await drawn(text)).toMatchObject({ blocks: 2, images: 2, errors: 0 });
  });
});

describe('every line ending reads the same', () => {
  const texts: readonly (readonly [string, string])[] = [
    ['an open block', PARTIAL_HTML.join('\n')],
    ['an open block in a quote', PARTIAL_HTML.map(line => `> ${line}`).join('\n')],
    ['an open block behind a list marker and a tab', behind('-\t', PARTIAL_HTML).join('\n')],
    ['an open block after a four-space line', [...PARTIAL_HTML, `    ${FENCE}`, ...COMPLETE_HTML].join('\n')],
  ];
  for (const [name, text] of texts)
    it(`draws nothing for ${name}, with LF, CRLF or lone CR`, async () => {
      for (const spelled of [text, crlf(text), cr(text)])
        expect({ name, ...(await drawn(spelled)) }).toEqual({ name, ...NOTHING });
    });

  it('draws a complete block with LF, CRLF or lone CR, and a complete quoted block too', async () => {
    for (const text of [COMPLETE_SVG.join('\n'), COMPLETE_SVG.map(line => `> ${line}`).join('\n')])
      for (const spelled of [text, crlf(text), cr(text)])
        expect(await drawn(spelled)).toMatchObject({ blocks: 1, images: 1, errors: 0 });
  });
});

describe('nested containers', () => {
  it('holds an open fence three containers deep, and draws it closed', async () => {
    const lead = '> - > ';
    expect(await drawn(behind(lead, PARTIAL_SVG).join('\n'))).toEqual(NOTHING);
    expect(await drawn(behind(lead, COMPLETE_SVG).join('\n'))).toMatchObject({ blocks: 1, images: 1 });
  });

  it('holds an open fence in a quote inside a list item, whose closer is outside the quote', async () => {
    const text = ['- item', '', ...PARTIAL_SVG.map(line => `  > ${line}`), `  ${FENCE}`].join('\n');
    expect(await drawn(text)).toEqual(NOTHING);
  });

  it('holds an open quote fence followed by text, and still shows the text', async () => {
    const text = [...PARTIAL_SVG.map(line => `> ${line}`), '', 'afterwards, in prose'].join('\n');
    expect(await drawn(text)).toEqual(NOTHING);
  });
});
