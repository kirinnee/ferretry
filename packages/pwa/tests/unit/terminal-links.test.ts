/**
 * Which terminal text is a link, where it is on screen, and what may be opened. The buffer is a
 * structural fake with xterm's shape (wrapped continuations, two-cell characters), so none of this needs
 * an emulator; the pane that registers these is `session-terminal-deck-links.test.tsx`.
 */
import { describe, expect, it } from 'bun:test';
import {
  decideHyperlink,
  describeHyperlinkMismatch,
  findUrlSpans,
  type LinkClick,
  linksOnRow,
  splitLinkedRuns,
  terminalHref,
  terminalHyperlinkHandler,
  terminalLinkProvider,
  textInRange,
} from '../../src/lib/terminal-links.ts';
import { type BufferRow, terminalBuffer } from '../support/terminal-buffer.ts';

/** Lays text out across rows of `columns` cells, the way a terminal wraps a long line. */
const wrap = (text: string, columns: number): BufferRow[] => {
  const rows: BufferRow[] = [];
  for (let at = 0; at < text.length; at += columns) {
    const chunk = text.slice(at, at + columns);
    rows.push(at === 0 ? chunk : { text: chunk, wrapped: true });
  }
  return rows;
};

const hrefs = (text: string): string[] => findUrlSpans(text).map(span => span.href);
const shown = (text: string): string[] => findUrlSpans(text).map(span => text.slice(span.start, span.end));

describe('terminalHref — the one gate', () => {
  it('passes http and https and nothing else', () => {
    expect(terminalHref('https://example.test/a')).toBe('https://example.test/a');
    expect(terminalHref('http://example.test')).toBe('http://example.test/');
    for (const refused of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'blob:https://example.test/1',
      'ftp://example.test/x',
      'vbscript:x',
      '//example.test/x',
      '/relative/path',
      'https://',
      '',
    ])
      expect(terminalHref(refused)).toBeNull();
  });
});

describe('findUrlSpans', () => {
  it('finds addresses in running text and leaves other schemes alone', () => {
    expect(hrefs('open https://a.test/x and http://b.test now')).toEqual(['https://a.test/x', 'http://b.test/']);
    expect(hrefs('javascript:alert(1) data:text/html,x file:///etc/passwd ftp://a.test')).toEqual([]);
  });

  it('does not end an address with sentence punctuation', () => {
    expect(shown('see https://a.test/x.')).toEqual(['https://a.test/x']);
    expect(shown('see https://a.test/x, then')).toEqual(['https://a.test/x']);
    expect(shown('is it https://a.test/x?')).toEqual(['https://a.test/x']);
    expect(shown('see https://a.test/x;')).toEqual(['https://a.test/x']);
    expect(shown('wow https://a.test/x!!')).toEqual(['https://a.test/x']);
    expect(shown('say "https://a.test/x".')).toEqual(['https://a.test/x']);
    expect(shown('**https://a.test/x**')).toEqual(['https://a.test/x']);
  });

  it('keeps a query string, a fragment and a port', () => {
    expect(shown('go https://a.test:8443/p?q=1&r=2#frag.')).toEqual(['https://a.test:8443/p?q=1&r=2#frag']);
  });

  it('drops an unbalanced closing bracket but keeps a balanced pair', () => {
    expect(shown('(see https://a.test/x)')).toEqual(['https://a.test/x']);
    expect(shown('(see https://a.test/x).')).toEqual(['https://a.test/x']);
    expect(shown('[https://a.test/x]')).toEqual(['https://a.test/x']);
    expect(shown('https://en.wikipedia.test/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.test/wiki/Foo_(bar)']);
    expect(shown('(https://en.wikipedia.test/wiki/Foo_(bar)).')).toEqual(['https://en.wikipedia.test/wiki/Foo_(bar)']);
  });

  it('stops at angle brackets and quotes', () => {
    expect(shown('<https://a.test/x>')).toEqual(['https://a.test/x']);
    expect(shown("'https://a.test/x'")).toEqual(['https://a.test/x']);
  });

  it('does not start inside a word', () => {
    expect(hrefs('nothttps://a.test/x')).toEqual([]);
  });

  it('reports UTF-16 offsets of the address as shown', () => {
    const [span] = findUrlSpans('ab https://a.test/x. cd');
    expect(span).toEqual({ start: 3, end: 19, href: 'https://a.test/x' });
  });
});

describe('splitLinkedRuns', () => {
  it('reassembles to exactly the captured text', () => {
    const text = 'build ok\nsee https://a.test/x, and (http://b.test).\nend';
    const runs = splitLinkedRuns(text);
    expect(runs.map(run => run.text).join('')).toBe(text);
    expect(runs.filter(run => run.kind === 'link').map(run => run.text)).toEqual(['https://a.test/x', 'http://b.test']);
  });

  it('is a single run of text when nothing is a link', () => {
    expect(splitLinkedRuns('plain')).toEqual([{ kind: 'text', at: 0, text: 'plain' }]);
    expect(splitLinkedRuns('')).toEqual([]);
  });

  it('marks where each run starts, which is its key', () => {
    expect(splitLinkedRuns('a https://a.test/x b')).toEqual([
      { kind: 'text', at: 0, text: 'a ' },
      { kind: 'link', at: 2, text: 'https://a.test/x', href: 'https://a.test/x' },
      { kind: 'text', at: 18, text: ' b' },
    ]);
  });
});

