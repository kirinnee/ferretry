import { type Document, parse } from 'durian-hypermedia';
import { configureDurian } from './durian.ts';
import { fyRenderParseBlock } from './fy-render-host.tsx';
import { LITERAL_CODE_INLINES, mayHoldLiteralCode } from './literal-code.tsx';
import { MESSAGE_LIMITS } from './limits.ts';
import { hypermediaUrlPolicy } from './url-policy.ts';
import { withReferences } from './with-references.ts';

/** Durian's words for a fence that has no closer yet (`src/core/dh-lib.ts`): what a message still streaming in says. */
const UNCLOSED_FENCE = 'a code fence is never closed';
const OPENER = /^(\s*)(`{3,}|~{3,})/u;

/**
 * A fence still arriving: Durian refuses the WHOLE page for it ("a code fence is never closed"), so the part already
 * drawn above it would be torn down and replaced by error chrome until the closer comes. The tail is instead read as
 * what it is so far, plain code: the opener loses its info word (so it is no part, and no `fy-render` block) and a closer
 * is added. The line numbers do not move. `null` when the text has no such fence.
 */
function closeStreamingFence(text: string, line: number): string | null {
  const lines = text.split(/\r\n|\r|\n/u);
  const opener = OPENER.exec(lines[line - 1] ?? '');
  if (opener === null) return null;
  lines[line - 1] = `${opener[1]}${opener[2]}`;
  return [...lines, opener[2]].join('\n');
}

const read = (text: string, idPrefix: string): Document =>
  parse(text, {
    blocks: [fyRenderParseBlock(text)],
    frontMatter: false,
    idPrefix,
    limits: MESSAGE_LIMITS,
    urlPolicy: hypermediaUrlPolicy,
    // Offered only to a message that can hold such a span: every other message is read by Durian's own lexer.
    inlines: mayHoldLiteralCode(text) ? LITERAL_CODE_INLINES : undefined,
  });

/**
 * ONE MESSAGE, PARSED: Durian reads it with no front matter (a message that starts with `---` is Markdown the reader
 * sees), our URL policy and the size cap, and our reference grammar is then laid over its prose. `idPrefix` is this
 * message's own, so its heading ids never collide with another message's. A pure function of its input: the same
 * text and prefix always give the same document.
 */
export function parseMessage(text: string, idPrefix: string): Document {
  configureDurian();
  const first = read(text, idPrefix);
  const unclosed = first.problems.find(problem => problem.message === UNCLOSED_FENCE);
  const closed = unclosed === undefined ? null : closeStreamingFence(text, unclosed.line);
  if (closed === null) return withReferences(first);
  const second = read(closed, idPrefix);
  // Another failure in the closed text (an unclosed `:::` container, say) is Durian's own to report, as it always was.
  const unreadable =
    second.blocks[0]?.type === 'error' && second.blocks[0].message.startsWith('the page could not be read');
  return withReferences(unreadable ? first : second);
}
