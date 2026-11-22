/**
 * r12 H11a — THE PRE-PARSE LIMITS. A message over a per-paragraph or per-line limit is not handed to the parser: it is shown
 * as plain text with a one-line note. Every test builds its message from COUNTS of neutral filler, at each limit and one
 * past it. The speed claim (one linear pass over a 300 KB message in about 20 ms) is the last test.
 */
import { describe, expect, it } from 'bun:test';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, mount } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import { HypermediaProse } from '../../../../app/hypermedia/hypermedia-prose.tsx';
import { exceedsPreParseLimits, PRE_PARSE_LIMITS } from '../../../../app/hypermedia/limits.ts';
import { readMessage } from '../../../../app/hypermedia/parse-message.ts';
import { PLAIN_TEXT_NOTE } from '../../../../app/hypermedia/plain-fallback.tsx';
import { fixture, inShell } from './surface-fixture.tsx';

const { linkOpeners, emphasisRuns, longLine, spaceRun } = PRE_PARSE_LIMITS;
const times = (unit: string, count: number): string => unit.repeat(count);
const FENCE = '`'.repeat(3);

describe('the limits are the ones the brief names', () => {
  it('are 50 link openers, 50 emphasis runs, a 2,000-character line with a run of 64', () => {
    expect(PRE_PARSE_LIMITS).toEqual({ linkOpeners: 50, emphasisRuns: 50, longLine: 2_000, spaceRun: 64 });
  });
});

describe('link openers, per paragraph', () => {
  it('passes 50 links, shows 51 as plain text', () => {
    expect(exceedsPreParseLimits(times('[a](b) ', linkOpeners))).toBe(false);
    expect(exceedsPreParseLimits(times('[a](b) ', linkOpeners + 1))).toBe(true);
  });

  it('counts the brackets and the destinations separately: 51 of either is over', () => {
    expect(exceedsPreParseLimits(times('[', linkOpeners))).toBe(false);
    expect(exceedsPreParseLimits(times('[', linkOpeners + 1))).toBe(true);
    expect(exceedsPreParseLimits(times('](', linkOpeners))).toBe(false);
    expect(exceedsPreParseLimits(times('](', linkOpeners + 1))).toBe(true);
    // A `]` with no `(` after it is not a destination, at the end of the text or before anything else.
    expect(exceedsPreParseLimits(times(']', 200))).toBe(false);
    expect(exceedsPreParseLimits(`${times(']x', 200)}]`)).toBe(false);
  });

  it('counts a paragraph, not the message: the same count over blank-line-separated paragraphs passes', () => {
    const paragraph = times('[a](b) ', linkOpeners);
    expect(exceedsPreParseLimits(Array.from({ length: 20 }, () => paragraph).join('\n\n'))).toBe(false);
    expect(exceedsPreParseLimits(Array.from({ length: 20 }, () => paragraph).join('\n'))).toBe(true);
    // A line of only spaces and tabs is blank.
    expect(exceedsPreParseLimits([paragraph, ' \t ', paragraph].join('\n'))).toBe(false);
  });

  it('reads CRLF as one line end and CR as a line end: a pair is not a blank line', () => {
    const half = times('[a] ', linkOpeners / 2 + 1);
    expect(exceedsPreParseLimits([half, half].join('\r\n'))).toBe(true);
    expect(exceedsPreParseLimits([half, half].join('\r'))).toBe(true);
    expect(exceedsPreParseLimits([half, half].join('\r\n\r\n'))).toBe(false);
    expect(exceedsPreParseLimits([half, half].join('\r\r'))).toBe(false);
  });
});

describe('emphasis marks, per paragraph', () => {
  it('passes 50 runs, shows 51 as plain text, for either mark', () => {
    for (const mark of ['*', '_']) {
      expect(exceedsPreParseLimits(times(`${mark} a `, emphasisRuns))).toBe(false);
      expect(exceedsPreParseLimits(times(`${mark} a `, emphasisRuns + 1))).toBe(true);
    }
  });

  it('counts a run once, whatever its length, and each change of mark as a new run', () => {
    expect(exceedsPreParseLimits(times('*', 5_000))).toBe(false);
    expect(exceedsPreParseLimits(times('**a ', emphasisRuns))).toBe(false);
    expect(exceedsPreParseLimits(times('*_', emphasisRuns / 2))).toBe(false);
    expect(exceedsPreParseLimits(times('*_', emphasisRuns / 2 + 1))).toBe(true);
  });

  it('does not carry a run over a line end', () => {
    expect(exceedsPreParseLimits(times('*\n', emphasisRuns + 1))).toBe(true);
    expect(exceedsPreParseLimits(times('*\n\n', emphasisRuns + 1))).toBe(false);
  });
});