describe('linksOnRow', () => {
  it('finds a link on one row, in 1-based inclusive cells', () => {
    const buffer = terminalBuffer(['see https://a.test/x ok'], 30);
    expect(linksOnRow(buffer, 30, 1)).toEqual([
      {
        range: { start: { x: 5, y: 1 }, end: { x: 20, y: 1 } },
        text: 'https://a.test/x',
        href: 'https://a.test/x',
      },
    ]);
  });

  it('does not report a link on a row it does not touch', () => {
    const buffer = terminalBuffer(['no link here', 'https://a.test/x'], 30);
    expect(linksOnRow(buffer, 30, 1)).toEqual([]);
    expect(linksOnRow(buffer, 30, 2)).toHaveLength(1);
    expect(linksOnRow(buffer, 30, 9)).toEqual([]);
  });

  it('follows an address wrapped across several rows as one link, from any of them', () => {
    const url = 'https://example.test/a/rather/long/path?with=query&and=more';
    const buffer = terminalBuffer(wrap(`see ${url} ok`, 20), 20);
    // 4 + 59 + 3 = 66 characters over rows of 20: four rows.
    for (const row of [1, 2, 3, 4]) {
      const links = linksOnRow(buffer, 20, row);
      expect(links).toHaveLength(1);
      expect(links[0]?.href).toBe(url);
      expect(links[0]?.text).toBe(url);
      expect(links[0]?.range).toEqual({ start: { x: 5, y: 1 }, end: { x: 3, y: 4 } });
    }
  });

  it('does not join rows the emulator did not wrap', () => {
    const buffer = terminalBuffer(['https://a.test/very-lo', 'ng-path'], 22);
    const [link] = linksOnRow(buffer, 22, 1);
    expect(link?.text).toBe('https://a.test/very-lo');
    expect(linksOnRow(buffer, 22, 2)).toEqual([]);
  });

  it('drops sentence punctuation that lands on a wrapped row', () => {
    const buffer = terminalBuffer(wrap('go https://a.test/some/path.', 12), 12);
    const [link] = linksOnRow(buffer, 12, 1);
    expect(link?.text).toBe('https://a.test/some/path');
    expect(link?.range.end).toEqual({ x: 3, y: 3 });
  });

  it('finds two links on one row', () => {
    const buffer = terminalBuffer(['https://a.test/1 https://b.test/2'], 40);
    expect(linksOnRow(buffer, 40, 1).map(link => link.href)).toEqual(['https://a.test/1', 'https://b.test/2']);
  });

  it('counts a two-cell character as two columns', () => {
    const buffer = terminalBuffer(['日本 https://a.test/x'], 30);
    const [link] = linksOnRow(buffer, 30, 1);
    // 日 and 本 take columns 1–4, the space is column 5, the address starts at column 6.
    expect(link?.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 21, y: 1 } });
  });

  it('never offers an address that is not http(s)', () => {
    const buffer = terminalBuffer(['javascript:alert(1) file:///etc/passwd data:text/html,x'], 60);
    expect(linksOnRow(buffer, 60, 1)).toEqual([]);
  });

  it('reads no further than the columns it is told the pane has', () => {
    const buffer = terminalBuffer(['https://a.test/long-address'], 40);
    expect(linksOnRow(buffer, 12, 1)[0]?.text).toBe('https://a.te');
  });
});

describe('textInRange', () => {
  it('reads one row between two columns', () => {
    const buffer = terminalBuffer(['say https://a.test/x now'], 30);
    expect(textInRange(buffer, { start: { x: 5, y: 1 }, end: { x: 20, y: 1 } })).toBe('https://a.test/x');
  });

  it('joins the rows of a range without a separator', () => {
    const buffer = terminalBuffer(wrap('see https://example.test/a/b ok', 12), 12);
    expect(textInRange(buffer, { start: { x: 5, y: 1 }, end: { x: 4, y: 3 } })).toBe('https://example.test/a/b');
  });
});

