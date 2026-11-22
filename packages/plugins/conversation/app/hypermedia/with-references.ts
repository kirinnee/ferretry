import { findReferences, type Reference } from '@ferretry/app/references/grammar';
import type { Block, Document } from 'durian-hypermedia';

/**
 * OUR REFERENCE GRAMMAR, LAID OVER DURIAN'S PARSED TREE.
 *
 * Durian never tokenises a reference: we hand `parse` no inline definitions. This pure function then walks every text
 * node of the parsed document and splits it with the SAME scanner the Markdown reader uses (`findReferences`: one grammar,
 * the same boundaries and escapes, so `bob@example.com` stays an address), into Durian's own `ref` node. Every
 * lexical candidate becomes one; whether it is PROVED is the chip's job at paint (`reference-chip.tsx`), exactly as it was
 * the remark transform's. Nothing here is a claim that a target exists.
 *
 * WHY THE READING MIRRORS `remarkReferences`. Markdown drops a backslash escape before any scanner runs, and the old
 * reader recovered it from source offsets. Durian's tree keeps the escaped character as its own one-character text node
 * beside its neighbours (the lexer merges every other adjacent text), so a RUN of adjacent text nodes is one remark text
 * node, and each one-character punctuation node in it is an escape. The run is scanned as one string and a token whose
 * sigil was escaped is left as prose, which is what the old reader did.
 *
 * ONE DIFFERENCE, AND IT FAILS CLOSED. The old reader refused to link past a character reference (`&amp;`) because it
 * could no longer align the source. Durian has already decoded it, so the first `& < > " '` of a node is where we stop
 * linking, but only when the message holds a character reference at all. A reference after one stays prose.
 */

/** The inline name our chip is registered under (`HypermediaProse` passes it as the document's one `inlines` entry). */
export const REFERENCE_INLINE = 'fy-ref';

/** What a reference node carries: the lexical reading, never a proof. */
export interface ReferenceData {
  readonly reference: Reference;
}

interface Inline {
  readonly t: string;
  readonly v?: string;
  readonly c?: readonly Inline[];
  readonly [field: string]: unknown;
}
interface MdBlock {
  readonly t: string;
  readonly c?: readonly Inline[] | readonly MdBlock[];
  readonly items?: readonly { readonly c: readonly MdBlock[] }[];
  readonly head?: readonly (readonly Inline[])[];
  readonly rows?: readonly (readonly (readonly Inline[])[])[];
}

const CHARACTER_REFERENCE = /&(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{1,31});/iu;
const DECODED_CHARACTER = /[&<>"']/u;
const ESCAPABLE = /^[!-/:-@[-`{-~]$/u;

const textOf = (node: Inline): string => node.v ?? '';

function splitRun(run: readonly Inline[], ambiguous: boolean): readonly Inline[] {
  const value = run.map(textOf).join('');
  const escaped = new Set<number>();
  if (run.length > 1) {
    let at = 0;
    for (const node of run) {
      const text = textOf(node);
      if (text.length === 1 && ESCAPABLE.test(text)) escaped.add(at);
      at += text.length;
    }
  }
  const limit = ambiguous ? value.search(DECODED_CHARACTER) : -1;
  const found = findReferences(value).filter(
    match => !escaped.has(match.start) && (limit === -1 || match.start < limit),
  );
  if (found.length === 0) return run;
  const out: Inline[] = [];
  let cursor = 0;
  for (const match of found) {
    if (match.start > cursor) out.push({ t: 'text', v: value.slice(cursor, match.start) });
    const data: ReferenceData = { reference: match.reference };
    out.push({ t: 'ref', name: REFERENCE_INLINE, text: match.raw, data });
    cursor = match.end;
  }
  if (cursor < value.length) out.push({ t: 'text', v: value.slice(cursor) });
  return out;
}

function inlines(nodes: readonly Inline[], ambiguous: boolean): readonly Inline[] {
  const out: Inline[] = [];
  let run: Inline[] = [];
  const flush = (): void => {
    if (run.length > 0) out.push(...splitRun(run, ambiguous));
    run = [];
  };
  for (const node of nodes) {
    if (node.t === 'text') {
      run.push(node);
      continue;
    }
    flush();
    // Emphasis holds prose; a link, code, a key chord and the rest are left exactly as parsed.
    out.push(
      (node.t === 'strong' || node.t === 'em' || node.t === 'del') && node.c !== undefined
        ? { ...node, c: inlines(node.c, ambiguous) }
        : node,
    );
  }
  flush();
  return out;
}

const cells = (row: readonly (readonly Inline[])[], ambiguous: boolean) => row.map(cell => inlines(cell, ambiguous));

function mdBlocks(blocks: readonly MdBlock[], ambiguous: boolean): readonly MdBlock[] {
  return blocks.map((block): MdBlock => {
    switch (block.t) {
      case 'p':
      case 'text':
      case 'h':
        return { ...block, c: inlines((block.c ?? []) as readonly Inline[], ambiguous) };
      case 'quote':
      case 'callout':
        return { ...block, c: mdBlocks((block.c ?? []) as readonly MdBlock[], ambiguous) };
      case 'list':
        return { ...block, items: (block.items ?? []).map(item => ({ ...item, c: mdBlocks(item.c, ambiguous) })) };
      case 'table':
        return {
          ...block,
          head: cells(block.head ?? [], ambiguous),
          rows: (block.rows ?? []).map(row => cells(row, ambiguous)),
        };
      default:
        return block;
    }
  });
}

interface Container {
  readonly type: string;
  readonly md?: readonly MdBlock[];
  readonly body?: readonly Block[];
  readonly items?: readonly { readonly body: readonly Block[] }[];
}

function blocksOf(blocks: readonly Block[], ambiguous: boolean): readonly Block[] {
  return blocks.map((block): Block => {
    const part = block as unknown as Container;
    if (part.type === 'markdown' && part.md !== undefined)
      return { ...block, md: mdBlocks(part.md, ambiguous) } as unknown as Block;
    if (part.type === 'human' && part.body !== undefined)
      return { ...block, body: blocksOf(part.body, ambiguous) } as unknown as Block;
    if ((part.type === 'tabs' || part.type === 'accordion') && part.items !== undefined)
      return {
        ...block,
        items: part.items.map(item => ({ ...item, body: blocksOf(item.body, ambiguous) })),
      } as unknown as Block;
    return block;
  });
}

/**
 * The document with every lexical reference in its prose made a `ref` node. Pure: the input is not changed. The result
 * is a new object, which is fine for drawing; the checker and the LLM view are read from the document `parse` returned.
 */
export function withReferences(doc: Document): Document {
  return { ...doc, blocks: blocksOf(doc.blocks, CHARACTER_REFERENCE.test(doc.source)) };
}
