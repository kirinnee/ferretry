/**
 * Clickable references INSIDE code, without rewriting one byte of the code.
 *
 * A message that says "the fix is in `@src/api.ts:120`" means the same thing as
 * one that says it in prose, and a reader on a phone cannot retype a path. So
 * proved sigils are decorated inside inline backtick spans and fenced blocks
 * too — while the code keeps its own styling, its own highlighting, and its
 * exact bytes.
 *
 * BYTE EXACTNESS IS ENFORCED, NOT INTENDED. Every node produced here carries a
 * slice of the original code text and nothing else. The highlighter's markup is
 * only accepted when what was parsed out of it reassembles into that same text
 * byte for byte; otherwise the decoration is abandoned and the caller renders
 * the code exactly as it would have without this module. An unfamiliar
 * highlighter output can therefore lose the decoration, never corrupt a
 * reader's snippet.
 *
 * WHY THE HIGHLIGHT MARKUP IS PARSED BACK. `lib/highlight.ts` answers with
 * highlight.js markup as a STRING, which the renderer would otherwise inject as
 * raw HTML — and raw HTML cannot carry a React click handler, so a reference
 * inside a fence would either be dead or would need a second, different click
 * path. Reading the markup back into nodes keeps ONE renderer and ONE click
 * behaviour for every reference on the screen. The grammar accepted here is
 * deliberately tiny, because highlight.js emits exactly one shape: nested
 * `<span class="…">` elements around escaped text.
 *
 * ESCAPED TOKENS STAY LITERAL for free, and the reason is worth stating: the
 * shared grammar only starts a candidate after a boundary character, and a
 * backslash is not one. So `\:zelda` inside code produces no candidate at all
 * and its backslash keeps rendering — which is what "leave every surrounding
 * byte untouched" requires. Markdown's own escaping never reaches code content.
 */

import type { ProvenReference, ReferenceResolvers, ResolvedReference } from './references.ts';
import { provenReferences } from './references.ts';

/** A run of code text with no reference in it. */
export interface CodeTextNode {
  readonly kind: 'text';
  readonly text: string;
}

/** One highlighter token, which may nest further tokens. */
export interface CodeSpanNode {
  readonly kind: 'span';
  readonly className: string;
  readonly children: readonly CodeNode[];
}

/** A proved reference occupying an exact slice of the code text. */
export interface CodeReferenceNode {
  readonly kind: 'reference';
  readonly text: string;
  readonly reference: ResolvedReference;
}

export type CodeNode = CodeTextNode | CodeSpanNode | CodeReferenceNode;

/** The code text a node list carries, in order. The decoration's own witness. */
const nodeText = (nodes: readonly CodeNode[]): string =>
  nodes.map(node => (node.kind === 'span' ? nodeText(node.children) : node.text)).join('');

const HIGHLIGHT_TOKEN = /<span class="([^"]*)">|<\/span>|[^<]+/gu;
const ENTITY = /&(?:amp|lt|gt|quot|#x27|#39);/gu;
const ENTITY_TEXT: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
};

const decodeEntities = (value: string): string => value.replace(ENTITY, match => ENTITY_TEXT[match] ?? match);

interface OpenSpan {
  readonly className: string;
  readonly children: CodeNode[];
}

/**
 * Read highlighter markup back into nodes, or refuse.
 *
 * Refusal is the safe answer and it is deliberately easy to reach: markup this
 * grammar does not know, an unbalanced span, a gap between tokens, or text that
 * does not reassemble into `source` byte for byte.
 */
function parseHighlightedCode(html: string, source: string): CodeNode[] | null {
  const root: CodeNode[] = [];
  const open: OpenSpan[] = [];
  let cursor = 0;
  for (const match of html.matchAll(HIGHLIGHT_TOKEN)) {
    // A byte the token grammar skipped over is markup this parser does not know.
    if (match.index !== cursor) return null;
    cursor = match.index + match[0].length;
    if (match[1] !== undefined) {
      open.push({ className: match[1], children: [] });
      continue;
    }
    const siblings = open.at(-1)?.children ?? root;
    if (match[0] === '</span>') {
      const closed = open.pop();
      if (closed === undefined) return null;
      (open.at(-1)?.children ?? root).push({ kind: 'span', className: closed.className, children: closed.children });
      continue;
    }
    siblings.push({ kind: 'text', text: decodeEntities(match[0]) });
  }
  if (cursor !== html.length || open.length > 0) return null;
  return nodeText(root) === source ? root : null;
}

function decorateText(text: string, references: readonly ProvenReference[], offset: number): CodeNode[] {
  const pieces: CodeNode[] = [];
  let taken = 0;
  for (const proven of references) {
    const from = Math.max(proven.start, offset) - offset;
    const to = Math.min(proven.end, offset + text.length) - offset;
    if (to <= from) continue;
    if (from > taken) pieces.push({ kind: 'text', text: text.slice(taken, from) });
    pieces.push({ kind: 'reference', text: text.slice(from, to), reference: proven.reference });
    taken = to;
  }
  if (pieces.length === 0) return [{ kind: 'text', text }];
  if (taken < text.length) pieces.push({ kind: 'text', text: text.slice(taken) });
  return pieces;
}

interface DecorationPass {
  readonly nodes: CodeNode[];
  readonly offset: number;
}

function decoratePass(
  nodes: readonly CodeNode[],
  references: readonly ProvenReference[],
  offset: number,
): DecorationPass {
  const output: CodeNode[] = [];
  let at = offset;
  for (const node of nodes) {
    if (node.kind === 'span') {
      const inner = decoratePass(node.children, references, at);
      output.push({ kind: 'span', className: node.className, children: inner.nodes });
      at = inner.offset;
      continue;
    }
    output.push(...decorateText(node.text, references, at));
    at += node.text.length;
  }
  return { nodes: output, offset: at };
}

export interface CodeDecorationRequest {
  /** The code exactly as authored, after the fence's own trailing-newline rule. */
  readonly code: string;
  /** Highlighter markup for that same code, when a language produced any. */
  readonly html?: string | null;
  readonly resolvers: ReferenceResolvers;
  /** A reference whose kind has no opener stays text, exactly as it does in prose. */
  readonly isOpenable: (reference: ResolvedReference) => boolean;
}

/**
 * Decorate one code span or fence, or answer null when there is nothing to
 * decorate — which is the caller's signal to render the code the way it always
 * did. Null is the answer for unproved tokens, for kinds this surface cannot
 * open, and for highlighter markup that could not be read back safely.
 *
 * A token that straddles two highlighter tokens becomes two adjacent references
 * to the same target rather than one: re-nesting the highlighter's own spans to
 * cover it would change the code's styling, and two adjacent links open the
 * same thing. Nothing is merged, moved, or re-escaped — only sliced.
 */
export function decoratedCodeNodes(request: CodeDecorationRequest): CodeNode[] | null {
  const { code, html, resolvers, isOpenable } = request;
  const references = provenReferences(code, resolvers).filter(proven => isOpenable(proven.reference));
  if (references.length === 0) return null;
  const parsed =
    html === undefined || html === null ? [{ kind: 'text' as const, text: code }] : parseHighlightedCode(html, code);
  if (parsed === null) return null;
  return decoratePass(parsed, references, 0).nodes;
}
