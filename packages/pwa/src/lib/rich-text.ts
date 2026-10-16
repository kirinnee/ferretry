/**
 * THE RICH TEXT EDITOR'S TWO TRANSLATIONS — markdown into what the editor shows, and what the editor
 * holds back into markdown.
 *
 * The composer always sends markdown, whichever editor style is on. The rich text style edits a
 * rendered document instead of the characters, so the round trip has to be lossless for everything
 * the editor can make: headings (#, ##, ###), bullet, numbered and checklist items, quotes, code
 * blocks, dividers, and **bold**, *italic*, `code` and ~~strike~~ inside a line. Anything else is
 * shown and kept as the plain text it is.
 *
 * `richBlocks` and `inlineSegments` describe the document as data; the editor builds DOM nodes from
 * them with `createElement` and text nodes, so no string of the reader's is ever parsed as markup (and
 * no Trusted Types policy is needed). `richNodeToMarkdown` reads a structural slice of the DOM, so it
 * runs against any document, the test DOM included.
 */

/** Inline marks, in the order they are tried: code first, so its contents are never re-read. */
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*/gu;

/** One run of a line: plain text, or text under one mark. */
export interface RichSegment {
  readonly mark?: 'strong' | 'em' | 'code' | 's';
  readonly text: string;
}

/** A line's inline marks as segments. The editor builds nodes from these; nothing is parsed as markup. */
export const inlineSegments = (text: string): readonly RichSegment[] => {
  const segments: RichSegment[] = [];
  let last = 0;
  const plain = (to: number): void => {
    if (to > last) segments.push({ text: text.slice(last, to) });
  };
  for (const match of text.matchAll(INLINE)) {
    plain(match.index as number);
    const [, code, bold, strike, italic] = match;
    if (code !== undefined) segments.push({ mark: 'code', text: code });
    else if (bold !== undefined) segments.push({ mark: 'strong', text: bold });
    else if (strike !== undefined) segments.push({ mark: 's', text: strike });
    else segments.push({ mark: 'em', text: italic as string });
    last = (match.index as number) + match[0].length;
  }
  plain(text.length);
  return segments;
};

/** One block of the rendered document. */
export type RichBlock =
  | { readonly kind: 'h'; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: 'li'; readonly list: 'ul' | 'ol' | 'check'; readonly text: string; readonly done: boolean }
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'code'; readonly lines: readonly string[] }
  | { readonly kind: 'hr' }
  | { readonly kind: 'p'; readonly text: string };

const blockOf = (line: string): RichBlock => {
  const heading = /^(#{1,3})\s(.*)$/u.exec(line);
  if (heading !== null)
    return { kind: 'h', level: (heading[1] as string).length as 1 | 2 | 3, text: heading[2] as string };
  const check = /^(?:[-*]\s)?\[([ xX])\]\s(.*)$/u.exec(line);
  if (check !== null) return { kind: 'li', list: 'check', text: check[2] as string, done: check[1] !== ' ' };
  const bullet = /^[-*]\s(.*)$/u.exec(line);
  if (bullet !== null) return { kind: 'li', list: 'ul', text: bullet[1] as string, done: false };
  const numbered = /^\d+\.\s(.*)$/u.exec(line);
  if (numbered !== null) return { kind: 'li', list: 'ol', text: numbered[1] as string, done: false };
  const quote = /^>\s?(.*)$/u.exec(line);
  if (quote !== null) return { kind: 'quote', text: quote[1] as string };
  if (/^-{3,}$/u.test(line)) return { kind: 'hr' };
  return { kind: 'p', text: line };
};

/** What the rich editor shows for a markdown draft, block by block. */
export const richBlocks = (markdown: string): readonly RichBlock[] => {
  const blocks: RichBlock[] = [];
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (/^```/u.test(line)) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/u.test(lines[index] as string)) {
        code.push(lines[index] as string);
        index += 1;
      }
      blocks.push({ kind: 'code', lines: code });
      continue;
    }
    blocks.push(blockOf(line));
  }
  return blocks;
};

/** The slice of a DOM node the serializer reads, so it runs against any document. */
export interface RichNodeLike {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<RichNodeLike>;
  getAttribute?(name: string): string | null;
}

const TEXT_NODE = 3;

/** One element's inline content back as markdown marks. */
const inlineToMarkdown = (node: RichNodeLike): string => {
  let out = '';
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      out += (child.textContent ?? '').replaceAll('\u00a0', ' ');
      continue;
    }
    const inner = inlineToMarkdown(child);
    switch (child.nodeName) {
      case 'STRONG':
      case 'B':
        out += inner === '' ? '' : `**${inner}**`;
        break;
      case 'EM':
      case 'I':
        out += inner === '' ? '' : `*${inner}*`;
        break;
      case 'CODE':
        out += inner === '' ? '' : `\`${inner}\``;
        break;
      case 'S':
      case 'STRIKE':
      case 'DEL':
        out += inner === '' ? '' : `~~${inner}~~`;
        break;
      case 'BR':
        break;
      default:
        out += inner;
    }
  }
  return out;
};

/** The editor's document back as the markdown the composer sends. */
export const richNodeToMarkdown = (root: RichNodeLike): string => {
  const lines: string[] = [];
  const children = Array.from(root.childNodes);
  for (const child of children) {
    if (child.nodeType === TEXT_NODE) {
      if ((child.textContent ?? '') !== '') lines.push(child.textContent as string);
      continue;
    }
    switch (child.nodeName) {
      case 'H1':
      case 'H2':
      case 'H3':
        lines.push(`${'#'.repeat(Number(child.nodeName[1]))} ${inlineToMarkdown(child)}`);
        break;
      case 'UL':
      case 'OL': {
        const flag = child.getAttribute?.('data-checklist');
        const checklist = flag !== null && flag !== undefined;
        Array.from(child.childNodes).forEach((item, index) => {
          const text = inlineToMarkdown(item);
          if (checklist) lines.push(`[${item.getAttribute?.('data-checked') === 'true' ? 'x' : ' '}] ${text}`);
          else lines.push(child.nodeName === 'OL' ? `${index + 1}. ${text}` : `- ${text}`);
        });
        break;
      }
      case 'BLOCKQUOTE':
        lines.push(`> ${inlineToMarkdown(child)}`);
        break;
      case 'PRE':
        lines.push('```', ...(child.textContent ?? '').split('\n'), '```');
        break;
      case 'HR':
        lines.push('---');
        break;
      case 'BR':
        lines.push('');
        break;
      default:
        lines.push(inlineToMarkdown(child));
    }
  }
  return lines.join('\n').replace(/\n+$/u, '');
};

/**
 * The block a line becomes when the reader types its markdown prefix at the start of an empty-ish
 * paragraph — Notion's input rules: `# ` a heading, `- ` a list, `> ` a quote. Answers `null` for
 * anything else.
 */
export const blockShortcut = (
  text: string,
): { readonly tag: 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'blockquote'; readonly rest: string } | null => {
  const match = /^(#{1,3}|[-*]|1\.|>)\s(.*)$/u.exec(text);
  if (match === null) return null;
  const prefix = match[1] as string;
  const rest = match[2] as string;
  if (prefix.startsWith('#')) return { tag: `h${prefix.length}` as 'h1' | 'h2' | 'h3', rest };
  if (prefix === '>') return { tag: 'blockquote', rest };
  return { tag: prefix === '1.' ? 'ol' : 'ul', rest };
};