describe('decideHyperlink — OSC 8', () => {
  it('opens a link whose text names the address it goes to', () => {
    expect(decideHyperlink('https://a.test/x', 'https://a.test/x')).toEqual({ kind: 'open', href: 'https://a.test/x' });
    expect(decideHyperlink('https://a.test/', 'https://a.test')).toEqual({ kind: 'open', href: 'https://a.test/' });
    expect(decideHyperlink('https://a.test/', 'a.test')).toEqual({ kind: 'open', href: 'https://a.test/' });
    expect(decideHyperlink('https://a.test/x', '  https://a.test/x ')).toEqual({
      kind: 'open',
      href: 'https://a.test/x',
    });
  });

  it('asks first when the text says something else', () => {
    expect(decideHyperlink('https://evil.test/', 'https://bank.test/')).toEqual({
      kind: 'confirm',
      href: 'https://evil.test/',
      visible: 'https://bank.test/',
    });
    expect(decideHyperlink('https://a.test/x', 'click here')).toEqual({
      kind: 'confirm',
      href: 'https://a.test/x',
      visible: 'click here',
    });
    expect(decideHyperlink('https://a.test/x', '')).toEqual({ kind: 'confirm', href: 'https://a.test/x', visible: '' });
    // Same host, a different page, is still a different address.
    expect(decideHyperlink('https://a.test/x', 'https://a.test/y').kind).toBe('confirm');
  });

  it('refuses anything that is not http(s), whatever the text says', () => {
    for (const target of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ssh://host', 'blob:x'])
      expect(decideHyperlink(target, target)).toEqual({ kind: 'refuse' });
    expect(decideHyperlink('javascript:alert(1)', 'https://a.test/')).toEqual({ kind: 'refuse' });
  });

  it('puts both the text and the address in the question', () => {
    const question = describeHyperlinkMismatch('https://bank.test/', 'https://evil.test/');
    expect(question).toContain('https://bank.test/');
    expect(question).toContain('https://evil.test/');
    expect(describeHyperlinkMismatch('', 'https://evil.test/')).toContain('(nothing)');
    expect(describeHyperlinkMismatch('x'.repeat(500), 'https://evil.test/').length).toBeLessThan(300);
  });
});

const click = (init: Partial<LinkClick> = {}): LinkClick => ({
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  preventDefault: () => {},
  ...init,
});

const sinkFor = (answer: boolean) => {
  const opened: string[] = [];
  const asked: { visible: string; href: string }[] = [];
  return {
    opened,
    asked,
    sink: {
      open: (_click: LinkClick, href: string) => void opened.push(href),
      confirm: (visible: string, href: string) => {
        asked.push({ visible, href });
        return answer;
      },
    },
  };
};

describe('terminalLinkProvider', () => {
  it('hands xterm the links on a row, each opening its own address', () => {
    const buffer = terminalBuffer(['a https://a.test/1 b https://b.test/2'], 40);
    const { opened, sink } = sinkFor(true);
    const provider = terminalLinkProvider({ buffer: () => buffer, columns: () => 40 }, sink);
    let provided: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];
    provider.provideLinks(1, links => {
      provided = links;
    });
    expect(provided?.map(link => link.text)).toEqual(['https://a.test/1', 'https://b.test/2']);
    provided?.[1]?.activate(click(), 'https://b.test/2');
    expect(opened).toEqual(['https://b.test/2']);
  });

  it('answers undefined for a row with no link, and when the screen is not there', () => {
    const { sink } = sinkFor(true);
    const results: unknown[] = [];
    terminalLinkProvider({ buffer: () => terminalBuffer(['plain'], 10), columns: () => 10 }, sink).provideLinks(
      1,
      links => results.push(links),
    );
    terminalLinkProvider({ buffer: () => undefined, columns: () => 0 }, sink).provideLinks(1, links =>
      results.push(links),
    );
    expect(results).toEqual([undefined, undefined]);
  });
});

describe('terminalHyperlinkHandler', () => {
  const rangeOf = (text: string) => ({ start: { x: 1, y: 1 }, end: { x: text.length, y: 1 } });

  it('opens a matching hyperlink without asking', () => {
    const text = 'https://a.test/x';
    const { opened, asked, sink } = sinkFor(false);
    const handler = terminalHyperlinkHandler({ buffer: () => terminalBuffer([text], 30), columns: () => 30 }, sink);
    handler.activate(click(), text, rangeOf(text));
    expect(opened).toEqual([text]);
    expect(asked).toEqual([]);
  });

  it('asks about a hyperlink whose text differs, and opens it only on a yes', () => {
    const text = 'docs';
    const screen = { buffer: () => terminalBuffer([text], 30), columns: () => 30 };

    const declined = sinkFor(false);
    terminalHyperlinkHandler(screen, declined.sink).activate(click(), 'https://evil.test/', rangeOf(text));
    expect(declined.asked).toEqual([{ visible: 'docs', href: 'https://evil.test/' }]);
    expect(declined.opened).toEqual([]);

    const accepted = sinkFor(true);
    terminalHyperlinkHandler(screen, accepted.sink).activate(click(), 'https://evil.test/', rangeOf(text));
    expect(accepted.opened).toEqual(['https://evil.test/']);
  });

  it('neither opens nor asks about a hyperlink that is not http(s)', () => {
    const text = 'click me';
    const { opened, asked, sink } = sinkFor(true);
    const handler = terminalHyperlinkHandler({ buffer: () => terminalBuffer([text], 30), columns: () => 30 }, sink);
    for (const target of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd'])
      handler.activate(click(), target, rangeOf(text));
    expect(opened).toEqual([]);
    expect(asked).toEqual([]);
    expect(handler.allowNonHttpProtocols).toBe(false);
  });
});
