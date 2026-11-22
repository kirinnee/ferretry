import { type Document, parse } from 'durian-hypermedia';
import { configureDurian } from './durian.ts';
import { holdOpenContainerFences, linesOf } from './fence-lines.ts';
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
 * ONE inert block of code, by Durian and by CommonMark alike: the opener is replaced by a bare fence at column 0 (an
 * opener CommonMark would not take, one indented four spaces or a tab, must not leave the lines after it to be read
 * as fences of their own) that is longer than any run of backticks or tildes in the tail, and a closer of the same
 * length is added, so nothing in the tail can end it early or open anything. The line numbers do not move.
 * `null` when the text has no such fence.
 */
function closeStreamingFence(text: string, line: number): string | null {
  const lines = [...linesOf(text)];
  if (OPENER.exec(lines[line - 1] ?? '') === null) return null;
  const runs = lines.slice(line).flatMap(tail => tail.match(/`+|~+/gu) ?? []);
  const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  lines[line - 1] = fence;
  return [...lines, fence].join('\n');
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
export function parseMessage(source: string, idPrefix: string): Document {
  configureDurian();
  // A fence in a quote or a list item that its container never closes would draw its partial body (CommonMark ends it
  // where the container ends): it is held as code until its closer arrives.
  const text = holdOpenContainerFences(source);
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
