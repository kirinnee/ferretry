/**
 * r12 H3 R3 — the fence table CommonMark makes of a message, and the one decision made from it before Durian reads it.
 * Pure functions of text: no DOM. The drawn consequences are `fy-render-fence-decisions.test.tsx`'s.
 */
import { describe, expect, it } from 'bun:test';
import { commonMarkFences, normalizeText, settleFences } from '../../../../app/hypermedia/fence-boundaries.ts';

/** Built from a backtick run on purpose (`no-fy-render-in-docs.sh` fails on the literal opener in a tracked file). */
const F = '`'.repeat(3);
const lines = (...parts: readonly string[]): string => parts.join('\n');

describe('the fence table is what CommonMark reads', () => {
  it('finds an opener, its closer and its body', () => {
    expect(commonMarkFences(lines(`${F}fy-render`, 'a', 'b', F))).toEqual([
      { open: 0, close: 3, info: 'fy-render', meta: '', body: 'a\nb', atTail: true, lead: '' },
    ]);
  });

  it('separates the info word from what follows it', () => {
    const [fence] = commonMarkFences(lines(`${F}fy-render notes`, 'a', F));
    expect({ info: fence?.info, meta: fence?.meta }).toEqual({ info: 'fy-render', meta: 'notes' });
  });

  it('gives a fence that nothing closed no closer, and says it is open at the tail', () => {
    const [fence] = commonMarkFences(lines(`${F}js`, 'a'));
    expect({ close: fence?.close, atTail: fence?.atTail }).toEqual({ close: null, atTail: true });
  });

  it('does not take a closer indented four spaces or a tab (it is content)', () => {
    for (const closer of [`    ${F}`, `\t${F}`])
      expect(commonMarkFences(lines(`${F}js`, 'a', closer))[0]?.close).toBeNull();
  });

  it('takes a closer indented up to three spaces', () => {
    for (const closer of [F, ` ${F}`, `   ${F}`])
      expect(commonMarkFences(lines(`${F}js`, 'a', closer))[0]?.close).toBe(2);
  });

  it('reads a fence in a quote and in a list item, with their markers removed from its body', () => {
    expect(commonMarkFences(lines(`> ${F}js`, '> a', `> ${F}`))[0]).toMatchObject({ open: 0, close: 2, body: 'a' });
    expect(commonMarkFences(lines(`- ${F}js`, '  a', `  ${F}`))[0]).toMatchObject({ open: 0, close: 2, body: 'a' });
  });

  it('reads a fence behind a list marker and a TAB', () => {
    for (const lead of ['-', '*', '+', '1.', '1)'])
      expect(commonMarkFences(lines(`${lead}\t${F}js`, '    a', `    ${F}`))[0]).toMatchObject({
        open: 0,
        close: 2,
        body: 'a',
      });
  });

  it('says a fence a quote ended is not open at the tail when text follows it', () => {
    const [fence] = commonMarkFences(lines(`> ${F}js`, '> a', '', 'afterwards'));
    expect({ close: fence?.close, atTail: fence?.atTail }).toEqual({ close: null, atTail: false });
  });

  it('numbers lines the same for LF, CRLF and a lone CR once the text is normalised', () => {
    const text = lines(`${F}js`, 'a', F);
    for (const spelled of [text, text.replace(/\n/gu, '\r\n'), text.replace(/\n/gu, '\r')])
      expect(commonMarkFences(normalizeText(spelled))[0]).toMatchObject({ open: 0, close: 2 });
  });

  it('reads no fence in indented code or in a raw HTML block', () => {
    expect(commonMarkFences(`    ${F}js\n    a\n    ${F}`)).toEqual([]);
    expect(commonMarkFences(lines('<pre>', `${F}js`, 'a', F, '</pre>'))).toEqual([]);
  });
});

describe('the message Durian is given', () => {
  it('is the message itself when every fence is closed and Durian agrees', () => {
    const text = lines('Hello', '', `${F}js`, 'a', F, '', `> ${F}js`, '> b', `> ${F}`);
    expect(settleFences(text).text).toBe(text);
  });

  it('reads an open fence as code from its opener to the end, and keeps the text before it', () => {
    const text = lines('Hello', '', `${F}js`, 'a', '', `> ${F}fy-render`, '> x');
    const settled = settleFences(text).text.split('\n');
    expect(settled.slice(0, 2)).toEqual(['Hello', '']);
    expect(settled[2]).toMatch(/^`{4,}$/u);
    expect(settled.slice(3, 8)).toEqual([`${F}js`, 'a', '', `> ${F}fy-render`, '> x']);
    expect(settled.at(-1)).toBe(settled[2]);
  });

  it('makes the bare fence longer than any run in the tail, so nothing in the tail can end it', () => {
    const settled = settleFences(lines(`${F}js`, '````````` text', 'x')).text.split('\n');
    expect(settled[0]?.length).toBe(10);
  });

  it('reads the rest as code from a fence Durian ends where CommonMark does not', () => {
    const text = lines(`${F}js`, 'a', `    ${F}`, 'b', F, '', 'after');
    expect(settleFences(text).text.split('\n')[0]).toMatch(/^`{4,}$/u);
  });

  it('holds a quote fence that its quote ended without a closer when text follows, and keeps what follows', () => {
    const settled = settleFences(lines(`> ${F}fy-render`, '> x', '', 'afterwards'));
    expect(settled.text.split('\n')).toEqual([`> ${F}fy-render unclosed`, '> x', '', 'afterwards']);
    expect(settled.fences[0]?.meta).toBe('unclosed');
  });

  it('moves a list fence that opens on its marker line to the line under it, and keeps it closed', () => {
    const settled = settleFences(lines(`- ${F}fy-render`, '  a', `  ${F}`));
    expect(settled.text.split('\n')).toEqual(['-', `  ${F}fy-render`, '  a', `  ${F}`]);
    expect(settled.fences[0]).toMatchObject({ open: 1, close: 3, info: 'fy-render', meta: '' });
  });
});