describe('a long line with a long run of spaces', () => {
  const filler = (length: number): string => times('x', length);

  it('is over only when BOTH hold: more than 2,000 characters and a run of 64 spaces', () => {
    const gap = times(' ', spaceRun);
    const long = (length: number): string => `${filler(length - spaceRun - 2)}${gap}${filler(2)}`;
    expect(long(longLine + 1).length).toBe(longLine + 1);
    expect(exceedsPreParseLimits(long(longLine + 1))).toBe(true);
    expect(exceedsPreParseLimits(long(longLine))).toBe(false);
    expect(exceedsPreParseLimits(`${filler(longLine + 500)}${times(' ', spaceRun - 1)}x`)).toBe(false);
    expect(exceedsPreParseLimits(filler(10 * longLine))).toBe(false);
    expect(exceedsPreParseLimits(`a${gap}b`)).toBe(false);
  });

  it('counts tabs in the run, and reads the run at the end of the line and of the text', () => {
    expect(exceedsPreParseLimits(`${filler(longLine)}${times('\t', spaceRun)}\nx`)).toBe(true);
    expect(exceedsPreParseLimits(`${filler(longLine)}${times(' ', spaceRun)}`)).toBe(true);
    expect(exceedsPreParseLimits(`${filler(longLine)}${times(' \t', spaceRun / 2)}x`)).toBe(true);
  });

  it('is a per-line rule: short lines with the run, and a long line with none, in one message, pass', () => {
    const gap = times(' ', spaceRun);
    const text = [`a${gap}b`, filler(longLine + 100), `c${gap}d`].join('\n');
    expect(exceedsPreParseLimits(text)).toBe(false);
    // The run is the line's: a run on the line before does not carry over.
    expect(exceedsPreParseLimits([`a${gap}`, filler(longLine + 1)].join('\n'))).toBe(false);
  });
});

describe('a normal message passes', () => {
  it('passes the empty message and plain prose', () => {
    expect(exceedsPreParseLimits('')).toBe(false);
    expect(exceedsPreParseLimits('Hello there.')).toBe(false);
  });

  it('passes a rich message: headings, a list, links, emphasis, a table, a code block, a log', () => {
    const table = ['| a | b |', '| - | - |', ...Array.from({ length: 20 }, (_, n) => `| row ${n} | [x](y) |`)].join(
      '\n',
    );
    const code = [`${FENCE}ts`, ...Array.from({ length: 30 }, (_, n) => `const v${n} = list[${n}];`), FENCE].join('\n');
    const log = Array.from({ length: 20 }, (_, n) => `[12:00:${n}] [INFO] step ${n} done`).join('\n');
    const text = [
      '# Title',
      'A **bold** and an *italic* word, a [link](https://example.com) and `code`.',
      '- one\n- two\n- three',
      table,
      code,
      log,
    ].join('\n\n');
    expect(exceedsPreParseLimits(text)).toBe(false);
    expect(readMessage(text, 'p-')).not.toBeNull();
  });
});

describe('what the reader gets', () => {
  const draw = async (text: string) => {
    const tree = inShell(
      <ReferenceSurfaceProvider surface={fixture().surface}>
        <HypermediaProse text={text} />
      </ReferenceSurfaceProvider>,
    ) as ReactNode;
    const mounted = await mount(tree as never);
    await interact(() => Promise.resolve());
    return mounted;
  };

  it('readMessage answers null over a limit and a document at it', () => {
    expect(readMessage(times('[a](b) ', linkOpeners + 1), 'p-')).toBeNull();
    expect(readMessage(times('[a](b) ', linkOpeners), 'p-')).not.toBeNull();
  });

  it('shows the whole message as text, with the note, and nothing drawn', async () => {
    const text = `# Not a heading\n\n${times('[a](b) ', linkOpeners + 1)}`;
    const { container, unmount } = await draw(text);
    expect(container.querySelector('pre.fy-hm-plain')?.textContent).toBe(text);
    expect(container.querySelector('[data-fy-plain-note]')?.textContent).toBe(PLAIN_TEXT_NOTE);
    expect(PLAIN_TEXT_NOTE).toBe('shown as plain text');
    expect(container.querySelector('.dh-doc, a, h1')).toBeNull();
    await unmount();
  });

  it('shows markup as text, never as HTML', async () => {
    const text = `<b id="x">${times('*a ', emphasisRuns + 1)}</b>`;
    const { container, unmount } = await draw(text);
    expect(container.querySelector('pre.fy-hm-plain')?.textContent).toBe(text);
    expect(container.querySelector('b, [id="x"]')).toBeNull();
    await unmount();
  });

  it('draws a message under the limits as before, with no note', async () => {
    const { container, unmount } = await draw(times('[a](b) ', linkOpeners));
    expect(container.querySelector('.dh-doc')).not.toBeNull();
    expect(container.querySelector('[data-fy-plain-note]')).toBeNull();
    await unmount();
  });

  it('shows a message over the size cap as text WITHOUT the note, as before', async () => {
    const { container, unmount } = await draw(`${times('a', 300_001)}`);
    expect(container.querySelector('pre.fy-hm-plain')).not.toBeNull();
    expect(container.querySelector('[data-fy-plain-note]')).toBeNull();
    await unmount();
  });
});

// The speed half (a 300 KB message checked in under 20 ms) is `tests/perf/app/hypermedia/pre-parse-limits.test.ts`.
