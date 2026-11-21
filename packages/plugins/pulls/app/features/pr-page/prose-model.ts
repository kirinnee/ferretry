/**
 * GitHub text, parsed to a small tree (pure). The text was written by strangers, so this is the whole of what it can
 * become: paragraphs, lists, quotes, code, a rule, and inline code, bold, italic, links and "an image was here".
 *
 *  - NO HTML. A tag is plain text (the drawing layer escapes it). `<!-- … -->` comments, which PR templates are full of
 *    and GitHub hides, are removed.
 *  - NO IMAGE IS EVER REQUESTED. `![alt](url)` becomes an `image` node holding its alt text only: the address is dropped.
 *  - A LINK is kept only for `https:` with no credentials; anything else (`http:`, `javascript:`, `data:`, `file:`,
 *    `fy:`) is its text.
 *  - FERRETRY'S REFERENCES (`&F1`, `:agent`, `%terminal:x`, `^A3`, `@file`) are not read at all: they stay text.
 *  - A fence's language (`fy-render`, `html`) is never read either: every fence is code, shown as text.
 *
 * Bounded: a quote nests at most three deep, a line is read once, an inline span is read once (no nesting beyond bold
 * over italic), so no input makes this slow or deep.
 */

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'bold'; readonly children: readonly Inline[] }
  | { readonly kind: 'italic'; readonly children: readonly Inline[] }
  | { readonly kind: 'strike'; readonly children: readonly Inline[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly Inline[] }
  | { readonly kind: 'image'; readonly alt: string };

export type Block =
  | { readonly kind: 'paragraph'; readonly inline: readonly Inline[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | { readonly kind: 'quote'; readonly blocks: readonly Block[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'rule' };

const MAX_QUOTE_DEPTH = 3;
const MAX_INPUT = 70_000;

/** `https` with no credentials, else undefined. The one gate a link passes. */
export function safeHref(value: string): string | undefined {
  const text = trimSpace(value);
  if (text.length === 0 || text.length > 2000 || /[\s\p{Cc}]/u.test(text) || !URL.canParse(text)) return undefined;
  const url = new URL(text);
  if (url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  return url.href;
}

/** Trims whitespace but never U+FEFF: `\s` and `trim()` count the byte-order mark as blank, which would let it vanish unmarked. */
export const trimSpace = (text: string): string => text.replace(/^[^\S\uFEFF]+|[^\S\uFEFF]+$/gu, '');

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const HEADING = /^ {0,3}#{1,6}[^\S\uFEFF]+(.*?)[^\S\uFEFF]*#*[^\S\uFEFF]*$/u;
const RULE = /^ {0,3}([-*_])(?:[^\S\uFEFF]*\1){2,}[^\S\uFEFF]*$/u;
const BULLET = /^ {0,3}[-*+][^\S\uFEFF]+(.*)$/u;
const NUMBERED = /^ {0,3}\d{1,9}[.)][^\S\uFEFF]+(.*)$/u;
const QUOTE = /^ {0,3}>[^\S\uFEFF]?(.*)$/u;
const TASK = /^\[( |x|X)\][^\S\uFEFF]+/u;

/**
 * `<!-- … -->` removed in one linear pass (indexOf, never a lazy regex: an unclosed comment repeated would re-scan to
 * the end from every opener). An unclosed comment hides the rest of the text, as it does on GitHub.
 */
function stripComments(text: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = text.indexOf('<!--', at);
    if (open < 0) return out + text.slice(at);
    out += text.slice(at, open);
    const close = text.indexOf('-->', open + 4);
    if (close < 0) return out;
    at = close + 3;
  }
}

/** The text as blocks. */
export function parseProse(text: string): readonly Block[] {
  const clean = stripComments(text.slice(0, MAX_INPUT));
  return blocks(clean.split(/\r\n|\r|\n/u), 0);
}

function blocks(lines: readonly string[], depth: number): readonly Block[] {
  const out: Block[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) out.push({ kind: 'paragraph', inline: inline(paragraph.join('\n')) });
    paragraph = [];
  };
  for (let at = 0; at < lines.length; ) {
    const line = lines[at] ?? '';
    const fence = FENCE.exec(line);
    if (fence?.[1] !== undefined) {
      flush();
      const marker = fence[1];
      const body: string[] = [];
      at += 1;
      while (
        at < lines.length &&
        !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${String(marker.length)},}[^\\S\\uFEFF]*$`, 'u').test(
          lines[at] ?? '',
        )
      ) {
        body.push(lines[at] ?? '');
        at += 1;
      }
      at += 1; // the closing fence (or the end of the text: an unclosed fence runs to it)
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (trimSpace(line) === '') {
      flush();
      at += 1;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push({ kind: 'rule' });
      at += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading?.[1] !== undefined) {
      // A heading is bold body text, never an h1–h6: pasted prose must not out-shout the page's own structure.
      flush();
      out.push({ kind: 'paragraph', inline: [{ kind: 'bold', children: inline(heading[1]) }] });
      at += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      while (at < lines.length && QUOTE.test(lines[at] ?? '')) {
        inner.push(QUOTE.exec(lines[at] ?? '')?.[1] ?? '');
        at += 1;
      }
      // Past the depth bound a quote is plain text, so nesting cannot be used to make the page deep.
      out.push(
        depth >= MAX_QUOTE_DEPTH
          ? { kind: 'paragraph', inline: inline(inner.join('\n')) }
          : { kind: 'quote', blocks: blocks(inner, depth + 1) },
      );
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      flush();
      const ordered = !BULLET.test(line);
      const items: Inline[][] = [];
      while (at < lines.length) {
        const current = lines[at] ?? '';
        const match = (ordered ? NUMBERED : BULLET).exec(current);
        if (match?.[1] === undefined) {
          // An indented continuation (or a nested list line) belongs to the item above, as text.
          if (/^[^\S\uFEFF]{2,}\S/u.test(current) && items.length > 0) {
            const last = items[items.length - 1] ?? [];
            last.push({ kind: 'text', text: ' ' });
            for (const part of inline(trimSpace(current))) last.push(part);
            at += 1;
            continue;
          }
          break;
        }
        const task = TASK.exec(match[1]);
        const item = task === null ? match[1] : match[1].slice(task[0].length);
        const mark: Inline[] = task === null ? [] : [{ kind: 'text', text: task[1] === ' ' ? '☐ ' : '☑ ' }];
        items.push([...mark, ...inline(item)]);
        at += 1;
      }
      out.push({ kind: 'list', ordered, items });
      continue;
    }
    if (/^[^\S\uFEFF]*\|/u.test(line)) {
      // A table is shown as the text it was written as (columns line up in a monospaced block).
      flush();
      const rows: string[] = [];
      while (at < lines.length && /^[^\S\uFEFF]*\|/u.test(lines[at] ?? '')) {
        rows.push(lines[at] ?? '');
        at += 1;
      }
      out.push({ kind: 'code', text: rows.join('\n') });
      continue;
    }
    paragraph.push(line);
    at += 1;
  }
  flush();
  return out;
}

const TOKEN =
  /`([^`\n]+)`|!\[([^\]\n]{0,500})\]\(([^)\n]{0,2000})\)|\[([^\]\n]{1,500})\]\(([^)\s\n]{1,2000})(?:\s+"[^"\n]*")?\)|<(https?:\/\/[^>\s]{1,2000})>|(?<![="'(\w/])(https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"])|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\s][^*\n]*)\*|(?<![\w])_([^_\s][^_\n]*)_(?![\w])/gu;

/** Inline text. `nest` is how deep bold/italic/link text may itself be read (one level). */
export function inline(text: string, nest = 1): readonly Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (value: string): void => {
    if (value !== '') out.push({ kind: 'text', text: value });
  };
  const inner = (value: string): readonly Inline[] =>
    nest > 0 ? inline(value, nest - 1) : [{ kind: 'text', text: value }];
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    push(text.slice(last, start));
    last = start + match[0].length;
    const [, code, imageAlt, , linkText, linkHref, angle, bare, bold, bold2, strike, italic, italic2] = match;
    if (code !== undefined) out.push({ kind: 'code', text: code });
    else if (imageAlt !== undefined) out.push({ kind: 'image', alt: imageAlt.slice(0, 300) });
    else if (linkText !== undefined && linkHref !== undefined) {
      const href = safeHref(linkHref);
      if (href === undefined) push(linkText);
      else out.push({ kind: 'link', href, children: [{ kind: 'text', text: linkText }] });
    } else if (angle !== undefined || bare !== undefined) {
      const raw = angle ?? bare ?? '';
      const href = safeHref(raw);
      if (href === undefined) push(raw);
      else out.push({ kind: 'link', href, children: [{ kind: 'text', text: raw }] });
    } else if (bold !== undefined || bold2 !== undefined)
      out.push({ kind: 'bold', children: inner(bold ?? bold2 ?? '') });
    else if (strike !== undefined) out.push({ kind: 'strike', children: inner(strike) });
    else if (italic !== undefined || italic2 !== undefined)
      out.push({ kind: 'italic', children: inner(italic ?? italic2 ?? '') });
  }
  push(text.slice(last));
  return out;
}
